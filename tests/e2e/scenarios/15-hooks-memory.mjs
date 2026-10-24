// R57 /hooks (the read-only viewer) and R58 /memory (instruction files, the auto-memory toggles, open a file).
// The hook and the CLAUDE.md are real files in the test project; the toggles write the mock's real user settings
// (<WC_DATA_DIR>\mock-claude\settings.json, link/src/server.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, eq, fastText, focusInput, newGame, T } from '../lib.mjs'

const HOOK_COMMAND = 'echo e2e-hook-ran'
const MEMORY_TEXT = '# E2E project memory\n\nAlways answer in haiku.\nSee @docs/notes.md for the notes.\n'

const row = (id) => T('menu-row', { id })
const title = (app, test) => app.text(`${T(test)} header h2`)

/** Writes the project's hook and CLAUDE.md before any chat opens, as a user would have them. */
function seedProject(project) {
  mkdirSync(join(project, '.claude'), { recursive: true })
  const hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: HOOK_COMMAND }] }] }
  writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ hooks }, null, 2))
  writeFileSync(join(project, 'CLAUDE.md'), MEMORY_TEXT)
}

/** Types an app command and runs it with Enter through the slash picker. */
async function slash(app, name) {
  await focusInput(app)
  await app.key('Ctrl+A')
  await app.key('Backspace')
  await app.typeKeys(`/${name}`)
  await app.waitVisible(T('slash-popup'))
  await app.key('Enter')
}

async function openPanel(app, name) {
  await slash(app, name)
  await app.waitVisible(T(name))
  await app.waitFor((n) => document.querySelector(`[data-test="${n}"] [data-test="menu-row"]`), { args: [name], label: `${name} rows` })
}

async function closePanel(app, name) {
  for (let i = 0; i < 6 && (await app.visible(T(name))); i++) await app.key('Escape')
  await app.waitHidden(T(name))
}

