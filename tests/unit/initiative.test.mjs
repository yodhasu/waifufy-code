// Her own messages (link/src/casual/initiative.ts, v0.7.2): when she might speak, holding while you type, away after a
// draft sits for 20 minutes, and the safety ceiling, on a fake clock; then the whole loop against a real link in mock
// mode, with her clock sped up (WC_INITIATIVE_SCALE).
// Run: node tests/unit/initiative.test.mjs   (no app, no model). Needs port 47994 free.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const I = await import('../../link/src/casual/initiative.ts')
const { traitsFor } = await import('../../link/src/casual/heart.ts')

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
const MIN = 60_000

/** Timers that run only when the test moves time on. */
function fakeClock() {
  let now = 1_000_000_000_000
  let timers = []
  let seq = 0
  return {
    now: () => now,
    set(fn, ms) {
      timers.push({ id: ++seq, at: now + ms, fn })
      return seq
    },
    clear(id) {
      timers = timers.filter((t) => t.id !== id)
    },
    async advance(ms) {
      const end = now + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const t = timers[0]
        if (!t || t.at > end) break
        timers.shift()
        now = t.at
        t.fn()
        for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
      }
      now = end
    },
  }
}

function harness(over = {}) {
  const clock = fakeClock()
  const calls = []
  const st = { allowed: true, typingSince: undefined, heardAt: undefined, result: 'said', ...over }
  const init = new I.Initiative({
    traits: () => st.traits ?? traitsFor('devoted'),
    feelings: () => [0.3, 0, 0, 0, 0],
    level: () => 2,
    allowed: () => st.allowed,
    typingSince: () => st.typingSince,
    lastHeardAt: () => st.heardAt,
    speak: async (m) => (calls.push({ ...m, at: clock.now() }), st.result),
    clock,
    rnd: () => 0.5,
  })
  return { clock, calls, st, init }
}

const calm = { ...traitsFor('devoted'), clingy: 0.1, mask: 0 }
const clingy = { ...calm, clingy: 0.95 }
const proud = { ...calm, mask: 0.8 }
const f0 = [0.2, 0, 0, 0, 0]

await test('a clingy heart speaks sooner than a calm one, and a proud one waits longer', () => {
  const d = (t, feel = f0, un = 0) => I.nextDelayMs(t, feel, 2, un, () => 0.5)
  ok(d(clingy) < 10 * MIN && d(calm) > 30 * MIN, `clingy ${d(clingy) / MIN} min, calm ${d(calm) / MIN} min`)
  ok(d(proud) > d(calm), `proud ${d(proud) / MIN} vs calm ${d(calm) / MIN}`)
  ok(d(calm, [0.2, 0.9, 0, 0, 0]) < d(calm), 'missing them brings it closer')
  ok(d(calm, [0, 0, 0.9, 0, 0]) > d(calm), 'annoyed puts it off')
})

await test('unanswered messages stretch the gap a lot for a calm heart, barely for a clingy one', () => {
  const ratio = (t) => I.nextDelayMs(t, f0, 2, 3, () => 0.5) / I.nextDelayMs(t, f0, 2, 0, () => 0.5)
  ok(ratio(calm) > 4 && ratio(clingy) < 1.5, `calm x${ratio(calm).toFixed(2)}, clingy x${ratio(clingy).toFixed(2)}`)
})

await test('her moment comes, she speaks, and the next one counts what is unanswered', async () => {
  const h = harness()
  h.init.arm()
  await h.clock.advance(6 * 3_600_000)
  ok(h.calls.length >= 2, `calls ${h.calls.length}`)
  ok(h.calls[0].unanswered === 0 && h.calls[1].unanswered === 1, JSON.stringify(h.calls.slice(0, 2)))
  h.init.heard()
  h.init.arm()
  const n = h.calls.length
  await h.clock.advance(6 * 3_600_000)
  ok(h.calls[n]?.unanswered === 0, 'an answer resets it')
})

await test('while you type she holds, and goes on a few seconds after you stop', async () => {
  // Clingy, so her moment (about 5 minutes) comes well inside the 20 minutes a draft may sit.
  const h = harness({ traits: clingy })
  h.st.typingSince = h.clock.now()
  h.init.arm()
  await h.clock.advance(15 * MIN)
  ok(h.calls.length === 0, `spoke while typing: ${h.calls.length}`)
  h.st.typingSince = undefined
  h.init.typingStopped()
  await h.clock.advance(8_000)
  ok(h.calls.length === 1 && !h.calls[0].away, JSON.stringify(h.calls))
})

await test('a draft left for 20 minutes means you are away', async () => {
  const h = harness()
  h.st.typingSince = h.clock.now()
  h.init.arm()
  await h.clock.advance(19 * MIN)
  ok(h.calls.length === 0, 'still typing at 19 minutes')
  await h.clock.advance(2 * 3_600_000)
  ok(h.calls.length >= 1 && h.calls[0].away === true, JSON.stringify(h.calls[0]))
  ok(h.calls[0].at - (h.clock.now() - 2 * 3_600_000 - 19 * MIN) >= I.TYPING_AWAY_MS, 'not before 20 minutes')
})

