// Does the real model judge your words? Two Haiku turns against the real Agent SDK: praise must raise
// affection (one `affection` event, no tag in the text), a plain request must not. Run by hand:
//
//   node tests/e2e/real-affection.mjs
//
// Guard: the session must report Haiku before anything is sent.

import { launch, stopVite } from './driver.mjs'
import { makeProject, newGame, readAll, removeTempDirs, say, turnEnd } from './lib.mjs'

const TURN_MS = 120_000
let failed = 0
const check = (ok, what, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`)
}

let app
try {
  app = await launch({ mock: false, settings: { claude: { model: 'haiku' } }, tag: 'real-affection' })
  const m0 = await app.mark()
  await newGame(app, makeProject('real-affection'))
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
    const reply = events.filter((e) => e.t === 'text').map((e) => e.delta).join('')
    return { felt: events.filter((e) => e.t === 'affection').map((e) => e.delta), reply }
  }

  const praise = await turn('Thank you so much, you did a wonderful job today! Just reply briefly, no tools.')
  check(praise.felt.length === 1 && praise.felt[0] === 1, 'praise raises affection once', `events: ${praise.felt} · "${praise.reply.slice(0, 90)}"`)
  check(!/\[affection/.test(praise.reply), 'no tag reaches the text')

  const plain = await turn('What is 2 + 2? One word, no tools.')
  check(plain.felt.length === 0, 'a plain question leaves it alone', `events: ${plain.felt} · "${plain.reply.slice(0, 60)}"`)
} catch (e) {
  check(false, 'the run stopped', e.message.split('\n')[0])
} finally {
  await app?.close?.()
  stopVite()
  removeTempDirs()
}
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
