// R64: the Ctrl+K command palette (search, run a command) and the `?` shortcut sheet (only on an empty prompt).
import { assert, eq, fastText, focusInput, newGame, T } from '../lib.mjs'

const rows = (app) => app.eval(() => [...document.querySelectorAll('[data-test="palette"] [data-test="menu-row"]')].map((b) => b.dataset.id))

async function closeAll(app) {
  for (let i = 0; i < 4 && ((await app.visible(T('palette'))) || (await app.visible(T('shortcuts'))) || (await app.visible(T('help')))); i++) await app.key('Escape')
}

export default {
  name: 'Command palette and shortcut sheet',
  async setup({ app, project }) {
    await newGame(app, project)
    await fastText(app)
  },
  tests: [
    {
      r: 'R64',
      name: 'Ctrl+K opens the palette with the search focused; typing filters; Enter on /help opens the help',
      async run({ app }) {
        await focusInput(app)
        await app.key('Ctrl+K')
        await app.waitVisible(T('palette'))
        await app.waitFor(() => document.activeElement?.dataset.test === 'menu-search', { label: 'search focused' })
        const all = await rows(app)
        assert(all.includes('app:help') && all.includes('app:mcp'), `app commands listed: ${all.length}`)
        assert(all.includes('key:backlog'), 'key actions listed')
        assert(await app.eval(() => document.querySelector('[data-test="palette"] [data-id="key:backlog"]').getAttribute('aria-disabled') === 'true'), 'a key-only action is a hint')
        await app.typeKeys('help')
        await app.waitFor(() => [...document.querySelectorAll('[data-test="palette"] [data-test="menu-row"]')].every((b) => b.textContent.toLowerCase().includes('help')), { label: 'filtered' })
        const shown = await rows(app)
        eq(shown[0], 'app:help', 'the /help row comes first')
        assert(!shown.includes('app:mcp'), 'other commands are filtered out')
        await app.key('Enter')
        await app.waitHidden(T('palette'))
        await app.waitVisible(T('help'))
        await closeAll(app)
        // Most recently used first next time.
        await focusInput(app)
        await app.key('Ctrl+K')
        await app.waitVisible(T('palette'))
        eq((await rows(app))[0], 'app:help', 'the last command used is ranked first')
        await closeAll(app)
        await app.waitHidden(T('palette'))
      },
    },
    {
      r: 'R64',
      name: '`?` on an empty prompt opens the shortcut sheet; Esc closes it',
      async run({ app }) {
        await focusInput(app)
        await app.key('Ctrl+A')
        await app.key('Backspace')
        await app.key('?')
        await app.waitVisible(T('shortcuts'))
        const text = await app.text(T('shortcuts'))
        for (const s of ['for shell mode', 'for commands', 'for file paths', 'to interrupt', 'to skip', 'LOG']) assert(text.includes(s), `the sheet says “${s}”`)
        eq(await app.eval(() => document.querySelector('[data-test="chat-input"]').value), '', 'no ? was typed')
        await app.key('Escape')
        await app.waitHidden(T('shortcuts'))
      },
    },
    {
      r: 'R64',
      name: '`?` inside text is typed, not a shortcut',
      async run({ app }) {
        await focusInput(app)
        await app.key('Ctrl+A')
        await app.key('Backspace')
        await app.typeKeys('why')
        await app.key('?')
        await app.waitFor(() => document.querySelector('[data-test="chat-input"]').value === 'why?', { label: 'the ? is inserted' })
        assert(!(await app.visible(T('shortcuts'))), 'no shortcut sheet')
        await app.key('Ctrl+A')
        await app.key('Backspace')
      },
    },
  ],
}
