import { spawn } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { format } from 'node:util'
import { WebSocket, WebSocketServer } from 'ws'
import { listCostumes, serveModel, serveThumb } from './assets.ts'
import { createAuth } from './auth.ts'
import { searchFiles } from './files.ts'
import { buildPersona } from './persona.ts'
import type { ClientMsg, PermissionModeName, ServerMsg, SessionEvent, Settings } from './protocol.ts'
import { research } from './research.ts'
import { deleteSave, errorText, getSave, isSaveId, listSaves, loadHistory, remember, renameSave, saveMeta, shortPath, unhide } from './saves.ts'
import type { SessionApi, SessionFactory } from './session-api.ts'
import { createSession } from './session.ts'
import { DATA_DIR, loadSettings, saveSettings } from './settings.ts'

// The Tauri app starts this process with a free port and a token, and closes stdin when it quits.
const PORT = Number(process.env.WC_PORT ?? 47900)
const TOKEN = process.env.WC_TOKEN ?? ''
const MOCK = process.env.WC_MOCK === '1'
const claudePath = process.env.WC_CLAUDE || undefined
const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

/** How long a closed session gets to emit `ended` (its CLI exiting) before the next one starts anyway. */
const CLOSE_WAIT_MS = 3_000
/** With no app connected for this long, the running session is closed: nobody can see or answer it. */
const ORPHAN_MS = 60_000

// ---------------------------------------------------------------- logging

const LOG_DIR = join(DATA_DIR, 'logs')
const LOG_FILE = join(LOG_DIR, 'link.log')
const LOG_MAX_BYTES = 1024 * 1024
const LOG_KEEP = 3

let logBytes = 0
let inConsole = false
try {
  mkdirSync(LOG_DIR, { recursive: true })
  logBytes = existsSync(LOG_FILE) ? statSync(LOG_FILE).size : 0
} catch {
  // Logging to the file is best effort; the console still works.
}

function rotate() {
  rmSync(`${LOG_FILE}.${LOG_KEEP}`, { force: true })
  for (let i = LOG_KEEP - 1; i >= 1; i--) if (existsSync(`${LOG_FILE}.${i}`)) renameSync(`${LOG_FILE}.${i}`, `${LOG_FILE}.${i + 1}`)
  renameSync(LOG_FILE, `${LOG_FILE}.1`)
  logBytes = 0
}

/** Mirrors console output into DATA_DIR/logs/link.log (rotated at 1 MB, 3 old files kept). Synchronous, so a crash still logs. */
function tee(level: 'log' | 'warn' | 'error') {
  const original = console[level].bind(console)
  console[level] = (...args: unknown[]) => {
    // console.warn/error write through process.stderr, which is mirrored below; the line is logged once, here.
    inConsole = true
    try {
      original(...args)
    } finally {
      inConsole = false
    }
    toFile(`${new Date().toISOString()} ${level === 'log' ? 'info ' : level.padEnd(5)} ${format(...args)}\n`)
  }
}

function toFile(line: string) {
  const bytes = Buffer.byteLength(line)
  if (logBytes > 0 && logBytes + bytes > LOG_MAX_BYTES) {
    try {
      rotate()
    } catch {
      // A log viewer holds the file open: keep appending to it rather than retrying the rotation on every line.
      logBytes = 0
    }
  }
  try {
    appendFileSync(LOG_FILE, line)
    logBytes += bytes
  } catch {
    // Disk full or the file is locked: keep running without the file log.
  }
}

tee('log')
tee('warn')
tee('error')

// The CLI's own stderr is written straight to process.stderr by session.ts (as `[cli] …` lines); mirror it too.
const stderrWrite = process.stderr.write.bind(process.stderr) as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean
process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
  if (!inConsole) {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    toFile(`${new Date().toISOString()} raw   ${text}${text.endsWith('\n') ? '' : '\n'}`)
  }
  return stderrWrite(chunk, ...rest)
}) as typeof process.stderr.write

