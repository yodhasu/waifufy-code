import { spawn } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { format } from 'node:util'
import { WebSocket, WebSocketServer } from 'ws'
import { listCostumes, serveMmd, serveModel, serveThumb } from './assets.ts'
import { asMood } from './affection.ts'
import { putAttachment } from './attachments.ts'
import { createAuth } from './auth.ts'
import { hasVoiceKey, setVoiceKey, synthesize } from './tts.ts'
import { searchFiles } from './files.ts'
import { buildPersona } from './persona.ts'
import { CTL_OPS, type ClientMsg, type FileHit, type PermissionModeName, type ServerMsg, type SessionEvent, type Settings } from './protocol.ts'
import { research } from './research.ts'
import { deleteSave, errorText, getSave, isSaveId, latestLove, listSaves, loadHistory, remember, renameSave, saveMeta, shortPath, unhide } from './saves.ts'
import { applyCard, cardLove, keepCard, deleteCard, ensureCard, exportCard, importCard, isCardId, listCards, newCard, readCard, setCardLove, syncCard } from './cards.ts'
import type { SessionApi, SessionFactory } from './session-api.ts'
import { createSession } from './session.ts'
import { scheduleLearning } from './casual/learn.ts'
import { openMemory } from './casual/memory.ts'
import { characterSlug, moodVoiceSpeed, withModes } from './casual/modes.ts'
import { hasCasualKey, setCasualKey } from './casual/providers.ts'
import { DATA_DIR, loadSettings, saveSettings } from './settings.ts'
import * as slack from './slack.ts'
import { addresses, REMOTE_PORT, remoteEnabled, remoteStatus, remoteTokenOk, resetRemoteToken, setRemoteEnabled } from './remote.ts'
import { acceptTrust, isTrusted, trustConcerns } from './trust.ts'

// The Tauri app starts this process with a free port and a token, and closes stdin when it quits.
const PORT = Number(process.env.WC_PORT ?? 47900)
const TOKEN = process.env.WC_TOKEN ?? ''
const MOCK = process.env.WC_MOCK === '1'
// Mock sessions edit settings files for real (the /permissions and /skills panels), so their "user" settings
// live in the test's data folder, never in the real ~/.claude.
if (MOCK) process.env.CLAUDE_CONFIG_DIR = join(DATA_DIR, 'mock-claude')
const claudePath = process.env.WC_CLAUDE || undefined
const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

/** Agents an @ query lists before the files. */
const AGENT_HITS = 4
/** A Fish Audio key is a short token; anything this long is not one. */
const KEY_MAX = 512
/** How long a closed session gets to emit `ended` (its CLI exiting) before the next one starts anyway. */
const CLOSE_WAIT_MS = 3_000
/** With no app connected for this long, the running session is closed: nobody can see or answer it. */
const ORPHAN_MS = 60_000
/** Phones are pinged this often; one that misses a ping is dropped, so its next connection starts clean. */
const PING_MS = Number(process.env.WC_PING_MS ?? 15_000)
/** How much of a session a joining window is replayed, at most (oldest dropped first). */
const JOURNAL_MAX_BYTES = 4 * 1024 * 1024

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

const mock = MOCK ? await import('./mock.ts') : undefined
const factory: SessionFactory = withModes(mock?.createMockSession ?? createSession)
/** Mock mode never spends model turns: research gets the scripted stand-in too. */
const runResearchQuery = mock?.mockResearch ?? research

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
  if (pathname.startsWith('/mmd/')) return serveMmd(pathname, res)
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

/** Every window: the desktop page(s) and connected phones. */
const clients = () => [...wss.clients, ...(phones?.wss.clients ?? [])]

function broadcast(m: ServerMsg, except?: WebSocket) {
  for (const ws of clients()) if (ws !== except) sendTo(ws, m)
}

/** To the desktop windows only: phone access's own status carries the pairing token. */
function broadcastLocal(m: ServerMsg) {
  for (const ws of wss.clients) sendTo(ws, m)
}

// ---------------------------------------------------------------- phone access

