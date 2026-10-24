// /permissions (alias /allowed-tools) and /add-dir (R53): tabs, adding and deleting a rule in a real settings
// file, the Workspace tab's directories, and /add-dir's three choices.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, fastText, focusInput, newGame, T, tempDir } from '../lib.mjs'

const MENU = T('permissions')
const row = (id) => `${MENU} ${T('menu-row', { id })}`
const RULE = 'Bash(npm test *)'

/** The project's .claude/settings.local.json, read straight from disk (the page can't read files). */
function localSettings(project) {
  const path = join(project, '.claude', 'settings.local.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
}

async function waitFile(app, project, test, label) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const json = localSettings(project)
    if (test(json)) return json
    if (Date.now() > deadline) throw new Error(`timed out waiting for settings.local.json: ${label} (now ${JSON.stringify(json)})`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** Types a slash command into the chat and sends it. */
async function command(app, text) {
  await focusInput(app)
  await app.type(text)
  await app.key('Enter')
}

async function closeMenus(app) {
  for (let i = 0; i < 6 && (await app.exists(MENU)); i++) await app.key('Escape')
  await app.waitFor(() => !document.querySelector('[data-test="permissions"]'), { label: 'the permissions menu closed' })
}

const title = (app) => app.eval((sel) => document.querySelector(`${sel} header h2`)?.textContent ?? '', MENU)
const waitTitle = (app, re) =>
  app.waitFor((sel, src) => new RegExp(src).test(document.querySelector(`${sel} header h2`)?.textContent ?? ''), { args: [MENU, re.source], label: `menu title ${re}` })
const waitToast = (app, re) =>
  app.waitFor((src) => new RegExp(src).test(document.getElementById('toast')?.textContent ?? ''), { args: [re.source], label: `a toast ${re}` })
/** The open tab, from the strip. */
const activeTab = (app) => app.attr(`${MENU} ${T('perm-tab')}[aria-current="true"]`, 'data-id')

async function typeInto(app, text) {
  await app.waitVisible(`${MENU} ${T('perm-input')}`)
  await app.click(`${MENU} ${T('perm-input')}`)
  await app.type(text)
  await app.key('Enter')
}

export default {
  name: 'Permissions and /add-dir',
  async setup({ app, project }) {
    await newGame(app, project)
    await fastText(app)
  },
  tests: [
    {
      r: 'R53',
      name: '/permissions adds an allow rule to local settings, shows it with its source, and deletes it after confirming',
      async run({ app, project }) {
        await command(app, '/permissions')
        await app.waitVisible(row('add'))
        assert((await title(app)) === 'Permissions', 'titled Permissions')
        assert((await activeTab(app)) === 'allow', 'opens on the Allow tab')
        const tabs = await app.attrs(`${MENU} ${T('perm-tab')}`, 'data-id')
        assert(JSON.stringify(tabs) === JSON.stringify(['recent', 'allow', 'ask', 'deny', 'workspace']), `the CLI's tabs: ${tabs}`)
        assert((await app.text(row('add'))).includes('Add a new rule…'), 'first row is Add a new rule…')

        await app.click(row('add'))
        await waitTitle(app, /^Add allow permission rule$/)
        await typeInto(app, RULE)
        await app.waitVisible(row('local'))
        const where = await app.texts(`${MENU} ${T('menu-row')}`)
        assert(/Project settings \(local\)/.test(where[0]) && /^Project settings/.test(where[1]) && /User settings/.test(where[2]), `save locations: ${where}`)
        assert(/Saved in \.claude\/settings\.local\.json/.test(where[0]), 'local option says where it saves')
        await app.click(row('local'))
        await waitToast(app, /Added allow rule Bash\(npm test \*\)/)
        const json = await waitFile(app, project, (j) => j.permissions?.allow?.includes(RULE), 'the allow rule is saved')
        assert(json.permissions.allow.length === 1, 'exactly one allow rule')

        // The dialog reopens on Allow with the rule and its source.
        await app.waitFor((sel) => document.querySelector(sel)?.textContent.includes('Project settings (local)'), { args: [row('rule:0')], label: 'the rule row with its source' })
        assert((await app.text(row('rule:0'))).includes(RULE), 'the rule is listed')

        await app.click(row('rule:0'))
        await waitTitle(app, /^Rule details$/)
        assert((await app.text(`${MENU} .menu-body`)).includes('project local settings'), 'details say where it is from')
        await app.click(row('delete'))
        await waitTitle(app, /^Delete allowed tool\?$/)
        assert((await app.text(`${MENU} .menu-body`)).includes('Are you sure you want to delete this permission rule?'), 'the CLI confirmation')
        await app.click(row('yes'))
        await waitToast(app, /Deleted allow rule Bash\(npm test \*\)/)
        await waitFile(app, project, (j) => !j.permissions?.allow?.includes(RULE), 'the rule is gone from the file')
        await app.waitVisible(row('add'))
        assert(!(await app.exists(row('rule:0'))), 'the rule is gone from the list')
        await closeMenus(app)
      },
    },
    {
      r: 'R53',
      name: 'tabs switch with ←/→ and clicks; Workspace lists the original directory, adds a remembered one and removes it',
      async run({ app, project }) {
        await command(app, '/allowed-tools')
        await app.waitVisible(row('add'))
        await app.key('ArrowLeft')
        await app.waitFor((sel) => document.querySelector(`${sel} [data-test="perm-tab"][aria-current="true"]`)?.dataset.id === 'recent', { args: [MENU], label: 'Recently denied tab' })
        assert(/No recent denials/.test(await app.text(`${MENU} .menu-list`)), 'an honest empty state for denials')
        await app.key('ArrowRight')
        await app.waitFor((sel) => document.querySelector(`${sel} [data-test="perm-tab"][aria-current="true"]`)?.dataset.id === 'allow', { args: [MENU], label: 'back on Allow' })
        await app.click(`${MENU} ${T('perm-tab', { id: 'workspace' })}`)
        await app.waitVisible(row('original'))
        assert((await app.text(row('original'))).includes(project), 'the session folder is listed')
        assert((await app.text(row('original'))).includes('(Original working directory)'), 'marked as the original directory')

        const extra = tempDir('wc-e2e-dir-')
        await app.click(row('add'))
        await waitTitle(app, /^Add directory to workspace$/)
        await typeInto(app, extra)
        await app.waitVisible(row('remember'))
        const choices = await app.texts(`${MENU} ${T('menu-row')}`)
        assert(choices.map((c) => c.trim()).join('|') === 'Yes, for this session|Yes, and remember this directory|No', `the CLI's choices: ${choices}`)
        const m = await app.mark()
        await app.click(row('remember'))
        await app.waitFor((f, dir) => window.__e2e.sent.slice(f).some((s) => s.t === 'ctl' && s.op === 'cli' && s.args?.[0] === `/add-dir ${dir}`), { args: [m.sent, extra], label: 'the headless /add-dir ran' })
        await waitToast(app, /saved to local settings · \/permissions to manage/)
        await waitFile(app, project, (j) => j.permissions?.additionalDirectories?.includes(extra), 'the directory is remembered')

        await app.waitVisible(row('dir:0'))
        assert((await app.text(row('dir:0'))).includes(extra), 'the remembered directory is listed')
        await app.click(row('dir:0'))
        await waitTitle(app, /^Remove directory from workspace\?$/)
        assert((await app.text(`${MENU} .menu-body`)).includes('Claude Code will no longer have access to files in this directory.'), 'the CLI warning')
        await app.click(row('yes'))
        await waitToast(app, /Removed directory .* from workspace/)
        await waitFile(app, project, (j) => !j.permissions?.additionalDirectories?.includes(extra), 'the directory is removed from the file')
        await closeMenus(app)
      },
    },
    {
      r: 'R53',
      name: '/add-dir <path> offers the three choices; session-only runs the CLI\'s /add-dir, No adds nothing, no path opens Workspace',
      async run({ app, project }) {
        const dir = tempDir('wc-e2e-session-')
        await command(app, `/add-dir ${dir}`)
        await app.waitVisible(row('session'))
        assert((await title(app)) === 'Add directory to workspace', 'the CLI title')
        assert((await app.text(`${MENU} .menu-body`)).includes('make edits when auto-accept edits is on'), 'the CLI explanation')
        const m = await app.mark()
        await app.click(row('session'))
        await app.waitFor((f, d) => window.__e2e.sent.slice(f).some((s) => s.t === 'ctl' && s.op === 'cli' && s.args?.[0] === `/add-dir ${d}`), { args: [m.sent, dir], label: 'the headless /add-dir ran' })
        await waitToast(app, /as a working directory for this session/)
        await app.waitFor(() => !document.querySelector('[data-test="permissions"]'), { label: 'the dialog closes' })
        assert(!(localSettings(project).permissions?.additionalDirectories ?? []).includes(dir), 'session-only is not saved')

        await command(app, '/add-dir C:\\nowhere')
        await app.waitVisible(row('no'))
        await app.click(row('no'))
        await waitToast(app, /Did not add a working directory\./)

        // The picker completes a command with an argument hint to "/add-dir " first; Enter again runs it bare.
        await command(app, '/add-dir')
        if (!(await app.exists(MENU))) await app.key('Enter')
        await app.waitVisible(row('original'))
        assert((await activeTab(app)) === 'workspace', 'no path opens the Workspace tab')
        const rows = (await app.texts(`${MENU} ${T('menu-row')}`)).join('\n')
        assert(rows.includes(dir) && rows.includes('This session'), 'the session directory is listed as this session only')
        await closeMenus(app)
      },
    },
  ],
}
