// A phone that joins (or re-joins) the desktop's running session gets all of it: what was said on either side, every
// tool she ran, the prompts still open (and not the ones already answered), and a dead phone socket is dropped so its
// next connection starts clean. Against a real link process in mock mode.
// Run: node tests/unit/continuity.test.mjs (no app, no Claude). Uses phone port 47933, so it runs beside the installed app.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(new URL('../../link/package.json', import.meta.url))
const { WebSocket } = require('ws')

const dir = mkdtempSync(join(tmpdir(), 'wc-cont-'))
const project = join(dir, 'project')
mkdirSync(project)
const PHONE_TOKEN = 'phone-token-for-the-continuity-test'
writeFileSync(join(dir, 'remote.json'), JSON.stringify({ enabled: true, token: PHONE_TOKEN }))
const PORT = 47991
const TOKEN = 'desktop-token'
const link = spawn(process.execPath, ['link/src/server.ts'], {
  cwd: new URL('../..', import.meta.url),
  env: { ...process.env, WC_PORT: String(PORT), WC_TOKEN: TOKEN, WC_DATA_DIR: dir, WC_REMOTE_PORT: '47933', WC_MOCK: '1', WC_MOCK_TICK_MS: '2', WC_PING_MS: '300', WC_TRUST_FOLDERS: dir },
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

function client(url, opts) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts)
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
        next: (pred, ms = 8000) => {
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

const phoneUrl = `ws://127.0.0.1:47933/?token=${encodeURIComponent(PHONE_TOKEN)}`

/** A phone that joins: hello, attach, and the whole replay. */
async function join_() {
  const phone = await client(phoneUrl)
  phone.send({ t: 'hello' })
  await phone.next((m) => m.t === 'hello')
  phone.send({ t: 'attach' })
  await phone.next((m) => m.t === 'attached')
  return phone
}

try {
  await waitUp()
  for (let i = 0; i < 50; i++) {
    if (await fetch('http://127.0.0.1:47933/health').then((r) => r.ok, () => false)) break
    await sleep(100)
  }
  const desk = await client(`ws://127.0.0.1:${PORT}/?token=${TOKEN}`)
  desk.send({ t: 'hello' })
  await desk.next((m) => m.t === 'hello')
  desk.send({ t: 'start', epoch: 7, cwd: project })
  await desk.next((m) => m.t === 'ready' && m.epoch === 7, 15_000)

  // A turn with tools, then one with a prompt that the desktop answers.
  desk.send({ t: 'say', text: 'tools please' })
  await desk.next((m) => m.t === 'turn_end', 30_000)
  const deskTools = desk.got.filter((m) => m.t === 'tool').map((m) => m.id)

  await test('a phone joining mid-session gets every tool she ran, done, as one replay', async () => {
    const phone = await join_()
    const replay = await phone.next((m) => m.t === 'replay')
    ok(replay.epoch === 7, `epoch ${replay.epoch}`)
    const tools = replay.events.filter((e) => e.t === 'tool').map((e) => e.id)
    ok(deskTools.length > 2 && JSON.stringify(tools) === JSON.stringify(deskTools), `tools ${tools} vs ${deskTools}`)
    const done = new Set(replay.events.filter((e) => e.t === 'tool_done').map((e) => e.id))
    ok(deskTools.every((id) => done.has(id)), 'every tool is done in the replay')
    phone.ws.close()
  })

  await test('the replay carries what was said and her reply, text coalesced', async () => {
    const phone = await join_()
    const { events } = await phone.next((m) => m.t === 'replay')
    const said = events.find((e) => e.t === 'said')
    ok(said?.text === 'tools please', `said: ${JSON.stringify(said)}`)
    const texts = events.filter((e) => e.t === 'text')
    const deskTexts = desk.got.filter((m) => m.t === 'text')
    ok(texts.length > 0 && texts.length < deskTexts.length, `coalesced ${texts.length} < ${deskTexts.length}`)
    ok(texts.map((e) => e.delta).join('') === deskTexts.map((m) => m.delta).join(''), 'the same text')
    ok(events.some((e) => e.t === 'turn_end'), 'the turn ended')
    phone.ws.close()
  })

  await test('what one window says reaches the other as said, and is not echoed back', async () => {
    const phone = await join_()
    await phone.next((m) => m.t === 'replay')
    desk.clear()
    phone.clear()
    phone.send({ t: 'say', text: 'hello from the phone' })
    const seen = await desk.next((m) => m.t === 'said')
    ok(seen.text === 'hello from the phone' && seen.epoch === 7, JSON.stringify(seen))
    await desk.next((m) => m.t === 'turn_end', 30_000)
    ok(!phone.got.some((m) => m.t === 'said'), 'not echoed to the sender')
    phone.ws.close()
  })

  await test('an open prompt is replayed to a joining phone; once answered, it is not', async () => {
    desk.clear()
    desk.send({ t: 'say', text: 'permission please' })
    const ask = await desk.next((m) => m.t === 'ask_permission', 15_000)
    // Open prompts follow the replay as their own messages, as they came.
    const open = async (p) => {
      await p.next((m) => m.t === 'replay')
      await sleep(300)
      const after = p.got.slice(p.got.findIndex((m) => m.t === 'replay') + 1)
      return after.filter((m) => m.t === 'ask_permission').map((m) => m.id)
    }
    const p1 = await join_()
    const o1 = await open(p1)
    ok(JSON.stringify(o1) === JSON.stringify([ask.id]), `open after the replay: ${o1}`)
    p1.ws.close()
    desk.send({ t: 'permission', id: ask.id, decision: 'allow' })
    await desk.next((m) => m.t === 'turn_end', 30_000)
    const p2 = await join_()
    const o2 = await open(p2)
    ok(o2.length === 0, `answered prompt replayed: ${o2}`)
    p2.ws.close()
  })

  await test('nothing from the session reaches a joining phone between attached and the replay (no double events)', async () => {
    desk.clear()
    desk.send({ t: 'say', text: 'long please' })
    await desk.next((m) => m.t === 'text' && m.epoch === 7, 15_000)
    const phone = await client(phoneUrl)
    phone.send({ t: 'hello' })
    await phone.next((m) => m.t === 'hello')
    phone.send({ t: 'attach' })
    await phone.next((m) => m.t === 'replay', 15_000)
    const from = phone.got.findIndex((m) => m.t === 'attached')
    const to = phone.got.findIndex((m) => m.t === 'replay')
    const between = phone.got.slice(from + 1, to).filter((m) => !['started'].includes(m.t)).map((m) => m.t)
    ok(between.length === 0, `between attached and replay: ${between.join(', ')}`)
    await desk.next((m) => m.t === 'turn_end', 30_000)
    phone.ws.close()
  })

  await test('a phone socket that stops answering pings is dropped', async () => {
    const dead = await client(phoneUrl, { autoPong: false })
    const closed = new Promise((r) => dead.ws.on('close', () => r(true)))
    const t = await Promise.race([closed, sleep(3000).then(() => false)])
    ok(t, 'the dead phone is still connected after 3 s')
  })
} finally {
  link.stdin.end()
  link.kill()
}

if (failures) console.log(`\n--- link log ---\n${linkLog.slice(-3000)}`)
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
