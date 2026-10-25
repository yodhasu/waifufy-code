// R55–R56: /plugin's tabbed panel (Discover, Installed, Marketplaces, Errors) and /skills' visibility cycle.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, eq, fastText, focusInput, newGame, sleep, T } from '../lib.mjs'

const SAVE_MS = 5000

const row = (id) => T('menu-row', { id })
const toastSays = (app, re, label) => app.waitText('#toast', re, { label: label ?? `the toast to say ${re}` })
const rowIds = (app) => app.attrs(T('menu-row'), 'data-id')
const currentTab = (app) => app.eval(() => document.querySelector('[data-test="plugin-tab"].on')?.dataset.id)

async function freshChat(app, cwd) {
  if (await app.visible('#confirm')) await app.click('#confirmNo')
  await newGame(app, cwd)
  await fastText(app)
}

/** Types an app command and runs it with Enter. */
async function slash(app, text) {
  await focusInput(app)
  await app.key('Ctrl+A')
  await app.key('Backspace')
  await app.typeKeys(text)
  if (!text.includes(' ')) await app.waitVisible(T('slash-popup'))
  await app.key('Enter')
}

async function waitTab(app, id) {
  await app.waitFor((t) => document.querySelector('[data-test="plugin-tab"].on')?.dataset.id === t, { args: [id], label: `the ${id} tab` })
}

/** Focuses a row by id (rows are buttons). */
async function focusRow(app, id) {
  await app.waitVisible(row(id))
  await app.eval((sel) => document.querySelector(sel).focus(), row(id))
}

const sorted = (o) => Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => a.localeCompare(b)))

const localSettings = (project) => {
  try {
    return JSON.parse(readFileSync(join(project, '.claude', 'settings.local.json'), 'utf8'))
  } catch {
    return {}
  }
}

