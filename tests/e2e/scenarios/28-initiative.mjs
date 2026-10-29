// She messages first (docs/V0.7.2.md R83, R84, R86) against the mock link, with her clock sped up
// (WC_INITIATIVE_SCALE): a moment of hers comes in milliseconds, while the gap between her messages stays real.
// The mock's own turn says "Hey… are you still there?" and "I was just thinking about you." as two messages.
// R85 (a draft left for 20 minutes, a long silence) is on a fake clock in tests/unit/initiative.test.mjs.
import { assert, fastText, focusInput, newGame, readAll, say, T, turnEnd } from '../lib.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const OWN = /are you still there/

/** Her streamed text since `from`, once it matches `re`. */
async function waitHer(app, from, re, ms = 20_000) {
  const end = Date.now() + ms
  let text = ''
  while (Date.now() < end) {
    text = (await app.events(from, 'text')).map((e) => e.delta).join('')
    if (re.test(text)) return text
    await sleep(200)
  }
  throw new Error(`no ${re} in her text: ${text}`)
}

async function toCasual(app) {
  const m = await app.mark()
  await app.click(T('chat-mode'))
  await app.waitEvent('chat_mode', { mode: 'casual' }, m)
}

const shows = (app, re) => app.eval((src) => new RegExp(src).test(document.body.innerText), re.source)

export default {
  name: 'She messages first: her own lines in casual mode, holding while you type, never in work mode',
  launch: { env: { WC_INITIATIVE_SCALE: '0.0002' } },
  tests: [
    {
      r: 'R83',
      name: 'in casual mode she sends her own messages after a reply, shown like any line of hers',
      async run({ app, project }) {
        await newGame(app, project)
        await fastText(app)
        await toCasual(app)
        const m = await say(app, 'hi there')
        await turnEnd(app, m)
        const text = await waitHer(app, m, /thinking about you/)
        assert(!/<feel|<quiet|\[smile\]/.test(text), `nothing hidden leaks: ${text}`)
        // Her lines queue behind the page on screen, like any of hers: read through to the last one. On her sped-up
        // clock the next pair may already have begun, so either of her two lines can be the last.
        const shown = await readAll(app)
        assert(/thinking about you|are you still there/.test(shown.text), `her last line on screen: ${shown.text}`)
      },
    },
    {
      r: 'R84',
      name: 'a draft in the box sends typing and holds her; clearing it lets her go on',
      async run({ app, project }) {
        await newGame(app, project)
        await fastText(app)
        await toCasual(app)
        const m = await say(app, 'hi there')
        await turnEnd(app, m)
        await waitHer(app, m, OWN)
        await sleep(4000) // her second message, already on its way, lands first
        const n = await app.mark()
        await focusInput(app)
        await app.type('still writing this')
        await app.waitSent('typing', { on: true }, n)
        const held = await app.mark()
        await sleep(3000)
        const during = (await app.events(held, 'text')).map((e) => e.delta).join('')
        assert(!OWN.test(during), `she spoke while you typed: ${during}`)
        await app.eval(() => {
          const ta = document.querySelector('[data-test="chat-input"]')
          ta.value = ''
          ta.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await app.waitSent('typing', { on: false }, held)
        await waitHer(app, held, OWN)
      },
    },
    {
      r: 'R86',
      name: 'in work mode she never messages first',
      async run({ app, project }) {
        await newGame(app, project)
        await fastText(app)
        const m = await say(app, 'hello')
        await turnEnd(app, m)
        await sleep(3000)
        const text = (await app.events(m, 'text')).map((e) => e.delta).join('')
        assert(!OWN.test(text), `she messaged first in work mode: ${text}`)
        assert(!(await shows(app, OWN)), 'nothing of hers on screen')
      },
    },
  ],
}