/** Connections that came in through the phone listener. */
const remoteSockets = new WeakSet<WebSocket>()
/**
 * A phone in a pocket or in the background loses its connection without closing it. Each one is pinged; one that
 * didn't answer the last ping is dropped, so it reconnects (and re-joins) cleanly instead of writing into a dead socket.
 */
const alive = new WeakMap<WebSocket, boolean>()
setInterval(() => {
  for (const ws of phones?.wss.clients ?? []) {
    if (alive.get(ws) === false) {
      ws.terminate()
      continue
    }
    alive.set(ws, false)
    try {
      ws.ping()
    } catch {
      ws.terminate()
    }
  }
}, PING_MS).unref()
let phones: { http: ReturnType<typeof createServer>; wss: WebSocketServer } | undefined
let phoneError: string | undefined

const phoneStatus = () => remoteStatus(!!phones, phones?.wss.clients.size ?? 0, phoneError)

/** Starts or stops the phone listener to match the setting; reports the outcome to the desktop windows. */
async function syncPhones() {
  if (remoteEnabled() && !phones) {
    const server = createServer((req, res) => {
      route(req, res).catch((e) => {
        console.error(`[http] ${req.url}:`, e)
        text(res, 500, 'internal error')
      })
    })
    const pws = new WebSocketServer({
      server,
      // Over Wi-Fi or Tailscale: a joining phone's replay can be megabytes of text, which compresses well.
      perMessageDeflate: { threshold: 1024 },
      verifyClient: ({ req }: { req: IncomingMessage }) => remoteTokenOk(new URL(req.url ?? '/', 'http://link').searchParams.get('token') ?? ''),
    })
    pws.on('connection', (ws) => {
      remoteSockets.add(ws)
      alive.set(ws, true)
      ws.on('pong', () => alive.set(ws, true))
      serve(ws)
      broadcastLocal({ t: 'remote_status', status: phoneStatus() })
      ws.on('close', () => broadcastLocal({ t: 'remote_status', status: phoneStatus() }))
    })
    phoneError = await new Promise<string | undefined>((resolve) => {
      server.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EADDRINUSE' ? `Port ${REMOTE_PORT} is in use by another program.` : e.message))
      // Every interface: the phone comes in over Wi-Fi or Tailscale. The token keeps everyone else out.
      server.listen(REMOTE_PORT, '0.0.0.0', () => resolve(undefined))
    })
    if (phoneError) {
      console.warn('[remote] phone access could not start:', phoneError)
      pws.close()
    } else {
      phones = { http: server, wss: pws }
      // A later failure (the network going away) shouldn't take the link down.
      server.on('error', (e) => console.warn('[remote] phone listener error:', e))
      console.log(`[remote] phone access on port ${REMOTE_PORT}: ${addresses().join(', ') || 'no network address'}`)
    }
  } else if (!remoteEnabled() && phones) {
    stopPhones()
    phoneError = undefined
  }
  broadcastLocal({ t: 'remote_status', status: phoneStatus() })
}

function stopPhones() {
  if (!phones) return
  for (const ws of phones.wss.clients) ws.terminate()
  phones.wss.close()
  phones.http.close()
  phones = undefined
  console.log('[remote] phone access off')
}

/**
 * A window joining mid-session (`attach`): the epoch, then the session's state so far as the events that hold it,
 * with the transcript read fresh, and the prompts still open. A turn half-written at that moment shows from its next
 * paragraph.
 */
async function attach(ws: WebSocket) {
  const live = current
  if (!live?.session) return sendTo(ws, { t: 'attached' })
  const started = live.latest.get('started') as Extract<SessionEvent, { t: 'started' }> | undefined
  const id = live.session.sessionId()
  // The slow reads first: everything from `attached` on goes out in one synchronous block, so no event of the
  // running session can slip in between and reach this window twice (live, then again in the replay).
  const history = live.journal.length && !live.trimmed ? started?.history ?? [] : id ? await loadHistory(id, live.cwd).catch(() => started?.history ?? []) : started?.history ?? []
  const save = id ? await getSave(id, live.cwd).catch(() => started?.save) : started?.save
  if (current !== live || ws.readyState !== WebSocket.OPEN) return
  sendTo(ws, { t: 'attached', epoch: live.epoch })
  // The transcript as it was when the session started; what happened since comes in the replay, so nothing shows twice.
  // A journal that outgrew its cap starts from the fresh transcript instead, and replays only the current turn.
  if (started) sendTo(ws, { ...started, history, ...(save ? { save } : {}), resumed: true, epoch: live.epoch })
  // Then the state as it is now (running or not, stats, quests), so it wins over what the replay ends on.
  sendTo(ws, { t: 'replay', epoch: live.epoch, events: live.trimmed ? sinceLastTurn(live.journal) : live.journal })
  for (const [t, e] of live.latest) if (t !== 'started') sendTo(ws, { ...e, epoch: live.epoch } as ServerMsg)
  for (const e of live.asks.values()) sendTo(ws, { ...e, epoch: live.epoch } as ServerMsg)
}