export default {
  name: 'Plugins and skills',
  tests: [
    {
      r: 'R55',
      name: '/plugin opens on Discover; Tab, ←/→ and clicks switch between Discover, Installed, Marketplaces and Errors',
      async run({ app, project }) {
        await freshChat(app, project)
        await slash(app, '/plugin')
        await app.waitVisible(T('plugin'))
        await waitTab(app, 'discover')
        const tabs = await app.attrs(T('plugin-tab'), 'data-id')
        eq(tabs.join(','), 'discover,installed,marketplaces,errors', 'the CLI tab order')
        const ids = await rowIds(app)
        assert(ids.includes('code-review@claude-plugins-official'), `Discover lists the marketplace's plugins: ${ids}`)
        assert(!ids.includes('commit-commands@claude-plugins-official'), 'an installed plugin is not in Discover')
        await app.key('Tab')
        await waitTab(app, 'installed')
        assert((await rowIds(app)).includes('commit-commands@claude-plugins-official'), 'Installed lists the installed plugin')
        await app.key('ArrowRight')
        await waitTab(app, 'marketplaces')
        const mk = await rowIds(app)
        assert(mk.includes('+add') && mk.includes('claude-plugins-official') && mk.includes('acme-tools'), `Marketplaces rows: ${mk}`)
        await app.key('ArrowRight')
        await waitTab(app, 'errors')
        assert(/Errors \(1\)/.test(await app.text(T('plugin-tab', { id: 'errors' }))), 'the Errors tab counts its errors')
        assert(/hooks\.json is not valid JSON/.test(await app.text(T('plugin'))), 'the load error shows')
        await app.key('ArrowLeft')
        await waitTab(app, 'marketplaces')
        await app.click(T('plugin-tab', { id: 'discover' }))
        await waitTab(app, 'discover')
        await app.key('Escape')
        await app.waitHidden(T('plugin'))
        // The /marketplace alias opens on its own tab (typed out: the picker would complete it to /plugin).
        await slash(app, '/marketplace ')
        await app.waitVisible(T('plugin'))
        await waitTab(app, 'marketplaces')
        await app.key('Escape')
        await app.waitHidden(T('plugin'))
      },
    },
    {
      r: 'R55',
      name: 'installing a plugin from its details, then disabling and enabling it on the Installed tab',
      async run({ app, project }) {
        await freshChat(app, project)
        await slash(app, '/plugin')
        await app.waitVisible(T('plugin'))
        await waitTab(app, 'discover')
        const id = 'code-review@claude-plugins-official'
        await app.click(row(id))
        await app.waitVisible(row('project'))
        assert(/Make sure you trust a plugin/.test(await app.text(T('plugin'))), 'the trust warning')
        await app.click(row('user'))
        await toastSays(app, /Installed code-review\. Plugin is now active\./)
        // Back on Discover, the plugin is gone from the list.
        await app.waitFor((r) => !document.querySelector(r) && !!document.querySelector('[data-test="plugin-tab"]'), { args: [row(id)], label: 'code-review left Discover' })
        await app.key('Tab')
        await waitTab(app, 'installed')
        await focusRow(app, id)
        assert(/✔/.test(await app.text(`${row(id)} .mi`)), 'installed and enabled')
        await app.key(' ')
        await toastSays(app, /Disabled code-review\./)
        await app.waitFor((r) => /disabled/.test(document.querySelector(r)?.textContent ?? ''), { args: [row(id)], label: 'the row says disabled' })
        assert(!(await app.visible(row('toggle'))), 'Space toggled in place (no detail screen opened)')
        await app.click(row(id))
        await app.waitVisible(row('toggle'))
        eq((await app.text(row('toggle'))).trim(), 'Enable plugin', 'the detail offers Enable')
        await app.click(row('toggle'))
        await toastSays(app, /Enabled code-review\./)
        await app.waitFor(() => /Disable plugin/.test(document.querySelector('[data-test="menu-row"][data-id="toggle"]')?.textContent ?? ''), { label: 'the detail now offers Disable' })
        await app.key('Escape')
        await waitTab(app, 'installed')
        assert(/✔/.test(await app.text(`${row(id)} .mi`)), 'enabled again on the list')
        // `i` installs the focused Discover row.
        await app.key('ArrowLeft')
        await waitTab(app, 'discover')
        await focusRow(app, 'acme-lint@acme-tools')
        await app.key('i')
        await toastSays(app, /Installed acme-lint\./)
        await app.key('Escape')
        await app.waitHidden(T('plugin'))
      },
    },
    {
      r: 'R55',
      name: 'adding and removing a marketplace',
      async run({ app, project }) {
        await freshChat(app, project)
        await slash(app, '/plugin marketplace')
        await app.waitVisible(T('plugin'))
        await waitTab(app, 'marketplaces')
        await app.click(row('+add'))
        await app.waitVisible(T('plugin-mkt-source'))
        await app.click(T('plugin-mkt-source'))
        await app.type('octo/skills-pack')
        await app.key('Enter')
        await toastSays(app, /Successfully added marketplace: skills-pack/)
        await app.waitVisible(row('skills-pack'))
        await app.click(row('skills-pack'))
        await app.waitVisible(row('remove'))
        await app.click(row('remove'))
        await app.click(row('remove'))
        await toastSays(app, /Successfully removed marketplace: skills-pack/)
        await waitTab(app, 'marketplaces')
        await app.waitFor((r) => !document.querySelector(r), { args: [row('skills-pack')], label: 'skills-pack is gone' })
        eq(await currentTab(app), 'marketplaces', 'back on the Marketplaces tab')
        await app.key('Escape')
        await app.waitHidden(T('plugin'))
      },
    },
    {
      r: 'R56',
      name: '/skills lists skills, cycles on → name-only → user-only → off, skips locked rows, and saves skillOverrides on close',
      async run({ app, project }) {
        await freshChat(app, project)
        await slash(app, '/skills')
        await app.waitVisible(T('skills'))
        await app.waitVisible(row('release-notes'))
        const ids = await rowIds(app)
        for (const n of ['triage-workflow', 'release-notes', 'commit-commands:commit']) assert(ids.includes(n), `${n} listed (${ids})`)
        assert(!ids.includes('compact'), 'built-in commands are not skills')
        assert(/locked by plugin/.test(await app.text(row('commit-commands:commit'))), 'the plugin skill is locked')
        const meta = () => app.text(`${row('release-notes')} .mm`)
        await focusRow(app, 'release-notes')
        await app.key('Enter')
        await app.waitFor((r) => /name-only/.test(document.querySelector(r)?.textContent ?? ''), { args: [row('release-notes')], label: 'name-only' })
        await focusRow(app, 'release-notes')
        await app.key(' ')
        await app.waitFor((r) => /user-only/.test(document.querySelector(r)?.textContent ?? ''), { args: [row('release-notes')], label: 'user-only' })
        await focusRow(app, 'release-notes')
        await app.key(' ')
        await app.waitFor((r) => /◯/.test(document.querySelector(`${r} .mi`)?.textContent ?? ''), { args: [row('release-notes')], label: 'off' })
        assert(!/only/.test(await meta()), `off has no word: ${await meta()}`)
        // triage-workflow: one step, to name-only.
        await focusRow(app, 'triage-workflow')
        await app.key(' ')
        await app.waitFor((r) => /name-only/.test(document.querySelector(r)?.textContent ?? ''), { args: [row('triage-workflow')], label: 'triage-workflow name-only' })
        assert(!localSettings(project).skillOverrides, 'nothing is written before the panel closes')
        await app.key('Escape')
        await app.waitHidden(T('skills'))
        await toastSays(app, /Updated 2 skill overrides/)
        const deadline = Date.now() + SAVE_MS
        while (!localSettings(project).skillOverrides && Date.now() < deadline) await sleep(100)
        eq(JSON.stringify(sorted(localSettings(project).skillOverrides)), JSON.stringify({ 'release-notes': 'off', 'triage-workflow': 'name-only' }), 'settings.local.json skillOverrides')
        // Reopened, the saved state shows; cycling off → on removes the entry.
        await slash(app, '/skills')
        await app.waitVisible(row('release-notes'))
        await app.waitFor((r) => /◯/.test(document.querySelector(`${r} .mi`)?.textContent ?? ''), { args: [row('release-notes')], label: 'still off' })
        await focusRow(app, 'release-notes')
        await app.key(' ')
        await app.key('Escape')
        await app.waitHidden(T('skills'))
        await toastSays(app, /Updated 1 skill override\b/)
        const end = Date.now() + SAVE_MS
        while (localSettings(project).skillOverrides?.['release-notes'] && Date.now() < end) await sleep(100)
        eq(JSON.stringify(localSettings(project).skillOverrides), JSON.stringify({ 'triage-workflow': 'name-only' }), 'back to on drops the entry')
      },
    },
  ],
}
