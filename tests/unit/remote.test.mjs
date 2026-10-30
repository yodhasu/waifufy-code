// Phone access, end to end against a real link process in mock mode: off by default, the desktop turns it on and
// gets the pairing link, a phone needs that token, a phone's hello leaves the desktop's session running, `attach`
// replays the session, an answer from one window closes the prompt in the other, and the desktop can unpair.
// Run: node tests/unit/remote.test.mjs (no app, no Claude). Uses phone port 47934, so it runs beside the installed app.
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
  env: { ...process.env, WC_PORT: String(PORT), WC_TOKEN: TOKEN, WC_DATA_DIR: dir, WC_REMOTE_PORT: '47934', WC_MOCK: '1' },
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
    ok(pair.searchParams.get('p') === '47934' && pair.searchParams.get('t').length > 20, 'port and token')
  })

  await test('a phone without the pairing token is refused; the desktop token is not enough', async () => {
    let err
    await client(`ws://127.0.0.1:47934/?token=${TOKEN}`).catch((e) => (err = e))
    ok(err?.message.includes('401'), `refused: ${err?.message}`)
  })

  const t = () => pair.searchParams.get('t')
  let phone
  let device
  await test('a paired phone connects, says hello without ending the desktop session, and may not manage phone access', async () => {
    desk.send({ t: 'trust_accept', cwd: project })
    await desk.next((m) => m.t === 'trust' && m.trusted)
    desk.send({ t: 'start', epoch: 1, cwd: project })
    await desk.next((m) => m.t === 'ready' && m.epoch === 1, 10_000)
    phone = await client(`ws://127.0.0.1:47934/?token=${encodeURIComponent(t())}&device`)
    // Paired with the code: it gets a token of its own at once.
    device = (await phone.next((m) => m.t === 'paired')).token
    ok(device && device !== t(), 'a device token of its own')
    phone.send({ t: 'hello' })
    const hello = await phone.next((m) => m.t === 'hello')
    ok(hello.remote === true, 'the phone is told it is remote')
    ok(Array.isArray(hello.addresses), 'the phone is told the computer\'s addresses')
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

  await test('the computer says whether it takes a token (/paired); an app without device tokens gets none', async () => {
    const paired = (tok) => fetch(`http://127.0.0.1:47934/paired?token=${encodeURIComponent(tok)}`).then((r) => r.status)
    ok((await paired(device)) === 200, 'the device token is taken')
    ok((await paired('nope')) === 401, 'an unknown token is refused')
    desk.clear()
    desk.send({ t: 'remote_status' })
    const before = (await desk.next((m) => m.t === 'remote_status')).status.devices.length
    const old = await client(`ws://127.0.0.1:47934/?token=${encodeURIComponent(t())}`)
    await sleep(300)
    ok(!old.got.some((m) => m.t === 'paired'), 'no device token for an older app')
    old.ws.close()
    desk.clear()
    desk.send({ t: 'remote_status' })
    ok((await desk.next((m) => m.t === 'remote_status')).status.devices.length === before, 'no device added')
  })

  await test('a new pairing code keeps paired phones: the old code is refused, the device token still works', async () => {
    const oldCode = t()
    desk.clear()
    desk.send({ t: 'remote_reset' })
    // A late status from an earlier connection can come first: wait for the one with the new code.
    const st = await desk.next((m) => m.t === 'remote_status' && new URL(m.status.pairUrl).searchParams.get('t') !== oldCode)
    pair = new URL(st.status.pairUrl)
    ok(t() !== oldCode, 'a new code')
    await sleep(300)
    ok(phone.ws.readyState === 1, 'the paired phone stays connected')
    let err
    await client(`ws://127.0.0.1:47934/?token=${encodeURIComponent(oldCode)}`).catch((e) => (err = e))
    ok(err?.message.includes('401'), 'the old code is refused')
    const again = await client(`ws://127.0.0.1:47934/?token=${encodeURIComponent(device)}`)
    again.ws.close()
    const listed = st.status.devices
    ok(listed.length === 1 && listed[0].online && !('token' in listed[0]), `listed without its token: ${JSON.stringify(listed)}`)
  })

  await test('removing a device disconnects it as unpaired and refuses its token', async () => {
    const id = (await (desk.clear(), desk.send({ t: 'remote_status' }), desk.next((m) => m.t === 'remote_status'))).status.devices[0].id
    const codeBefore = t()
    const closed = new Promise((r) => phone.ws.on('close', (code) => r(code)))
    desk.send({ t: 'remote_forget', id })
    ok((await closed) === 4001, 'closed as unpaired')
    const paired = (tok) => fetch(`http://127.0.0.1:47934/paired?token=${encodeURIComponent(tok)}`).then((r) => r.status)
    ok((await paired(codeBefore)) === 401, 'the code changed too: a link saved on the removed phone is refused')
    let err
    await client(`ws://127.0.0.1:47934/?token=${encodeURIComponent(device)}`).catch((e) => (err = e))
    ok(err?.message.includes('401'), 'its token is refused')
  })

  await test('turning it off stops the listener', async () => {
    desk.clear()
    desk.send({ t: 'remote_set', enabled: false })
    await desk.next((m) => m.t === 'remote_status' && !m.status.listening)
    let err
    await fetch('http://127.0.0.1:47934/health').catch((e) => (err = e))
    ok(err, 'nothing listens')
  })
} finally {
  link.stdin.end()
  link.kill()
}

if (failures) console.log(`\n--- link log ---\n${linkLog.slice(-3000)}`)
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