/** The journal from the last finished turn on: what a fresh transcript doesn't hold yet. */
function sinceLastTurn(journal: SessionEvent[]) {
  const at = journal.findLastIndex((e) => e.t === 'turn_end')
  return journal.slice(at + 1)
}

/** An answer from one window closes the same prompt in the others (the desktop and a phone both show it). */
function answered(ws: WebSocket, id: string) {
  const live = current
  if (!live?.asks.delete(id)) return
  record(live, { t: 'ask_cancel', id })
  broadcast({ t: 'ask_cancel', id, epoch: live.epoch }, ws)
}

/** What a window sent her, to the other windows (and the journal), so a phone and the desktop read the same chat. */
function said(ws: WebSocket, e: Extract<SessionEvent, { t: 'said' }>) {
  const live = current
  if (!live?.session) return
  record(live, e)
  broadcast({ ...e, epoch: live.epoch }, ws)
}

/** Events a joining window doesn't need again: the moment's face and voice, the spinner, transient notes. */
const UNJOURNALED = new Set<SessionEvent['t']>(['face', 'voice', 'affection', 'progress', 'notify', 'hook', 'suggestion', 'offer_mode'])

const size = (e: SessionEvent) => JSON.stringify(e).length

/** Keeps a session event for the replay a joining window gets: text deltas joined, oldest dropped past the cap. */
function record(live: Live, e: SessionEvent) {
  if (UNJOURNALED.has(e.t) || STATE_EVENTS.has(e.t) || ASK_EVENTS.has(e.t)) return
  const last = live.journal.at(-1)
  if (e.t === 'text' && last?.t === 'text') {
    // Counted as it will be sent (escapes included), so trimming takes off what was added.
    live.journalBytes -= size(last)
    last.delta += e.delta
    live.journalBytes += size(last)
  } else {
    const copy = structuredClone(e)
    live.journal.push(copy)
    live.journalBytes += size(copy)
  }
  while (live.journalBytes > JOURNAL_MAX_BYTES && live.journal.length > 1) {
    live.journalBytes -= size(live.journal.shift()!)
    live.trimmed = true
  }
}

// ---------------------------------------------------------------- services

// A reflection a closed app never got to: she catches up shortly after the link starts (casual/learn.ts).
if (!MOCK) {
  setTimeout(() => {
    void loadSettings().then((s) => {
      if (s.casual.learning) scheduleLearning({ settings: s, memory: openMemory(characterSlug(s)), claudePath, idleMs: s.casual.idleMin * 60_000 })
    })
  }, 60_000).unref()
}

const auth = createAuth(claudePath, (a) => broadcast({ t: 'auth', auth: a }))
void auth.refresh()

slack.onStatus((status) => broadcast({ t: 'slack_status', status }))
slack.onInbox((inbox) => broadcast({ t: 'slack_inbox', inbox }))
slack.startSlack()

/** Answers a Slack request on its own time, so a slow scan never holds up the messages behind it. */
function slackReply(ws: WebSocket, work: () => Promise<ServerMsg>, failed: (error: string) => ServerMsg) {
  void work().then((m) => sendTo(ws, m), (e) => sendTo(ws, failed(errorText(e))))
}

/** Settings writes run one at a time and re-read the file, so a lastDir or preset write never undoes a settings_set. */
let settingsWrites: Promise<unknown> = Promise.resolve()

