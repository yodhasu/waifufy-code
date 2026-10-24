// V0.5 prompt and turn parity with the CLI (docs/V0.5.md R65–R67): keys, suggestions, @agents, Focus mode,
// the CLI's spinner and completion lines, notifications.
import { assert, eq, fastText, focusInput, newGame, readAll, say, sleep, T, turnEnd } from '../lib.mjs'

const inputValue = (app) => app.eval(() => document.querySelector('[data-test="chat-input"]').value)

async function freshChat(app, cwd) {
  await newGame(app, cwd)
  await fastText(app)
}

export default {
  name: 'CLI parity: prompt keys, Focus mode, spinner, notifications',
  tests: [
    {
      r: 'R65',
      name: 'Ctrl+J adds a newline, Ctrl+L clears the prompt, Ctrl+Enter while she works sends now',
      timeout: 60_000,
      async run({ app, project }) {
        await freshChat(app, project)
        await focusInput(app)
        await app.type('first line')
        await app.key('Ctrl+J')
        await app.type('second')
        eq(await inputValue(app), 'first line\nsecond', 'Ctrl+J newline')
        await app.key('Ctrl+L')
        eq(await inputValue(app), '', 'Ctrl+L clears')
        const m = await say(app, 'a slow build please')
        await app.waitVisible(T('spinner'), 10_000)
        await app.type('also check the docs')
        await app.key('Ctrl+Enter')
        await app.waitSent('say', { text: 'also check the docs', now: true }, m)
        await turnEnd(app, m, 120_000)
      },
    },
    {
      r: 'R65',
      name: 'a prompt suggestion shows on the empty prompt and Tab takes it; @ lists agents as @agent-<name>',
      timeout: 60_000,
      async run({ app, project }) {
        await freshChat(app, project)
        const m = await say(app, 'suggest what to do next')
        await turnEnd(app, m)
        await app.waitFor(() => /run the tests and fix what fails/.test(document.querySelector('[data-test="chat-input"]').placeholder), { label: 'the suggestion as the placeholder' })
        await focusInput(app)
        await app.key('Tab')
        eq(await inputValue(app), 'run the tests and fix what fails', 'Tab takes it')
        await app.key('Ctrl+L')
        await app.typeKeys('@expl')
        await app.waitVisible(T('at-popup'))
        await app.waitFor(() => [...document.querySelectorAll('[data-test="at-item"]')].some((el) => el.dataset.path === 'agent-Explore'), { label: 'the Explore agent row' })
        // Leave the composer empty for the next test.
        await app.key('Escape')
        await app.key('Ctrl+L')
      },
    },
    {
      r: 'R66',
      name: 'Focus mode (/focus, the FOCUS button): lines appear whole, the stage quiets down, and it remembers',
      timeout: 60_000,
      async run({ app, project }) {
        await newGame(app, project)
        // Typewriter on, slow: in Focus mode it must not matter.
        await app.updateSettings({ motion: { textCps: 4 } })
        await focusInput(app)
        await app.type('/focus on ')
        await app.key('Enter')
        await app.waitFor(() => document.documentElement.dataset.focus === '1', { label: 'focus on' })
        assert(await app.eval(() => document.querySelector('[data-test="qm-focus"]').classList.contains('on')), 'the button shows it')
        const m = await say(app, 'show me your emotions')
        await turnEnd(app, m)
        await sleep(300)
        const st = await app.eval(() => ({ text: document.querySelector('[data-test="dialogue-text"]').textContent }))
        assert(st.text.length > 20, `the line is there at once: "${st.text}"`)
        await app.click(T('qm-focus'))
        await app.waitFor(() => !document.documentElement.dataset.focus, { label: 'focus off' })
        await readAll(app)
      },
    },
    {
      r: 'R67',
      name: 'the spinner reads like the CLI ("✻ Verb… (Ns · ↓ N tokens · thinking)") and a finished turn logs "<Verb> for Ns"',
      timeout: 60_000,
      async run({ app, project }) {
        await freshChat(app, project)
        const m = await say(app, 'use some tools please')
        await app.waitVisible(T('spinner'), 10_000)
        const s = await app.text(T('spinner'))
        assert(/^✻ [A-Z][\w'-é]+… \(\d+s · ↓ [\d.]+k? tokens/.test(s.trim()), `the CLI line: "${s}"`)
        await turnEnd(app, m)
        await app.key('Ctrl+O')
        await app.waitVisible(T('log'))
        const all = (await app.texts(T('log-entry'))).join('\n')
        assert(/✻ (Baked|Brewed|Churned|Cogitated|Cooked|Crunched|Sautéed|Worked) for \d+s/.test(all), 'the completion line in the LOG')
        await app.key('Escape')
      },
    },
    {
      r: 'R67',
      name: 'CLI notifications reach the LOG; background tasks are listed',
      timeout: 60_000,
      async run({ app, project }) {
        await freshChat(app, project)
        const m = await say(app, 'run the build in the background')
        await app.waitEvent('notify', {}, m)
        await app.waitEvent('bg_tasks', {}, m)
        await turnEnd(app, m)
        await app.key('Ctrl+O')
        await app.waitVisible(T('log'))
        assert((await app.texts(T('log-entry'))).join('\n').includes('Background tasks running'), 'the notification in the LOG')
        await app.key('Escape')
      },
    },
  ],
}
