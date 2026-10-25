// Does the real model write good voice lines? Two Haiku turns against the real Agent SDK with a dummy Fish
// Audio key, which turns the persona's Japanese voice lines on (the clips themselves fail with a 401 and the
// text goes on unvoiced: that path is checked too). Run by hand, and read the lines it prints:
//
//   node tests/e2e/real-voice.mjs
//
// With a real key in FISH_API_KEY the clips are fetched for real instead.

import { launch, stopVite } from './driver.mjs'
import { makeProject, newGame, readAll, removeTempDirs, say, turnEnd } from './lib.mjs'

const TURN_MS = 120_000
const JAPANESE = /[぀-ヿ一-鿿]/
let failed = 0
const check = (ok, what, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`)
}

let app
try {
  app = await launch({ mock: false, settings: { claude: { model: 'haiku' } }, tag: 'real-voice' })
  await app.eval((key) => window.__wc.link.send({ t: 'voice_key', key }), process.env.FISH_API_KEY || 'dummy-key-for-the-persona')
  await app.waitFor(() => window.__wc.store !== undefined, { label: 'app up' })
  const m0 = await app.mark()
  await newGame(app, makeProject('real-voice'))
  const model = await app.waitFor(
    (f) => window.__e2e.events.slice(f).filter((e) => e.t === 'stats').map((e) => e.stats.model).find((x) => /haiku/i.test(x ?? '')),
    { args: [m0.events], timeout: 20_000, label: 'stats.model to report Haiku' },
  )
  check(Boolean(model), 'session on Haiku before sending', model)

  const turn = async (text) => {
    const m = await say(app, text)
    await turnEnd(app, m, TURN_MS)
    await readAll(app)
    const events = await app.events(m)
    return {
      lines: events.filter((e) => e.t === 'voice').map((e) => e.text),
      text: events.filter((e) => e.t === 'text').map((e) => e.delta).join(''),
    }
  }

  const a = await turn('Hi Rem! Please greet me in two short paragraphs, and tell me you are ready to help. No tools.')
  for (const l of a.lines) console.log(`      ja: ${l}`)
  check(a.lines.length >= 1, 'she writes Japanese voice lines', `${a.lines.length} lines`)
  check(a.lines.every((l) => JAPANESE.test(l)), 'the lines are Japanese')
  check(!/<\/?ja>/.test(a.text), 'no <ja> reaches the text')
  check(/[A-Za-z]{3}/.test(a.text), 'the text stays English', a.text.replace(/\s+/g, ' ').slice(0, 80))
  check(a.lines.some((l) => l.includes('レム')), 'she calls herself レム (soft)')
  check(a.lines.every((l) => /です|ます|ください|ね|よ/.test(l)), 'polite endings')

  const b = await turn('What is 12 * 12? Reply in one short sentence, no tools.')
  for (const l of b.lines) console.log(`      ja: ${l}`)
  check(b.lines.length >= 1 && b.lines.length <= 2, 'one short answer, one or two lines', `${b.lines.length}`)
  // LOG entries are drawn while the LOG is open.
  await app.key('Ctrl+O')
  await app.waitVisible('[data-test="log"]')
  const voiceLog = (await app.texts('[data-test="log-entry"]')).join('\n')
  await app.key('Escape')
  if (!process.env.FISH_API_KEY) check(/Voice: /.test(voiceLog), 'a dummy key fails quietly: a LOG line, the text goes on')
} catch (e) {
  check(false, 'the run stopped', e.message.split('\n')[0])
} finally {
  await app?.close?.()
  stopVite()
  removeTempDirs()
}
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
