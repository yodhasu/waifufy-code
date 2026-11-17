// A mod's session.start and session.interrupt (link/src/server.ts modStart), against a real link process in mock
// mode: the permission, an untrusted or missing folder refused, a start that ends the running session mid-turn and
// returns a newer epoch, every window told (`session_started`), the mode applied and the text said after the start.
// Run: node tests/unit/mods-session.test.mjs (no app, no Claude). Needs port 47995 free.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(new URL('../../link/package.json', import.meta.url))
const { WebSocket } = require('ws')

const dir = mkdtempSync(join(tmpdir(), 'wc-mods-session-'))
const project = join(dir, 'project')
mkdirSync(project)
// Outside WC_TRUST_FOLDERS, so never trusted.
const untrusted = mkdtempSync(join(tmpdir(), 'wc-untrusted-'))
const modsDir = join(dir, 'test-mods')
const mod = (id, permissions) => {
  mkdirSync(join(modsDir, id), { recursive: true })
  writeFileSync(join(modsDir, id, 'mod.json'), JSON.stringify({ id, name: id, version: '1.0.0', apiVersion: 1, defaultEnabled: true, permissions }))
}
mod('rem', ['session.start', 'session.interrupt'])
mod('chatty', ['chat.send'])
const PORT = 47995
const TOKEN = 'desktop-token'
const env = { ...process.env, WC_PORT: String(PORT), WC_TOKEN: TOKEN, WC_DATA_DIR: dir, WC_REMOTE_PORT: '47935', WC_MOCK: '1', WC_MOCK_TICK_MS: '2', WC_TRUST_FOLDERS: project, WC_MODS_DIR: modsDir }
delete env.WC_CASUAL_KEY
const link = spawn(process.execPath, ['link/src/server.ts'], { cwd: new URL('../..', import.meta.url), env, stdio: ['pipe', 'pipe', 'pipe'] })
let linkLog = ''
link.stdout.on('data', (d) => (linkLog += d))
link.stderr.on('data', (d) => (linkLog += d))

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`PASS  ${name}`)
  } catch (e) {
    failures++
    console.log(`FAIL  ${name}\n      ${e.stack ?? e.message}`)
  }
}
const ok = (v, msg) => {
  if (!v) throw new Error(msg)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A WebSocket client that keeps every message and can wait for one. */
function client(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const got = []
    const waiters = []
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw))
      got.push(m)
      for (const w of [...waiters]) if (w.pred(m)) waiters.splice(waiters.indexOf(w), 1), w.resolve(m)
    })
    ws.on('open', () =>
      resolve({
        got,
        send: (m) => ws.send(JSON.stringify(m)),
        next: (pred, ms = 10_000) => {
          const seen = got.find(pred)
          if (seen) return Promise.resolve(seen)
          return new Promise((res, rej) => {
            waiters.push({ pred, resolve: res })
            setTimeout(() => rej(new Error(`timed out waiting; got: ${got.map((x) => x.t).join(', ')}`)), ms)
          })
        },
        clear: () => (got.length = 0),
        close: () => ws.close(),
      }),
    )
    ws.on('error', reject)
  })
}

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return
    } catch {}
    await sleep(100)
  }
  throw new Error(`the link never came up:\n${linkLog}`)
}

let seq = 0
/** A capability call the way a panel or backend makes it (both go through Mods.appCall). */
async function call(c, id, capability, params) {
  const n = ++seq
  c.send({ t: 'mod-app', id, seq: n, capability, params })
  const r = await c.next((m) => m.t === 'mod-reply' && m.seq === n)
  if (!r.ok) throw new Error(r.error)
  return r.value
}
const fails = (p) => p.then(() => '', (e) => e.message)