process.on('unhandledRejection', (e) => console.error('[link] unhandled rejection:', e))
process.on('uncaughtException', (e) => console.error('[link] uncaught exception:', e))

const factory: SessionFactory = MOCK ? (await import('./mock.ts')).createMockSession : createSession

// ---------------------------------------------------------------- HTTP

function text(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8') {
  if (res.headersSent) return void res.end()
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' })
  res.end(body)
}

async function route(req: IncomingMessage, res: ServerResponse) {
  const { pathname } = new URL(req.url ?? '/', 'http://link')
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': '*' })
    return void res.end()
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'method not allowed')
  if (pathname === '/health') return text(res, 200, JSON.stringify({ ok: true, version: VERSION, mock: MOCK }), 'application/json')
  // Model files and thumbnails are served without the token: the page loads them by URL.
  if (pathname.startsWith('/models/')) return serveModel(pathname, res)
  if (pathname.startsWith('/thumbs/')) return serveThumb(pathname, res)
  text(res, 404, 'not found')
}

const http = createServer((req, res) => {
  route(req, res).catch((e) => {
    console.error(`[http] ${req.url}:`, e)
    text(res, 500, 'internal error')
  })
})
// Port taken or similar: nothing can work, so exit and let the shell restart the sidecar.
http.on('error', (e) => {
  console.error('[link] server error:', e)
  process.exit(1)
})

function tokenOk(req: IncomingMessage) {
  const given = Buffer.from(new URL(req.url ?? '/', 'http://link').searchParams.get('token') ?? '')
  const want = Buffer.from(TOKEN)
  return given.length === want.length && timingSafeEqual(given, want)
}

const wss = new WebSocketServer({ server: http, verifyClient: ({ req }: { req: IncomingMessage }) => tokenOk(req) })
if (!TOKEN) console.warn('[link] WC_TOKEN is not set: any local client can connect')

function sendTo(ws: WebSocket, m: ServerMsg) {
  if (ws.readyState !== WebSocket.OPEN) return
  try {
    ws.send(JSON.stringify(m))
  } catch (e) {
    console.warn('[ws] send failed:', e)
  }
}

function broadcast(m: ServerMsg, except?: WebSocket) {
  for (const ws of wss.clients) if (ws !== except) sendTo(ws, m)
}

// ---------------------------------------------------------------- services

const auth = createAuth(claudePath, (a) => broadcast({ t: 'auth', auth: a }))
void auth.refresh()

/** Settings writes run one at a time and re-read the file, so a lastDir or preset write never undoes a settings_set. */
let settingsWrites: Promise<unknown> = Promise.resolve()

function updateSettings(change: (s: Settings) => Settings | void): Promise<Settings> {
  const run = settingsWrites.then(async () => {
    const s = await loadSettings()
    const next = change(s) ?? s
    await saveSettings(next)
    return next
  })
  settingsWrites = run.catch(() => {})
  return run
}

// ---------------------------------------------------------------- sessions

type Live = {
  epoch: number
  cwd: string
  session?: SessionApi
  /** Set by an intentional close: only its `ended` still goes out. */
  closing: boolean
  ended: Promise<void>
  emit(e: SessionEvent): void
}

let current: Live | undefined
/** Bumped by every start and end, so a start that was overtaken while it awaited drops out instead of spawning a CLI. */
let startGen = 0

function makeLive(epoch: number, cwd: string): Live {
  let markEnded = () => {}
  const ended = new Promise<void>((r) => (markEnded = r))
  const emit = (e: SessionEvent) => {
    if (e.t === 'ended') markEnded()
    // A replaced session is cut off here, so its late events never reach the next chat.
    if (current !== live && !(live.closing && e.t === 'ended')) return
    if (e.t === 'ended' && current === live) {
      current = undefined
      // A crash only closes the inbox; if the CLI is still alive (a failed handshake), close() ends it. It emits no second `ended`.
      if (e.reason === 'crashed') queueMicrotask(() => live.session?.close())
    }
    const id = e.t === 'ready' || e.t === 'session_id' ? e.sessionId : undefined
    if (id) remember(id, cwd).catch((err) => console.error(`[saves] remember ${id}:`, err))
    broadcast({ ...e, epoch } as ServerMsg)
  }
  const live: Live = { epoch, cwd, closing: false, ended, emit }
  return live
}

