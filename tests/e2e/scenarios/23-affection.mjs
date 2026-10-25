// Affection and rest (docs/V0.5.md R68–R70): her verdict on your words moves the points, the hearts are
// levels that cost more each, and every message carries her mood (and, after hours open, a rest reminder).
import { assert, eq, fastText, newGame, readAll, say, T, turnEnd } from '../lib.mjs'

const points = (app) => app.eval(() => Number(document.querySelector('[data-test="hearts"]').dataset.points))
const level = (app) => app.eval(() => Number(document.querySelector('[data-test="hearts"]').dataset.count))

/** Sends `text`, waits out her reply, and returns the `say` the app sent. */
async function talk(app, text) {
  const m = await say(app, text)
  await turnEnd(app, m)
  await readAll(app)
  return { m, sent: (await app.sent(m, 'say')).find((s) => s.text === text) }
}

export default {
  name: 'Affection: praise, unkind words, hearts that cost more, rest reminders',
  async setup({ app, project }) {
    await newGame(app, project)
    await fastText(app)
  },
  tests: [
    {
      r: 'R68',
      name: 'praise earns a point and an unkind word costs one; finishing a task alone earns nothing',
      timeout: 90_000,
      async run({ app }) {
        eq(await points(app), 0, 'a new game starts at 0')
        const first = await talk(app, 'use some tools please')
        eq(await points(app), 0, 'a finished task is not praise')
        eq(first.sent.mood?.level, 0, 'the message carries her level')
        const { m } = await talk(app, 'good job on that')
        await app.waitEvent('affection', { delta: 1 }, m)
        await app.waitFor(() => document.querySelector('[data-test="hearts"]').dataset.points === '1', { label: '1 point' })
        const saved = (await app.sent(m, 'save_meta')).some((s) => s.patch?.affectionPts === 1)
        assert(saved, 'the points are saved')
        await talk(app, 'you are useless')
        await app.waitFor(() => document.querySelector('[data-test="hearts"]').dataset.points === '0', { label: 'back to 0' })
        await talk(app, 'you are useless')
        eq(await points(app), 0, 'never below 0')
      },
    },
    {
      r: 'R68',
      name: 'the first heart takes 3 praises; the level-up shows, and her next message is told it rose',
      timeout: 120_000,
      async run({ app }) {
        for (const text of ['thank you', 'well done', 'good job']) await talk(app, text)
        eq(await points(app), 3, '3 points')
        eq(await level(app), 1, 'one full heart')
        await app.waitText('#toast', /affection rose to 1\/5/, { label: 'the level-up toast' })
        assert(/toward the next heart/.test(await app.attr(T('hearts'), 'title')), 'the gauge tells how far the next heart is')
        const next = await talk(app, 'what next?')
        eq(next.sent.mood?.level, 1, 'level 1')
        eq(next.sent.mood?.change, 'up', 'she is told it rose')
        const after = await talk(app, 'and then?')
        eq(after.sent.mood?.change, undefined, 'only once')
      },
    },
    {
      r: 'R70',
      name: 'after the app has been open long enough, her next message carries a rest reminder, then not again for as long',
      timeout: 60_000,
      async run({ app }) {
        const before = await talk(app, 'hello there')
        eq(before.sent.mood?.restAfterMs, undefined, 'no reminder early on')
        // The real interval is 3 h; the harness shortens it.
        await app.eval(() => (window.__wcRestEveryMs = 1))
        const due = await talk(app, 'keep going')
        assert(due.sent.mood?.restAfterMs > 0, 'the reminder is due')
        await app.eval(() => (window.__wcRestEveryMs = 60 * 60_000))
        const later = await talk(app, 'one more')
        eq(later.sent.mood?.restAfterMs, undefined, 'not again right away')
        await app.eval(() => delete window.__wcRestEveryMs)
      },
    },
  ],
}
