// Casual mode (docs/V0.7.md R79–R82) against the mock link, whose casual replies come from a script
// (link/src/casual/providers.ts mockProvider): the Work / Casual switch, a casual reply, her offer to take a work
// request to work mode, the refusal while work runs, and the background-task chip.
import { assert, eq, fastText, newGame, readAll, say, T, turnEnd } from '../lib.mjs'

const chatMode = (app) => app.eval(() => document.querySelector('[data-test="chat-mode"]')?.dataset.chat ?? '')

async function toCasual(app) {
  const m = await app.mark()
  await app.click(T('chat-mode'))
  await app.waitSent('chat_mode', { mode: 'casual' }, m)
  await app.waitEvent('chat_mode', { mode: 'casual' }, m)
  await app.waitFor(() => document.querySelector('[data-test="chat-mode"]')?.dataset.chat === 'casual', { label: 'the switch reads casual' })
}

export default {
  name: 'Casual mode: the switch, casual replies, offers, refusal while working, the background chip',
  tests: [
    {
      r: 'R79',
      name: 'the switch turns casual: her line, the casual placeholder, no permission chip, and a casual reply',
      async run({ app, project }) {
        await newGame(app, project)
        await fastText(app)
        eq(await chatMode(app), 'work', 'starts in work mode')
        await toCasual(app)
        await readAll(app, { timeout: 20_000 })
        assert((await app.eval(() => document.querySelector('[data-test="chat-input"]').placeholder)).startsWith('Chat with'), 'casual placeholder')
        assert(!(await app.eval(() => window.__e2e.visible('[data-test="input-mode-chip"]'))), 'no permission chip in casual mode')
        const m = await say(app, 'how was your day?')
        await turnEnd(app, m)
        const s = await readAll(app, { timeout: 20_000 })
        assert(s.text.includes('Casual mock reply to: how was your day?'), `her reply: ${s.text}`)
        assert(!/<feel|\[smile\]/.test(s.text), `nothing hidden leaks: ${s.text}`)
      },
    },
    {
      r: 'R80',
      name: 'a work request in casual mode offers work mode; Switch sends the message there',
      async run({ app, project }) {
        await newGame(app, project)
        await fastText(app)
        await toCasual(app)
        const m = await say(app, 'please fix the login bug')
        await turnEnd(app, m)
        await app.waitVisible(T('mode-offer'))
        assert((await app.text(T('mode-offer'))).includes('work mode'), 'the offer names work mode')
        const n = await app.mark()
        await app.click(T('mode-offer-yes'))
        // Back to work asks first: compact or keep.
        await app.waitVisible(T('mode-choice'))
        await app.click(T('mode-choice-keep'))
        await app.waitSent('chat_mode', { mode: 'work' }, n)
        await app.waitSent('say', { text: 'please fix the login bug' }, n, 10_000)
        eq(await chatMode(app), 'work', 'back in work mode')
        await turnEnd(app, n)
      },
    },
    {
      r: 'R80',
      name: 'back to work asks compact or keep; Compact with "save as default" compacts and stops asking',
      async run({ app, project }) {
        await newGame(app, project)
        await fastText(app)
        const w = await say(app, 'hello')
        await turnEnd(app, w)
        await toCasual(app)
        for (const text of ['how was your day?', 'mine was long']) await turnEnd(app, await say(app, text))
        let n = await app.mark()
        await app.click(T('chat-mode'))
        await app.waitVisible(T('mode-choice'))
        await app.click(T('mode-choice-remember'))
        await app.click(T('mode-choice-compact'))
        await app.waitSent('chat_mode', { mode: 'work', compact: true }, n)
        await app.waitEvent('notice', { kind: 'compact' }, n, 20_000)
        await app.waitSent('settings_set', undefined, n, 5_000)
        await turnEnd(app, n)
        // Saved: the next return to work compacts without asking.
        await toCasual(app)
        n = await app.mark()
        await app.click(T('chat-mode'))
        await app.waitSent('chat_mode', { mode: 'work', compact: true }, n)
        assert(!(await app.visible(T('mode-choice'))), 'no question once saved')
      },
    },
    {
      r: 'R81',
      name: 'while work runs she refuses to switch, in character, and stays in work mode',
      async run({ app, project }) {
        await newGame(app, project)
        await fastText(app)
        const m = await say(app, 'slow build please')
        await app.waitEvent('state', { state: 'running' }, m)
        const n = await app.mark()
        await app.click(T('chat-mode'))
        await app.waitEvent('chat_mode', { mode: 'work' }, n)
        const lines = (await app.events(n, 'aside')).map((e) => e.text).join('')
        assert(/still in the middle of the work/.test(lines), `her refusal: ${lines}`)
        eq(await chatMode(app), 'work', 'still work mode')
        await app.key('Escape')
        await turnEnd(app, m)
      },
    },
    {
      r: 'R82',
      name: 'a running background task shows as a chip in the party',
      async run({ app, project }) {
        await newGame(app, project)
        await fastText(app)
        const m = await say(app, 'start the background build')
        await app.waitVisible(T('bg-chip'), 20_000)
        assert((await app.text(T('bg-chip'))).includes('in background'), 'the chip text')
        await turnEnd(app, m)
      },
    },
  ],
}
