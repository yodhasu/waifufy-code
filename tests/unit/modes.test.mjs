// Work and casual mode (link/src/casual/modes.ts) against a real link process in mock mode: switching, a casual
// reply from the mock provider, her offer to switch for a work request, and the in-character refusal (with an
// affection cost on the third try) while work is still running.
// Run: node tests/unit/modes.test.mjs (no app, no model). Needs port 47993 free.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(new URL('../../link/package.json', import.meta.url))
const { WebSocket } = require('ws')

const dir = mkdtempSync(join(tmpdir(), 'wc-modes-'))
const project = join(dir, 'project')
mkdirSync(project)
const PORT = 47993
const TOKEN = 'desktop-token'
const env = { ...process.env, WC_PORT: String(PORT), WC_TOKEN: TOKEN, WC_DATA_DIR: dir, WC_MOCK: '1', WC_MOCK_TICK_MS: '2', WC_TRUST_FOLDERS: dir }
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
        close: () => ws.close(),
        /** The next matching message from now on. */
        next: (pred, ms = 10_000) =>
          new Promise((res, rej) => {
            waiters.push({ pred, resolve: res })
            setTimeout(() => rej(new Error(`timed out; got: ${got.map((x) => x.t).join(', ')}`)), ms)
          }),
        mark: () => got.length,
        since: (at) => got.slice(at),
      }),
    )
    ws.on('error', reject)
  })
}

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok, () => false)) return
    await sleep(100)
  }
  throw new Error(`the link never came up:\n${linkLog}`)
}

/** Her text between two points, joined. */
const textOf = (msgs) => msgs.filter((m) => m.t === 'text' || m.t === 'aside').map((m) => m.delta ?? m.text).join('')

try {
  await waitUp()
  const desk = await client(`ws://127.0.0.1:${PORT}/?token=${TOKEN}`)
  desk.send({ t: 'hello' })
  const hello = await desk.next((m) => m.t === 'hello')
  desk.send({ t: 'start', epoch: 3, cwd: project })
  await desk.next((m) => m.t === 'ready' && m.epoch === 3, 15_000)

  await test('hello says whether a casual key is stored', () => ok(hello.casualKey === false, `casualKey ${hello.casualKey}`))

  await test('switching to casual answers with the mode and a line of hers', async () => {
    const at = desk.mark()
    desk.send({ t: 'chat_mode', mode: 'casual' })
    const m = await desk.next((x) => x.t === 'chat_mode')
    ok(m.mode === 'casual', `mode ${m.mode}`)
    await desk.next((x) => x.t === 'aside')
    ok(/talk for a while/.test(textOf(desk.since(at))), textOf(desk.since(at)))
  })

  await test('a casual message gets a casual reply, with no feel line or tags in the text', async () => {
    const at = desk.mark()
    desk.send({ t: 'say', text: 'how was your day?', mood: { level: 2 } })
    await desk.next((x) => x.t === 'turn_end')
    const text = textOf(desk.since(at))
    ok(text.includes('Casual mock reply to: how was your day?'), text)
    ok(!/<feel|\[smile\]/.test(text), `leaked: ${text}`)
    ok(desk.since(at).some((x) => x.t === 'face'), 'a face played')
    ok(!desk.since(at).some((x) => x.t === 'offer_mode'), 'no offer for small talk')
  })

  await test('her heart and journal were written', async () => {
    await sleep(300)
    ok(existsSync(join(dir, 'heart', 'rem.json')), 'heart file')
    const journal = readFileSync(join(dir, 'memory', 'rem', 'journal.jsonl'), 'utf8').trim().split('\n')
    ok(journal.length === 1 && JSON.parse(journal[0]).you === 'how was your day?', journal.join('\n'))
  })

  await test('a work request in casual mode gets an offer to switch, carrying the message', async () => {
    desk.send({ t: 'say', text: 'can you fix the bug in the login page', mood: { level: 2 } })
    const offer = await desk.next((x) => x.t === 'offer_mode')
    ok(offer.mode === 'work' && offer.text.includes('fix the bug'), JSON.stringify(offer))
  })

  await test('back to work: work messages reach the work session again', async () => {
    desk.send({ t: 'chat_mode', mode: 'work' })
    const m = await desk.next((x) => x.t === 'chat_mode')
    ok(m.mode === 'work', `mode ${m.mode}`)
    await desk.next((x) => x.t === 'aside')
    const at = desk.mark()
    desk.send({ t: 'say', text: 'hello' })
    await desk.next((x) => x.t === 'turn_end', 20_000)
    ok(!textOf(desk.since(at)).includes('Casual mock reply'), 'the work mock answered')
  })

  await test('while work runs, switching is refused in character, and the third try costs affection', async () => {
    desk.send({ t: 'say', text: 'slow build please' })
    await desk.next((x) => x.t === 'state' && x.state === 'running', 10_000)
    const at = desk.mark()
    for (let i = 0; i < 3; i++) {
      desk.send({ t: 'chat_mode', mode: 'casual' })
      await desk.next((x) => x.t === 'chat_mode')
    }
    const seen = desk.since(at)
    const modes = seen.filter((x) => x.t === 'chat_mode').map((x) => x.mode)
    ok(modes.every((x) => x === 'work'), `modes ${modes}`)
    const text = textOf(seen)
    ok(/still in the middle of the work/.test(text) && /won't make it go any faster/.test(text), text)
    const hits = seen.filter((x) => x.t === 'affection')
    ok(hits.length === 1 && hits[0].delta === -1, JSON.stringify(hits))
    desk.send({ t: 'interrupt' })
    await desk.next((x) => x.t === 'turn_end', 30_000)
  })

  await test('back to work with compact: she tidies up, and the work session compacts', async () => {
    desk.send({ t: 'chat_mode', mode: 'casual' })
    ok((await desk.next((x) => x.t === 'chat_mode')).mode === 'casual', 'casual')
    const at = desk.mark()
    desk.send({ t: 'chat_mode', mode: 'work', compact: true })
    ok((await desk.next((x) => x.t === 'chat_mode')).mode === 'work', 'work')
    await desk.next((x) => x.t === 'notice' && x.kind === 'compact', 20_000)
    ok(/tidy up my notes/.test(textOf(desk.since(at))), textOf(desk.since(at)))
    await desk.next((x) => x.t === 'turn_end', 20_000)
  })

  await test('back to work without compact keeps the context', async () => {
    desk.send({ t: 'chat_mode', mode: 'casual' })
    await desk.next((x) => x.t === 'chat_mode')
    const at = desk.mark()
    desk.send({ t: 'chat_mode', mode: 'work' })
    await desk.next((x) => x.t === 'aside')
    await sleep(300)
    ok(!desk.since(at).some((x) => x.t === 'notice' && x.kind === 'compact'), 'no compaction')
  })

  await test('a phone that joins learns the current mode', async () => {
    const replay = desk.next((m) => m.t === 'chat_mode', 8000)
    desk.send({ t: 'attach' })
    ok((await replay).mode === 'work', 'mode on attach')
  })
} finally {
  link.stdin.end()
  link.kill()
}

if (failures) console.log(`\n--- link log ---\n${linkLog.slice(-3000)}`)
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