async function closeCurrent() {
  const live = current
  if (!live) return
  current = undefined
  live.closing = true
  try {
    live.session?.close()
  } catch (e) {
    console.error('[session] close failed:', e)
  }
  const timer = new Promise<void>((r) => setTimeout(r, CLOSE_WAIT_MS))
  await Promise.race([live.ended, timer])
}

function sessionFailed(epoch: number, message: string) {
  broadcast({ t: 'error', message, kind: 'internal', epoch })
  broadcast({ t: 'ended', reason: 'crashed', epoch })
}

function isDir(path: string) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Remembers the folder for the next New Game. Best effort: a failed write must not stop the session. */
async function rememberDir(cwd: string): Promise<Settings> {
  try {
    let changed = false
    const settings = await updateSettings((s) => {
      changed = s.lastDir !== cwd
      s.lastDir = cwd
    })
    if (changed) broadcast({ t: 'settings', settings })
    return settings
  } catch (e) {
    console.warn(`[settings] could not remember ${cwd}:`, e)
    return loadSettings()
  }
}

async function start(m: Extract<ClientMsg, { t: 'start' }>) {
  const gen = ++startGen
  await closeCurrent()
  if (gen !== startGen) return
  const cwd = resolve(m.cwd)
  if (!isDir(cwd)) return sessionFailed(m.epoch, `The folder ${cwd} doesn't exist.`)
  let live: Live | undefined
  // Whatever fails from here, the chat waiting on this epoch gets its error and `ended` instead of hanging (R24).
  try {
    if (m.resume) await unhide(m.resume)
    const [history, save] = m.resume ? await Promise.all([loadHistory(m.resume, cwd), getSave(m.resume, cwd)]) : [[], undefined]
    if (gen !== startGen) return
    // Read inside the settings queue, so a settings_set sent just before (the profile, saved before New Game) is in the persona.
    const settings = await rememberDir(cwd)
    if (gen !== startGen) return
    // From here to `current = live` nothing awaits, so no other start can slip in between.
    live = makeLive(m.epoch, cwd)
    current = live
    live.session = factory({ epoch: m.epoch, cwd, resume: m.resume, settings, claudePath, emit: live.emit })
    console.log(`[session] epoch ${m.epoch} ${m.resume ? `resume ${m.resume}` : 'new'} in ${cwd}${MOCK ? ' (mock)' : ''}`)
    broadcast({ t: 'started', cwd, cwdShort: shortPath(cwd), resumed: !!m.resume, history, save, epoch: m.epoch })
    await live.session.start()
  } catch (e) {
    console.error('[session] could not start the session:', e)
    if (live) {
      // Already ended (its own error went out) or overtaken by a newer start: nothing is waiting on this epoch.
      if (current !== live) return
      current = undefined
      live.session?.close()
    }
    sessionFailed(m.epoch, `Claude Code could not start: ${errorText(e)}`)
  }
}

// ---------------------------------------------------------------- research

let researchCtl: AbortController | undefined

async function runResearch(m: Extract<ClientMsg, { t: 'research' }>) {
  researchCtl?.abort()
  const ctl = new AbortController()
  researchCtl = ctl
  try {
    const preset = await research({
      name: m.name,
      series: m.series,
      notes: m.notes,
      signal: ctl.signal,
      claudePath,
      onProgress: (text) => researchCtl === ctl && broadcast({ t: 'research_progress', text }),
    })
    if (ctl.signal.aborted) throw new Error('aborted')
    const settings = await updateSettings((s) => {
      s.presets = [...s.presets.filter((p) => p.id !== preset.id), preset]
    })
    broadcast({ t: 'settings', settings })
    broadcast({ t: 'research_done', preset })
  } catch (e) {
    // A newer research replaced this one; its own result is what the page waits for.
    if (researchCtl !== ctl) return
    console.warn('[research]', ctl.signal.aborted ? 'cancelled' : e)
    broadcast({ t: 'research_error', message: ctl.signal.aborted ? 'Research cancelled.' : errorText(e) })
  } finally {
    if (researchCtl === ctl) researchCtl = undefined
  }
}