function updateSettings(change: (s: Settings) => Settings | void | Promise<Settings | void>): Promise<Settings> {
  const run = settingsWrites.then(async () => {
    const s = await loadSettings()
    const next = (await change(s)) ?? s
    await saveSettings(next)
    return next
  })
  settingsWrites = run.catch(() => {})
  return run
}

// ---------------------------------------------------------------- waifu cards

/** The active card exists on disk before anything reads settings: the first launch with cards makes it from them. */
const cardsReady = updateSettings(async (s) => void (await ensureCard(s, latestLove))).catch((e) => console.error('[cards] could not set up the first card:', e))

/** Makes `id` the active card. The one it replaces already has every edit (settings_set syncs it). */
function switchCard(id: string): Promise<Settings> {
  return updateSettings(async (s) => {
    const c = await readCard(id)
    if (!c) throw new BadRequest('That waifu card no longer exists.')
    applyCard(s, c)
  })
}

async function sendCards(ws?: WebSocket) {
  const m: ServerMsg = { t: 'cards', list: await listCards(), active: (await loadSettings()).card }
  if (ws) sendTo(ws, m)
  else broadcast(m)
}

/** Cards change what she is; one switched mid-session would leave the running session's persona and love meter behind. */
function needNoSession() {
  if (current) throw new BadRequest('Finish the current session first: a waifu card is swapped between sessions.')
}

// ---------------------------------------------------------------- sessions

type Live = {
  epoch: number
  cwd: string
  /** The waifu card the session plays: its love meter is what the session's affection writes to. */
  card: string
  session?: SessionApi
  /** Set by an intentional close: only its `ended` still goes out. */
  closing: boolean
  ended: Promise<void>
  emit(e: SessionEvent): void
  /** What a window joining mid-session needs (`attach`): the latest event of each kind that holds state. */
  latest: Map<SessionEvent['t'], SessionEvent>
  /** Prompts still waiting on an answer, by id, in the order they came. */
  asks: Map<string, SessionEvent>
  /** Everything else since the start, for the replay a joining window gets (record()). */
  journal: SessionEvent[]
  journalBytes: number
  /** The journal lost its oldest events to the cap: a joiner gets the fresh transcript plus the current turn. */
  trimmed: boolean
}

/** Session events that each replace the one before; replayed to a window that attaches. */
const STATE_EVENTS = new Set<SessionEvent['t']>(['started', 'ready', 'session_id', 'commands', 'stats', 'todos', 'bg_tasks', 'state', 'chat_mode'])
const ASK_EVENTS = new Set<SessionEvent['t']>(['ask_permission', 'ask_question', 'ask_plan', 'ask_elicit'])

let current: Live | undefined
/** Bumped by every start and end, so a start that was overtaken while it awaited drops out instead of spawning a CLI. */
let startGen = 0