try {
  await waitUp()
  const desk = await client(`ws://127.0.0.1:${PORT}/?token=${TOKEN}`)
  const other = await client(`ws://127.0.0.1:${PORT}/?token=${TOKEN}`)
  desk.send({ t: 'hello' })
  await desk.next((m) => m.t === 'hello')
  desk.send({ t: 'mods' })
  await desk.next((m) => m.t === 'mods' && m.mods.some((x) => x.id === 'rem' && x.status === 'running'))

  await test('without the session.start permission the call is refused and nothing starts', async () => {
    ok((await fails(call(desk, 'chatty', 'session.start', { cwd: project }))) === 'permission denied: session.start', 'start refused')
    ok((await fails(call(desk, 'chatty', 'session.interrupt'))) === 'permission denied: session.interrupt', 'interrupt refused')
    ok(!desk.got.some((m) => m.t === 'started' || m.t === 'session_started'), 'no session')
  })

  await test('an untrusted, missing or bad folder is refused with the reason', async () => {
    ok((await fails(call(desk, 'rem', 'session.start', { cwd: untrusted }))).includes("isn't trusted"), 'untrusted')
    ok((await fails(call(desk, 'rem', 'session.start', { cwd: join(project, 'nope') }))).includes("doesn't exist"), 'missing')
    ok((await fails(call(desk, 'rem', 'session.start', { cwd: project, mode: 'yolo' }))).includes('Bad request'), 'bad mode')
    ok(!desk.got.some((m) => m.t === 'started' || m.t === 'session_started'), 'no session')
  })

  let first
  await test('a start tells every window, applies the mode, and says the text in the new session', async () => {
    desk.clear()
    other.clear()
    first = (await call(desk, 'rem', 'session.start', { cwd: project, mode: 'plan', text: 'slow' })).epoch
    ok(Number.isFinite(first), `epoch: ${first}`)
    for (const c of [desk, other]) {
      ok((await c.next((m) => m.t === 'session_started')).epoch === first, 'session_started carries the epoch')
      ok((await c.next((m) => m.t === 'started')).epoch === first, 'started under it')
      const said = await c.next((m) => m.t === 'said')
      ok(said.epoch === first && said.text === 'slow', `said: ${JSON.stringify(said)}`)
    }
    const order = desk.got.map((m) => m.t)
    ok(order.indexOf('started') < order.indexOf('session_started') && order.indexOf('session_started') < order.indexOf('said'), `order: ${order.join(', ')}`)
    ok((await desk.next((m) => m.t === 'stats' && m.stats.mode === 'plan')).epoch === first, 'mode applied')
  })

  await test('session.interrupt stops the running turn', async () => {
    await desk.next((m) => m.t === 'state' && m.epoch === first && m.state === 'running')
    await call(desk, 'rem', 'session.interrupt')
    ok((await desk.next((m) => m.t === 'turn_end' && m.epoch === first)).interrupted, 'interrupted')
  })

  await test('a start mid-turn ends the running session and returns a newer epoch', async () => {
    desk.clear()
    desk.send({ t: 'say', text: 'slow' })
    await desk.next((m) => m.t === 'state' && m.epoch === first && m.state === 'running')
    desk.clear()
    const second = (await call(desk, 'rem', 'session.start', { cwd: project, text: 'hello again' })).epoch
    ok(second > first, `${second} > ${first}`)
    ok((await desk.next((m) => m.t === 'ended')).epoch === first, 'the old session ended')
    ok((await desk.next((m) => m.t === 'session_started')).epoch === second, 'session_started')
    ok((await desk.next((m) => m.t === 'said')).epoch === second, 'text said in the new session')
    // A window that joins now gets the new session, its said text included.
    other.clear()
    other.send({ t: 'attach' })
    ok((await other.next((m) => m.t === 'attached')).epoch === second, 'attached to the new session')
    ok((await other.next((m) => m.t === 'replay')).events.some((e) => e.t === 'said' && e.text === 'hello again'), 'replay holds the text')
  })
  desk.close()
  other.close()
} finally {
  link.stdin.end()
  link.kill()
}

if (failures) console.log(`\n--- link log ---\n${linkLog.slice(-3000)}`)
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