// ---------------------------------------------------------------- messages

class BadRequest extends Error {}

function need(ok: unknown, what: string): asserts ok {
  if (!ok) throw new BadRequest(`Bad request: ${what}`)
}

const isStr = (v: unknown): v is string => typeof v === 'string'
const optStr = (v: unknown) => v === undefined || isStr(v)
const isAnswers = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(isStr)

const MODES: readonly PermissionModeName[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']
const PERMISSION_DECISIONS: readonly Extract<ClientMsg, { t: 'permission' }>['decision'][] = ['allow', 'always', 'deny', 'feedback']
const PLAN_DECISIONS: readonly Extract<ClientMsg, { t: 'plan' }>['decision'][] = ['auto', 'manual', 'keep']

function live(): SessionApi {
  const s = current?.session
  if (!s) throw new BadRequest('No session is running. Start or load one first.')
  return s
}

function reveal(path: string) {
  need(isStr(path) && path.trim(), 'path')
  const p = resolve(path)
  if (!existsSync(p)) throw new BadRequest(`${p} doesn't exist.`)
  // Explorer parses its own command line, so the path is quoted by hand; Windows paths can't contain quotes.
  const args = isDir(p) ? [`"${p}"`] : [`/select,"${p}"`]
  const child = spawn('explorer.exe', args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
  child.on('error', (e) => console.error('[reveal]', e))
  child.unref()
}

async function handle(ws: WebSocket, m: ClientMsg) {
  switch (m.t) {
    case 'hello':
      // The page says hello only when it boots (first launch, F5, a renderer crash). It starts at the title screen
      // and can't attach to a running session, which may be blocked on a prompt nobody can see now: close it.
      if (current) {
        console.log(`[session] the app reloaded; closing epoch ${current.epoch}`)
        ++startGen
        void closeCurrent()
      }
      return sendTo(ws, { t: 'hello', version: VERSION, settings: await loadSettings(), auth: await auth.get(), dataDir: DATA_DIR })
    case 'settings_set': {
      need(m.settings && typeof m.settings === 'object' && m.settings.version === 1, 'settings')
      await updateSettings(() => m.settings)
      // The sender already has these settings; echoing them back could undo an edit typed meanwhile.
      return broadcast({ t: 'settings', settings: m.settings }, ws)
    }
    case 'auth_check':
      return sendTo(ws, { t: 'auth', auth: await auth.refresh() })
    case 'login':
      return auth.login()
    case 'saves':
      return sendTo(ws, { t: 'saves', list: await listSaves() })
    case 'save_rename':
      need(isSaveId(m.id) && isStr(m.title), 'id, title')
      await renameSave(m.id, m.title)
      return sendTo(ws, { t: 'saves', list: await listSaves() })
    case 'save_delete':
      need(isSaveId(m.id), 'id')
      await deleteSave(m.id)
      return sendTo(ws, { t: 'saves', list: await listSaves() })
    case 'save_meta': {
      need(isSaveId(m.id) && m.patch && typeof m.patch === 'object', 'id, patch')
      const cwd = current?.session?.sessionId() === m.id ? current.cwd : undefined
      return saveMeta(m.id, m.patch, m.thumb, cwd)
    }
    case 'costumes': {
      const r = await listCostumes(isStr(m.dir) ? m.dir : undefined)
      return sendTo(ws, { t: 'costumes', ...r })
    }
    case 'start':
      need(isStr(m.cwd) && m.cwd.trim() && Number.isFinite(m.epoch) && (m.resume === undefined || isSaveId(m.resume)), 'cwd, epoch, resume')
      return start(m)
    case 'end':
      ++startGen
      return closeCurrent()
    case 'say':
      need(isStr(m.text), 'text')
      return live().say(m.text, Array.isArray(m.images) ? m.images : undefined)
    case 'shell':
      need(isStr(m.command), 'command')
      return live().shell(m.command)
    case 'interrupt':
      return current?.session?.interrupt()
    case 'mode':
      need(MODES.includes(m.mode), 'mode')
      return live().setMode(m.mode)
    case 'model':
      need(isStr(m.model), 'model')
      return live().setModel(m.model)
    case 'permission':
      need(isStr(m.id) && PERMISSION_DECISIONS.includes(m.decision) && optStr(m.message), 'id, decision, message')
      return live().answerPermission(m.id, m.decision, m.message)
    case 'answer':
      need(isStr(m.id) && (m.answers === undefined || isAnswers(m.answers)), 'id, answers')
      return live().answerQuestion(m.id, m.answers ?? {})
    case 'plan':
      need(isStr(m.id) && PLAN_DECISIONS.includes(m.decision) && optStr(m.message), 'id, decision, message')
      return live().answerPlan(m.id, m.decision, m.message)
    case 'files': {
      need(isStr(m.query), 'query')
      const cwd = current?.cwd || (await loadSettings()).lastDir
      return sendTo(ws, { t: 'files', query: m.query, hits: cwd && isDir(cwd) ? await searchFiles(cwd, m.query) : [] })
    }
    case 'persona_preview':
      need(m.settings && typeof m.settings === 'object', 'settings')
      return sendTo(ws, { t: 'persona_preview', text: buildPersona(m.settings as Settings) })
    case 'research':
      need(isStr(m.name) && m.name.trim(), 'name')
      void runResearch({ ...m, series: isStr(m.series) ? m.series : '', notes: isStr(m.notes) ? m.notes : '' })
      return
    case 'research_cancel':
      return researchCtl?.abort()
    case 'reveal':
      return reveal(m.path)
    default:
      throw new BadRequest(`Unknown message type: ${String((m as { t?: unknown }).t)}`)
  }
}

let orphanTimer: ReturnType<typeof setTimeout> | undefined

wss.on('connection', (ws) => {
  clearTimeout(orphanTimer)
  ws.on('message', (raw) => {
    let m: ClientMsg
    try {
      m = JSON.parse(String(raw))
      need(m && typeof m === 'object' && isStr(m.t), 'message')
    } catch (e) {
      return sendTo(ws, { t: 'app_error', message: e instanceof BadRequest ? e.message : 'Bad request: not JSON' })
    }
    // One bad message must never take the link down: every failure becomes an app_error for the sender.
    Promise.resolve()
      .then(() => handle(ws, m))
      .catch((e) => {
        if (!(e instanceof BadRequest)) console.error(`[ws] ${m.t} failed:`, e)
        sendTo(ws, { t: 'app_error', message: errorText(e) })
      })
  })
  ws.on('error', (e) => console.warn('[ws] socket error:', e))
  ws.on('close', () => {
    if (wss.clients.size > 0 || !current) return
    orphanTimer = setTimeout(() => {
      if (wss.clients.size > 0) return
      console.log('[session] no app connected; closing the orphaned session')
      ++startGen
      void closeCurrent()
    }, ORPHAN_MS)
  })
})

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  console.log('[link] shutting down')
  researchCtl?.abort()
  ++startGen
  await closeCurrent()
  process.exit(0)
}
// stdin closes when the app exits (or crashes), so the sidecar never outlives it.
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.stdin.resume()
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

http.listen(PORT, '127.0.0.1', () => console.log(`[link] v${VERSION} listening on 127.0.0.1:${PORT}${MOCK ? ' (mock sessions)' : ''}, data in ${DATA_DIR}`))