function makeLive(epoch: number, cwd: string, card: string): Live {
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
    if (STATE_EVENTS.has(e.t)) live.latest.set(e.t, e)
    if (ASK_EVENTS.has(e.t)) live.asks.set((e as { id: string }).id, e)
    if (e.t === 'ask_cancel') live.asks.delete(e.id)
    record(live, e)
    broadcast({ ...e, epoch } as ServerMsg)
  }
  const live: Live = { epoch, cwd, card, closing: false, ended, emit, latest: new Map(), asks: new Map(), journal: [], journalBytes: 0, trimmed: false }
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
  // The app shows the trust dialog first; this only stops a start that skipped it.
  if (!isTrusted(cwd)) return sessionFailed(m.epoch, `The folder ${cwd} isn't trusted yet. Open it from New Game or Load to confirm you trust it.`)
  let live: Live | undefined
  // Whatever fails from here, the chat waiting on this epoch gets its error and `ended` instead of hanging (R24).
  try {
    if (m.resume) await unhide(m.resume)
    // A rewind shows the conversation only up to the point it keeps.
    const [history, save] = m.resume ? await Promise.all([loadHistory(m.resume, cwd, m.resumeAt), getSave(m.resume, cwd)]) : [[], undefined]
    if (gen !== startGen) return
    // A save plays on with the card it was played with, when that card is still here.
    await cardsReady
    if (save?.card && isCardId(save.card) && save.card !== (await loadSettings()).card && (await readCard(save.card))) {
      broadcast({ t: 'settings', settings: await switchCard(save.card) })
      void sendCards()
    }
    // Read inside the settings queue, so a settings_set sent just before (the profile, saved before New Game) is in the persona.
    const settings = await rememberDir(cwd)
    const love = await cardLove(settings.card)
    if (gen !== startGen) return
    // From here to `current = live` nothing awaits, so no other start can slip in between.
    live = makeLive(m.epoch, cwd, settings.card)
    current = live
    live.session = factory({ epoch: m.epoch, cwd, resume: m.resume, resumeAt: m.resumeAt, dropsTurn: m.dropsTurn, settings, claudePath, emit: live.emit })
    console.log(`[session] epoch ${m.epoch} ${m.resume ? `resume ${m.resume}` : 'new'} in ${cwd}${MOCK ? ' (mock)' : ''}`)
    const started: SessionEvent = { t: 'started', cwd, cwdShort: shortPath(cwd), resumed: !!m.resume, history, save, love }
    live.latest.set('started', started)
    broadcast({ ...started, epoch: m.epoch })
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
    const preset = await runResearchQuery({
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
    await syncCard(settings)
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

/** Connections that already said hello. */
const greeted = new WeakSet<WebSocket>()
/** A name per connection, for who is typing (casual/modes.ts). */
const clientIds = new WeakMap<WebSocket, string>()
let clientSeq = 0
const clientId = (ws: WebSocket) => {
  let id = clientIds.get(ws)
  if (!id) clientIds.set(ws, (id = `c${++clientSeq}`))
  return id
}

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

/** Opens an http(s) URL in the browser, or an existing file or folder with its default app. */
function open(target: string) {
  need(isStr(target) && target.trim(), 'target')
  const url = /^https?:///i.test(target)
  if (!url && !existsSync(resolve(target))) throw new BadRequest(`${target} doesn't exist.`)
  const what = url ? target : resolve(target)
  const child = process.platform === 'win32'
    ? spawn('rundll32.exe', ['url.dll,FileProtocolHandler', what], { detached: true, stdio: 'ignore' })
    : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [what], { detached: true, stdio: 'ignore' })
  child.on('error', (e) => console.error('[open]', e))
  child.unref()
}

/** The session's subagents whose name matches an @ query ("@agent-ex", "@expl"), as @agent-<name> hits. */
async function agentHits(query: string): Promise<FileHit[]> {
  const q = query.toLowerCase().replace(/^agent-?/, '')
  if (!current?.session || (!q && !query.toLowerCase().startsWith('agent'))) return []
  const list = (await current.session.control('supportedAgents', []).catch(() => [])) as { name: string; description?: string }[]
  return list
    .filter((a) => a.name.toLowerCase().includes(q))
    .slice(0, AGENT_HITS)
    .map((a) => ({ path: `agent-${a.name}`, isDir: false, agent: { name: a.name, description: a.description ?? '' } }))
}

async function handle(ws: WebSocket, m: ClientMsg) {
  switch (m.t) {
    case 'hello':
      // The first hello on a connection means the page booted (first launch, F5, a renderer crash). It starts at the
      // title screen and can't attach to a running session, which may be blocked on a prompt nobody can see now: close
      // it. Screens may say hello again later (for the version or login state); those must never end the session.
      // A phone joining is never a reload: the desktop's session stays (it can `attach` to it).
      if (!greeted.has(ws)) {
        greeted.add(ws)
        if (current && !remoteSockets.has(ws)) {
          console.log(`[session] the app reloaded; closing epoch ${current.epoch}`)
          ++startGen
          void closeCurrent()
        }
      }
      await cardsReady
      return sendTo(ws, {
        t: 'hello', version: VERSION, settings: await loadSettings(), auth: await auth.get(), dataDir: DATA_DIR, voiceKey: hasVoiceKey(), casualKey: hasCasualKey(), slack: slack.status(),
        remote: remoteSockets.has(ws),
      })
    case 'settings_set': {
      need(m.settings && typeof m.settings === 'object' && m.settings.version === 1, 'settings')
      // The active card changes only through card_switch; everything else of hers is written back to it. Settings
      // from a window that hasn't heard of a switch yet carry the old card's fields: those go to the old card, and
      // the new one keeps its own.
      const from = m.settings.card
      const saved = await updateSettings((s) => {
        const next = { ...m.settings, card: s.card }
        if (from !== s.card) keepCard(next, s)
        return next
      })
      if (from !== saved.card) await syncCard(m.settings)
      await syncCard(saved)
      // The sender already has these settings; echoing them back could undo an edit typed meanwhile.
      return broadcast({ t: 'settings', settings: saved }, ws)
    }
    case 'tts': {
      need(isStr(m.id) && isStr(m.text), 'tts')
      const id = m.id
      // Answered on its own time: a slow clip must not hold up the messages behind it.
      void loadSettings()
        .then((s) => synthesize(m.text, { ...s.voice, speed: s.voice.speed * moodVoiceSpeed() }))
        .then((clip) => sendTo(ws, { t: 'tts', id, audio: clip.audio.toString('base64'), mime: clip.mime }))
        .catch((e) => sendTo(ws, { t: 'tts', id, error: e instanceof Error ? e.message : String(e) }))
      return
    }
    case 'voice_key':
      need(typeof m.key === 'string' && m.key.length < KEY_MAX, 'key')
      await setVoiceKey(m.key)
      return broadcast({ t: 'voice_key', has: hasVoiceKey() })
    case 'casual_key':
      need(typeof m.key === 'string' && m.key.length < KEY_MAX, 'key')
      await setCasualKey(m.key)
      return broadcast({ t: 'casual_key', has: hasCasualKey() })
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
      const live = current?.session?.sessionId() === m.id ? current : undefined
      // Only the running session moves a love meter, and only its own card's; the save keeps a copy for the Load list.
      if (live && typeof m.patch.affectionPts === 'number') await setCardLove(live.card, m.patch.affectionPts)
      return saveMeta(m.id, live ? { ...m.patch, card: live.card } : m.patch, m.thumb, live?.cwd)
    }
    case 'cards':
      await cardsReady
      return sendCards(ws)
    case 'card_switch': {
      need(isCardId(m.id), 'id')
      needNoSession()
      broadcast({ t: 'settings', settings: await switchCard(m.id) })
      return sendCards()
    }
    case 'card_new': {
      need(m.from === undefined || isCardId(m.from), 'from')
      needNoSession()
      const from = m.from ? await readCard(m.from) : undefined
      if (m.from && !from) throw new BadRequest('That waifu card no longer exists.')
      const c = await newCard(from)
      broadcast({ t: 'settings', settings: await switchCard(c.id) })
      return sendCards()
    }
    case 'card_delete': {
      need(isCardId(m.id), 'id')
      if (m.id === (await loadSettings()).card) throw new BadRequest('Switch to another card before deleting this one.')
      await deleteCard(m.id)
      return sendCards()
    }
    case 'card_export':
      need(isCardId(m.id) && isStr(m.path) && m.path.trim(), 'id, path')
      return exportCard(m.id, m.path).then(
        (path) => sendTo(ws, { t: 'card_file', op: 'export', id: m.id, path }),
        (e) => sendTo(ws, { t: 'card_file', op: 'export', id: m.id, path: m.path, error: errorText(e) }),
      )
    case 'card_import':
      need(isStr(m.path) && m.path.trim(), 'path')
      return importCard(m.path).then(
        async (c) => {
          sendTo(ws, { t: 'card_file', op: 'import', id: c.id, path: m.path })
          await sendCards()
        },
        (e) => sendTo(ws, { t: 'card_file', op: 'import', path: m.path, error: errorText(e) }),
      )
    case 'costumes': {
      const r = await listCostumes(isStr(m.dir) ? m.dir : undefined)
      return sendTo(ws, { t: 'costumes', ...r })
    }
    case 'file_put':
      need(isStr(m.id) && m.id.length < KEY_MAX && isStr(m.name) && isStr(m.data), 'id, name, data')
      return putAttachment(m.name, m.data).then(
        (path) => sendTo(ws, { t: 'file_put', id: m.id, path }),
        (e) => sendTo(ws, { t: 'file_put', id: m.id, error: errorText(e) }),
      )
    case 'trust_check':
    case 'trust_accept': {
      need(isStr(m.cwd) && m.cwd.trim(), 'cwd')
      const cwd = resolve(m.cwd)
      if (m.t === 'trust_accept') await acceptTrust(cwd)
      const trusted = isTrusted(cwd)
      return sendTo(ws, { t: 'trust', cwd: m.cwd, trusted, concerns: trusted || !isDir(cwd) ? [] : await trustConcerns(cwd) })
    }
    case 'start':
      need(isStr(m.cwd) && m.cwd.trim() && Number.isFinite(m.epoch) && (m.resume === undefined || isSaveId(m.resume)) && optStr(m.resumeAt) && optStr(m.dropsTurn), 'cwd, epoch, resume, resumeAt, dropsTurn')
      return start(m)
    case 'end':
      ++startGen
      return closeCurrent()
    case 'say':
      need(isStr(m.text), 'text')
      said(ws, { t: 'said', text: m.text, ...(Array.isArray(m.images) && m.images.length ? { images: m.images.length } : {}) })
      return live().say(m.text, Array.isArray(m.images) ? m.images : undefined, m.now === true, asMood(m.mood))
    case 'shell':
      need(isStr(m.command), 'command')
      said(ws, { t: 'said', text: m.command, shell: true })
      return live().shell(m.command)
    case 'interrupt':
      return current?.session?.interrupt()
    case 'chat_mode':
      need(m.mode === 'work' || m.mode === 'casual', 'mode')
      return live().setChatMode?.(m.mode, m.compact === true)
    case 'typing':
      return current?.session?.typing?.(clientId(ws), m.on === true)
    case 'mode':
      need(MODES.includes(m.mode), 'mode')
      return live().setMode(m.mode)
    case 'model':
      need(isStr(m.model), 'model')
      return live().setModel(m.model)
    case 'ctl': {
      need(isStr(m.id) && CTL_OPS.includes(m.op) && (m.args === undefined || Array.isArray(m.args)), 'id, op, args')
      // Answered on this socket even when it fails, so the panel that asked can show the error instead of waiting.
      try {
        return sendTo(ws, { t: 'ctl_result', id: m.id, ok: true, data: await live().control(m.op, m.args ?? []) })
      } catch (e) {
        return sendTo(ws, { t: 'ctl_result', id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    }
    case 'permission':
      need(isStr(m.id) && PERMISSION_DECISIONS.includes(m.decision) && optStr(m.message) && optStr(m.option), 'id, decision, message, option')
      answered(ws, m.id)
      return live().answerPermission(m.id, m.decision, m.message, m.option)
    case 'answer':
      need(isStr(m.id) && (m.answers === undefined || isAnswers(m.answers)), 'id, answers')
      answered(ws, m.id)
      return live().answerQuestion(m.id, m.answers ?? {})
    case 'plan':
      need(isStr(m.id) && PLAN_DECISIONS.includes(m.decision) && optStr(m.message), 'id, decision, message')
      answered(ws, m.id)
      return live().answerPlan(m.id, m.decision, m.message)
    case 'files': {
      need(isStr(m.query), 'query')
      const cwd = current?.cwd || (await loadSettings()).lastDir
      const [files, agents] = await Promise.all([cwd && isDir(cwd) ? searchFiles(cwd, m.query) : [], agentHits(m.query)])
      // As in the CLI, agents and files share one list; matching agents come first.
      return sendTo(ws, { t: 'files', query: m.query, hits: [...agents, ...files] })
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
    case 'open':
      return open(m.target)
    case 'elicit':
      need(isStr(m.id) && ['accept', 'decline', 'cancel'].includes(m.action) && (m.content === undefined || (typeof m.content === 'object' && m.content !== null)), 'id, action, content')
      try {
        live().answerElicit(m.id, m.action, m.content)
        return answered(ws, m.id)
      } catch (e) {
        // A form that doesn't fit the schema stays open; the reason goes back to the app.
        throw new BadRequest(e instanceof Error ? e.message : String(e))
      }
    case 'slack_signin':
      need(isStr(m.clientId) && m.clientId.length < KEY_MAX, 'clientId')
      // Runs until the browser comes back (or times out); slack_status reports how it went.
      void slack.signIn(m.clientId, open)
      return
    case 'slack_signin_cancel':
      return slack.cancelSignIn()
    case 'slack_signout':
      return slack.signOut()
    case 'slack_inbox':
      if (m.refresh === true) slack.refreshInbox()
      // With the status too: a window that reconnected after a link restart missed the pushes.
      sendTo(ws, { t: 'slack_status', status: slack.status() })
      return sendTo(ws, { t: 'slack_inbox', inbox: slack.inbox() })
    case 'slack_convs':
      return slackReply(ws, async () => ({ t: 'slack_convs', convs: await slack.allConversations() }), (error) => ({ t: 'slack_convs', convs: [], error }))
    case 'slack_history': {
      need(isStr(m.id) && isStr(m.channel) && optStr(m.thread), 'id, channel, thread')
      const { id, channel, thread } = m
      return slackReply(
        ws,
        async () => {
          const h = await slack.history(channel, thread)
          return { t: 'slack_history', id, channel: h.conv.id, name: h.conv.name, messages: h.messages, ...(h.lastRead ? { lastRead: h.lastRead } : {}) }
        },
        (error) => ({ t: 'slack_history', id, channel, error }),
      )
    }
    case 'slack_mark':
      need(isStr(m.channel) && isStr(m.ts), 'channel, ts')
      // A failure only means the badge stays; the inbox's next scan has the truth either way.
      void slack.markRead(m.channel, m.ts).catch((e) => console.warn('[slack] mark read failed:', errorText(e)))
      return
    case 'slack_send': {
      need(isStr(m.id) && isStr(m.channel) && isStr(m.text) && optStr(m.thread), 'id, channel, text, thread')
      const { id, channel, text, thread } = m
      return slackReply(ws, async () => (await slack.send(channel, text, thread), { t: 'slack_sent', id, ok: true }), (error) => ({ t: 'slack_sent', id, ok: false, error }))
    }
    case 'attach':
      return attach(ws)
    case 'remote_set':
    case 'remote_reset':
    case 'remote_status':
      // Only the desktop turns phone access on, or sees its token.
      need(!remoteSockets.has(ws), 'phone access is managed on the desktop')
      if (m.t === 'remote_set') {
        need(typeof m.enabled === 'boolean', 'enabled')
        await setRemoteEnabled(m.enabled)
        return syncPhones()
      }
      if (m.t === 'remote_reset') {
        await resetRemoteToken()
        for (const p of phones?.wss.clients ?? []) p.close(4001, 'unpaired')
        return broadcastLocal({ t: 'remote_status', status: phoneStatus() })
      }
      return sendTo(ws, { t: 'remote_status', status: phoneStatus() })
    default:
      throw new BadRequest(`Unknown message type: ${String((m as { t?: unknown }).t)}`)
  }
}

let orphanTimer: ReturnType<typeof setTimeout> | undefined

wss.on('connection', serve)

/** One window's connection, from the desktop page or (phone access) a phone. */
function serve(ws: WebSocket) {
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
    // A composer that went away isn't typing any more.
    current?.session?.typing?.(clientId(ws), false)
    if (clients().length > 0 || !current) return
    orphanTimer = setTimeout(() => {
      if (clients().length > 0) return
      console.log('[session] no app connected; closing the orphaned session')
      ++startGen
      void closeCurrent()
    }, ORPHAN_MS)
  })
}

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  console.log('[link] shutting down')
  researchCtl?.abort()
  ++startGen
  stopPhones()
  await closeCurrent()
  process.exit(0)
}
// stdin closes when the app exits (or crashes), so the sidecar never outlives it.
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.stdin.resume()
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

http.listen(PORT, '127.0.0.1', () => {
  console.log(`[link] v${VERSION} listening on 127.0.0.1:${PORT}${MOCK ? ' (mock sessions)' : ''}, data in ${DATA_DIR}`)
  // Phone access left on comes back with the app.
  void syncPhones()
})
