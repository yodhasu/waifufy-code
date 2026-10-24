// R51: the CLI's Settings dialog (/status, /config, /usage, /cost, /stats) and headless /config key=value.
import { assert, eq, fastText, focusInput, newGame, T } from '../lib.mjs'

const DIALOG = T('settings')
const PANE = T('settings-pane')

/** Types a slash command into the chat input and presses Enter. */
async function command(app, text) {
  await focusInput(app)
  await app.type(text)
  await app.key('Enter')
}

/** Opens the dialog with `text` and waits until the tab `tab` is the active one. */
async function open(app, text, tab) {
  await command(app, text)
  await app.waitVisible(DIALOG)
  await app.waitVisible(`${DIALOG} .sp-tab.on[data-tab="${tab}"]`)
}

async function close(app) {
  await app.key('Escape')
  await app.waitHidden(DIALOG)
}

const toastSays = (app, re, label) => app.waitText('#toast', re, { label: label ?? `the toast to say ${re}` })

/** The meta (value) column of a Config row. */
const rowValue = (app, id) => app.text(`${DIALOG} ${T('menu-row', { id })} .mm`)

export default {
  name: 'Settings dialog',
  tests: [
    {
      r: 'R51',
      name: '/status, /config, /usage and /cost open the dialog on their own tabs; Tab and ←/→ switch tabs',
      async run({ app, project }) {
        await newGame(app, project)
        await fastText(app)

        await open(app, '/status', 'Status')
        await app.waitText(PANE, '2.1.309', { label: 'Status shows the CLI version' })
        const status = await app.text(PANE)
        for (const want of ['dev@example.com', 'Example Org', 'Claude Max account', 'MCP servers', 'cwd'])
          assert(status.includes(want), `Status has ${want}: ${status}`)
        await app.key('Tab')
        await app.waitVisible(`${DIALOG} .sp-tab.on[data-tab="Config"]`)
        await app.key('ArrowLeft')
        await app.waitVisible(`${DIALOG} .sp-tab.on[data-tab="Status"]`)
        await close(app)

        await open(app, '/config', 'Config')
        await app.waitVisible(`${DIALOG} ${T('menu-row', { id: 'autoCompact' })}`)
        assert(await app.exists(`${DIALOG} ${T('menu-row', { id: '__app' })}`), 'the Waifufy Code settings row')
        assert(!(await app.exists(`${DIALOG} ${T('menu-row', { id: 'theme' })}`)), 'terminal-only rows (theme) are left out')
        assert(await app.exists(`${DIALOG} ${T('menu-row', { id: 'permissionMode' })}`), 'an enum row')
        await close(app)

        await open(app, '/usage', 'Usage')
        await app.waitText(PANE, 'Total cost', { label: 'Usage shows the session cost' })
        const titles = await app.attrs(`${DIALOG} ${T('usage-bar')}`, 'data-title')
        for (const want of ['Current session', 'Current week (all models)', 'Current week (Fable)'])
          assert(titles.includes(want), `a "${want}" bar (has ${titles})`)
        assert(/12% used/.test(await app.text(PANE)), 'the 5-hour bar is 12% used')
        assert(/Resets/.test(await app.text(PANE)), 'bars show reset times')
        assert(/Usage credits are off/.test(await app.text(PANE)), 'the extra-usage line')
        await close(app)

        await open(app, '/cost', 'Usage')
        await close(app)

        // A trailing space closes the command picker, so the alias as typed reaches the command (the picker's
        // Enter runs the row's main name, /usage).
        await open(app, '/stats ', 'Stats')
        await app.waitText(PANE, /No stats yet|Sessions/, { label: 'Stats shows the cache or an empty state' })
        await close(app)
      },
    },
    {
      r: 'R51',
      name: 'Config: Enter and Space toggle a boolean through /config id=value; an enum opens a picker',
      async run({ app, project }) {
        await newGame(app, project)
        await fastText(app)
        await open(app, '/config', 'Config')
        const row = `${DIALOG} ${T('menu-row', { id: 'autoCompact' })}`
        await app.waitVisible(row)
        const before = (await rowValue(app, 'autoCompact')).trim()
        const flip = before === 'true' ? 'false' : 'true'
        await app.click(row)
        await toastSays(app, `Set Auto-compact to ${flip}`)
        await app.waitFor((s, v) => document.querySelector(s)?.textContent.trim() === v, { args: [`${row} .mm`, flip], label: `the row shows ${flip}` })
        // Space toggles it back (the row keeps the focus after the click).
        await app.key(' ')
        await toastSays(app, `Set Auto-compact to ${before}`)
        await app.waitFor((s, v) => document.querySelector(s)?.textContent.trim() === v, { args: [`${row} .mm`, before], label: `the row shows ${before}` })

        // Type-to-search narrows the rows.
        await app.typeKeys('time format')
        await app.waitFor(() => [...document.querySelectorAll('[data-test="settings"] [data-test="menu-row"]')].filter((el) => window.__e2e.isVisible(el)).length === 1, {
          label: 'search leaves one row',
        })
        await app.click(`${DIALOG} ${T('menu-row', { id: 'timeFormat' })}`)
        await app.waitVisible(`${DIALOG} ${T('menu-row', { id: '24-hour' })}`)
        await app.click(`${DIALOG} ${T('menu-row', { id: '24-hour' })}`)
        await toastSays(app, 'Set Time format to 24-hour')
        // The picker closes back to the Config tab, which shows the new value.
        await app.waitVisible(`${DIALOG} .sp-tab.on[data-tab="Config"]`)
        await app.waitText(`${DIALOG} ${T('menu-row', { id: 'timeFormat' })} .mm`, '24-hour')
        await close(app)
      },
    },
    {
      r: 'R51',
      name: '/config key=value applies headless and toasts the CLI answer without opening the dialog',
      async run({ app, project }) {
        await newGame(app, project)
        await fastText(app)
        await command(app, '/config recap=false')
        await toastSays(app, 'Set Session recap to false')
        eq(await app.visible(DIALOG), false, 'no dialog opens')
        await command(app, '/config nope=1')
        await toastSays(app, "nope isn't a /config setting")
        eq(await app.visible(DIALOG), false, 'still no dialog')
      },
    },
  ],
}