await test('a long silence is away too, sooner for a clingy heart', async () => {
  ok(I.awayAfterMs(clingy) < I.awayAfterMs(calm), `${I.awayAfterMs(clingy) / MIN} vs ${I.awayAfterMs(calm) / MIN} min`)
  const h = harness({ traits: clingy })
  h.st.heardAt = h.clock.now()
  h.init.arm()
  await h.clock.advance(3 * 3_600_000)
  ok(h.calls.some((c) => !c.away) && h.calls.some((c) => c.away), JSON.stringify(h.calls.map((c) => c.away)))
})

await test('not allowed (work mode, setting off) means never, and no moment is kept', async () => {
  const h = harness({ allowed: false })
  h.init.arm()
  await h.clock.advance(12 * 3_600_000)
  ok(h.calls.length === 0 && !h.init.pending, `calls ${h.calls.length}, pending ${h.init.pending}`)
})

await test('the safety ceiling: never more than 30 of her own turns in an hour', async () => {
  const h = harness({ traits: { ...clingy, clingy: 1, mask: 0 }, result: 'quiet' })
  h.init.arm()
  await h.clock.advance(3 * 3_600_000)
  const first = h.calls[0].at
  const inHour = h.calls.filter((c) => c.at < first + 3_600_000).length
  ok(inHour <= I.MAX_PER_HOUR && h.calls.length > I.MAX_PER_HOUR, `in the first hour ${inHour}, total ${h.calls.length}`)
})

// ---------------------------------------------------------------- the whole loop, in a real link

const require = createRequire(new URL('../../link/package.json', import.meta.url))
const { WebSocket } = require('ws')
const dir = mkdtempSync(join(tmpdir(), 'wc-init-'))
const project = join(dir, 'project')
mkdirSync(project)
const PORT = 47994
const TOKEN = 'desktop-token'
// 1/5000: a 4-minute moment is 48 ms, a 15-second hold check 3 ms. Delays between her messages stay real (1–2.5 s).
const env = { ...process.env, WC_PORT: String(PORT), WC_TOKEN: TOKEN, WC_DATA_DIR: dir, WC_MOCK: '1', WC_MOCK_TICK_MS: '2', WC_TRUST_FOLDERS: dir, WC_INITIATIVE_SCALE: '0.0002' }
delete env.WC_CASUAL_KEY
const link = spawn(process.execPath, ['link/src/server.ts'], { cwd: new URL('../..', import.meta.url), env, stdio: ['pipe', 'pipe', 'pipe'] })
let linkLog = ''
link.stdout.on('data', (d) => (linkLog += d))
link.stderr.on('data', (d) => (linkLog += d))

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
        send: (m) => ws.send(JSON.stringify(m)),
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
const textOf = (msgs) => msgs.filter((m) => m.t === 'text').map((m) => m.delta).join('')
const own = (msgs) => textOf(msgs).includes('are you still there')

try {
  for (let i = 0; i < 100 && !(await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok, () => false)); i++) await sleep(100)
  const desk = await client(`ws://127.0.0.1:${PORT}/?token=${TOKEN}`)
  desk.send({ t: 'hello' })
  await desk.next((m) => m.t === 'hello')
  desk.send({ t: 'start', epoch: 1, cwd: project })
  await desk.next((m) => m.t === 'ready' && m.epoch === 1, 15_000)

  await test('in work mode she never messages first', async () => {
    const at = desk.mark()
    await sleep(1500)
    ok(!own(desk.since(at)), textOf(desk.since(at)))
  })

  await test('in casual mode she messages first: two short messages, as her own lines', async () => {
    desk.send({ t: 'chat_mode', mode: 'casual' })
    await desk.next((x) => x.t === 'chat_mode' && x.mode === 'casual')
    const at = desk.mark()
    desk.send({ t: 'say', text: 'hi there', mood: { level: 2 } })
    await desk.next((x) => x.t === 'turn_end')
    await desk.next(() => own(desk.since(at)), 15_000)
    await desk.next(() => textOf(desk.since(at)).includes('thinking about you'), 15_000)
    const text = textOf(desk.since(at))
    ok(!/<feel|<quiet|\[smile\]/.test(text), `leaked: ${text}`)
  })

  await test('her own messages are journaled as hers, with no line from you', async () => {
    await sleep(300)
    const journal = readFileSync(join(dir, 'memory', 'rem', 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const mine = journal.filter((e) => e.own)
    ok(mine.length >= 1 && mine.every((e) => e.you === '' && e.her), JSON.stringify(journal))
  })

  await test('while you have a draft she holds; she goes on after you clear it', async () => {
    desk.send({ t: 'typing', on: true })
    await sleep(3000) // anything already on its way lands first
    const at = desk.mark()
    await sleep(2500)
    ok(!own(desk.since(at)), `spoke while you typed: ${textOf(desk.since(at))}`)
    desk.send({ t: 'typing', on: false })
    await desk.next(() => own(desk.since(at)), 15_000)
  })

  await test('back to work stops her', async () => {
    desk.send({ t: 'chat_mode', mode: 'work' })
    await desk.next((x) => x.t === 'chat_mode' && x.mode === 'work')
    await sleep(3000)
    const at = desk.mark()
    await sleep(2000)
    ok(!own(desk.since(at)), textOf(desk.since(at)))
  })
} finally {
  link.stdin.end()
  link.kill()
}

if (failures) console.log(`\n--- link log ---\n${linkLog.slice(-3000)}`)
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