const userSettings = (app) => {
  const file = join(app.dataDir, 'mock-claude', 'settings.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
}

export default {
  name: '/hooks and /memory',
  async setup({ app, project }) {
    seedProject(project)
    await newGame(app, project)
    await fastText(app)
  },
  tests: [
    {
      r: 'R57',
      name: '/hooks lists the project hook under its event with [Project], and drills down to its detail',
      async run({ app }) {
        await openPanel(app, 'hooks')
        eq(await title(app, 'hooks'), 'Hooks', 'title')
        const panel = await app.text(T('hooks'))
        assert(panel.includes('1 hook on 1 event'), `subtitle counts the hook: ${panel}`)
        assert(panel.includes('PreToolUse') && panel.includes('before tool execution'), 'the event heading and its summary')
        assert(panel.includes('This menu is read-only'), 'the read-only note')
        assert(/Plugin, session and built-in hooks aren't listed/.test(panel), 'the honest note about plugin hooks')
        const hook = await app.text(row('hook-0'))
        assert(hook.includes(`[Project] ${HOOK_COMMAND}`) && hook.includes('Bash · command'), `the hook row: ${hook}`)

        // The list row opens the hook detail directly, as in the CLI.
        await app.click(row('hook-0'))
        await app.waitFor(() => document.querySelector('[data-test="hooks"] header h2').textContent === 'Command hook', { label: 'hook detail' })
        let detail = await app.text(T('hooks'))
        assert(detail.includes('PreToolUse · Bash'), 'the event and matcher')
        assert(detail.includes('Project settings (.claude/settings.json)'), 'the source')
        assert(detail.includes(HOOK_COMMAND), 'the command')
        assert(/To change or remove this hook, edit \.[\\/]\.claude[\\/]settings\.json or ask Claude\./.test(detail), `the footer: ${detail}`)
        await app.key('Escape')

        // All events → PreToolUse → the Bash matcher → the hook → its detail.
        await app.waitVisible(row('events'))
        await app.click(row('events'))
        await app.waitFor(() => document.querySelector('[data-test="hooks"] header h2').textContent === 'Hook events', { label: 'event picker' })
        const events = await app.attrs(`${T('hooks')} ${T('menu-row')}`, 'data-id')
        eq(events.slice(0, 3).join(' '), 'PreToolUse PostToolUse PostToolUseFailure', 'the CLI event order')
        assert((await app.text(T('hooks'))).includes('1 with hooks'), 'events with hooks are counted')
        assert((await app.text(row('PreToolUse'))).includes('1 hook'), 'PreToolUse has 1 hook')
        await app.click(row('PreToolUse'))
        await app.waitFor(() => document.querySelector('[data-test="hooks"] header h2').textContent === 'PreToolUse - Matchers', { label: 'matchers' })
        const matcher = await app.text(row('m:Bash'))
        assert(matcher.includes('[Project] Bash') && matcher.includes('1 hook'), `the matcher row: ${matcher}`)
        await app.click(row('m:Bash'))
        await app.waitFor(() => document.querySelector('[data-test="hooks"] header h2').textContent === 'PreToolUse - Matcher: Bash', { label: 'hooks of the matcher' })
        assert((await app.text(row('h:0'))).includes('Project Settings'), 'the hook names its source')
        await app.click(row('h:0'))
        await app.waitFor(() => document.querySelector('[data-test="hooks"] header h2').textContent === 'Command hook', { label: 'hook detail again' })
        detail = await app.text(T('hooks'))
        assert(detail.includes(HOOK_COMMAND), 'the same hook')
        await closePanel(app, 'hooks')
      },
    },
    {
      r: 'R58',
      name: '/memory lists the project CLAUDE.md with its import, previews it, and opens it',
      async run({ app, project }) {
        await openPanel(app, 'memory')
        eq(await title(app, 'memory'), 'Memory', 'title')
        assert((await app.text(row('file:0'))).includes('User instructions'), 'the user row')
        assert((await app.text(row('file:0'))).includes('not created yet'), 'the missing user file says so')
        const proj = await app.text(row('file:1'))
        assert(proj.includes('Project instructions') && /Checked in at \.\/CLAUDE\.md/.test(proj), `the project row: ${proj}`)
        assert(/\d+ B/.test(proj), `the project row shows its size: ${proj}`)
        const imp = await app.text(row('file:2'))
        assert(/L docs[\\/]notes\.md/.test(imp) && imp.includes('@-imported'), `the @-import row: ${imp}`)

        await app.click(row('file:1'))
        await app.waitFor(() => document.querySelector('[data-test="memory"] header h2').textContent === 'Project instructions', { label: 'file detail' })
        const detail = await app.text(T('memory'))
        assert(detail.includes('Always answer in haiku.'), 'the preview shows the first lines')
        assert(detail.includes(join(project, 'CLAUDE.md')), 'the full path')
        const m = await app.mark()
        await app.click(row('open'))
        // The harness blocks `open` and `reveal`, so no editor or Explorer opens.
        await app.waitSent('open', { target: join(project, 'CLAUDE.md') }, m)
        await app.waitHidden(T('memory'))

        // A missing file is created, then opened, as the CLI does. The user's here is the test-only config dir.
        await openPanel(app, 'memory')
        await app.click(row('file:0'))
        await app.waitVisible(row('create'))
        const m2 = await app.mark()
        await app.click(row('create'))
        const sent = await app.waitSent('open', {}, m2)
        assert(/CLAUDE.md$/.test(sent.target), `opens the new file: ${sent.target}`)
        assert(existsSync(sent.target), 'the file exists now')
        await app.waitHidden(T('memory'))
      },
    },
    {
      r: 'R58',
      name: '/memory toggles Auto-memory and Auto-dream in the user settings',
      async run({ app }) {
        await openPanel(app, 'memory')
        eq(await app.text(`${row('auto-memory')} .mm`), 'on', 'auto-memory is on by default')
        await app.click(row('auto-memory'))
        await app.waitFor(() => document.querySelector('[data-test="memory"] [data-id="auto-memory"] .mm')?.textContent === 'off', { label: 'auto-memory off' })
        eq(userSettings(app).autoMemoryEnabled, false, 'autoMemoryEnabled saved to the user settings')
        eq(await app.attr(row('auto-dream'), 'aria-disabled'), 'true', 'auto-dream is off while auto-memory is off')

        // Space toggles the focused row, as in the CLI.
        await app.eval(() => document.querySelector('[data-test="memory"] [data-id="auto-memory"]').focus())
        await app.key(' ')
        await app.waitFor(() => document.querySelector('[data-test="memory"] [data-id="auto-memory"] .mm')?.textContent === 'on', { label: 'auto-memory on' })
        eq(userSettings(app).autoMemoryEnabled, true, 'autoMemoryEnabled back on')
        await app.click(row('auto-dream'))
        await app.waitFor(() => document.querySelector('[data-test="memory"] [data-id="auto-dream"] .mm')?.textContent === 'on', { label: 'auto-dream on' })
        eq(userSettings(app).autoDreamEnabled, true, 'autoDreamEnabled saved')
        await closePanel(app, 'memory')
      },
    },
  ],
}
