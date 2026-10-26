// Phone access, end to end against a real link process in mock mode: off by default, the desktop turns it on and
// gets the pairing link, a phone needs that token, a phone's hello leaves the desktop's session running, `attach`
// replays the session, an answer from one window closes the prompt in the other, and the desktop can unpair.
// Run: node tests/unit/remote.test.mjs (no app, no Claude). Needs port 47920 free.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(new URL('../../link/package.json', import.meta.url))
const { WebSocket } = require('ws')

const dir = mkdtempSync(join(tmpdir(), 'wc-remote-'))
const project = join(dir, 'project')
mkdirSync(project)
const PORT = 47990
const TOKEN = 'desktop-token'
const link = spawn(process.execPath, ['link/src/server.ts'], {
  cwd: new URL('../..', import.meta.url),
  env: { ...process.env, WC_PORT: String(PORT), WC_TOKEN: TOKEN, WC_DATA_DIR: dir, WC_MOCK: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
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
        ws,
        got,
        send: (m) => ws.send(JSON.stringify(m)),
        next: (pred, ms = 5000) => {
          const seen = got.find(pred)
          if (seen) return Promise.resolve(seen)
          return new Promise((res, rej) => {
            waiters.push({ pred, resolve: res })
            setTimeout(() => rej(new Error(`timed out waiting; got: ${got.map((x) => x.t).join(', ')}`)), ms)
          })
        },
        clear: () => (got.length = 0),
      }),
    )
    ws.on('error', reject)
    ws.on('unexpected-response', (_, res) => reject(new Error(`refused: ${res.statusCode}`)))
  })
}

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`)
      if (r.ok) return
    } catch {}
    await sleep(100)
  }
  throw new Error(`the link never came up:\n${linkLog}`)
}

try {
  await waitUp()
  const desk = await client(`ws://127.0.0.1:${PORT}/?token=${TOKEN}`)
  desk.send({ t: 'hello' })
  await desk.next((m) => m.t === 'hello')

  let pair
  await test('phone access is off until the desktop turns it on; then it reports the pairing link', async () => {
    desk.send({ t: 'remote_status' })
    const off = await desk.next((m) => m.t === 'remote_status')
    ok(!off.status.enabled && !off.status.listening && !off.status.pairUrl, `off: ${JSON.stringify(off.status)}`)
    desk.clear()
    desk.send({ t: 'remote_set', enabled: true })
    const on = await desk.next((m) => m.t === 'remote_status' && m.status.listening)
    ok(on.status.pairUrl?.startsWith('waifufy-code://pair?'), 'pair url')
    pair = new URL(on.status.pairUrl)
    ok(pair.searchParams.get('p') === '47920' && pair.searchParams.get('t').length > 20, 'port and token')
  })

  await test('a phone without the pairing token is refused; the desktop token is not enough', async () => {
    let err
    await client(`ws://127.0.0.1:47920/?token=${TOKEN}`).catch((e) => (err = e))
    ok(err?.message.includes('401'), `refused: ${err?.message}`)
  })

  const t = () => pair.searchParams.get('t')
  let phone
  await test('a paired phone connects, says hello without ending the desktop session, and may not manage phone access', async () => {
    desk.send({ t: 'trust_accept', cwd: project })
    await desk.next((m) => m.t === 'trust' && m.trusted)
    desk.send({ t: 'start', epoch: 1, cwd: project })
    await desk.next((m) => m.t === 'ready' && m.epoch === 1, 10_000)
    phone = await client(`ws://127.0.0.1:47920/?token=${encodeURIComponent(t())}`)
    phone.send({ t: 'hello' })
    const hello = await phone.next((m) => m.t === 'hello')
    ok(hello.remote === true, 'the phone is told it is remote')
    await sleep(300)
    ok(!desk.got.some((m) => m.t === 'ended'), 'the desktop session still runs')
    phone.send({ t: 'remote_set', enabled: false })
    const err = await phone.next((m) => m.t === 'app_error')
    ok(err.message.includes('desktop'), err.message)
  })

  await test('attach replays the session: started with history, ready, stats, and an open prompt', async () => {
    desk.send({ t: 'say', text: 'permission please' })
    const ask = await desk.next((m) => m.t === 'ask_permission', 10_000)
    phone.clear()
    phone.send({ t: 'attach' })
    const att = await phone.next((m) => m.t === 'attached')
    ok(att.epoch === 1, `epoch ${att.epoch}`)
    const started = await phone.next((m) => m.t === 'started')
    ok(started.cwd === project && started.epoch === 1, 'started')
    await phone.next((m) => m.t === 'ready' && m.epoch === 1)
    await phone.next((m) => m.t === 'stats')
    const replayed = await phone.next((m) => m.t === 'ask_permission')
    ok(replayed.id === ask.id, 'the same prompt')
  })

  await test('answering on the phone closes the prompt on the desktop', async () => {
    const ask = desk.got.find((m) => m.t === 'ask_permission')
    desk.clear()
    phone.send({ t: 'permission', id: ask.id, decision: 'allow' })
    const cancel = await desk.next((m) => m.t === 'ask_cancel')
    ok(cancel.id === ask.id && cancel.epoch === 1, 'cancelled on the desktop')
    await desk.next((m) => m.t === 'turn_end', 15_000)
  })

  await test('nothing running: attach says so', async () => {
    desk.send({ t: 'end' })
    await desk.next((m) => m.t === 'ended')
    phone.clear()
    phone.send({ t: 'attach' })
    const att = await phone.next((m) => m.t === 'attached')
    ok(att.epoch === undefined, 'no epoch')
  })

  await test('a new pairing token drops connected phones', async () => {
    const closed = new Promise((r) => phone.ws.on('close', (code) => r(code)))
    desk.send({ t: 'remote_reset' })
    ok((await closed) === 4001, 'closed as unpaired')
    let err
    await client(`ws://127.0.0.1:47920/?token=${encodeURIComponent(t())}`).catch((e) => (err = e))
    ok(err?.message.includes('401'), 'the old token is refused')
  })

  await test('turning it off stops the listener', async () => {
    desk.clear()
    desk.send({ t: 'remote_set', enabled: false })
    await desk.next((m) => m.t === 'remote_status' && !m.status.listening)
    let err
    await fetch('http://127.0.0.1:47920/health').catch((e) => (err = e))
    ok(err, 'nothing listens')
  })
} finally {
  link.stdin.end()
  link.kill()
}

if (failures) console.log(`\n--- link log ---\n${linkLog.slice(-3000)}`)
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
