// R52: /model picker with its effort line, the /effort slider and /fast; R54: the /context grid and breakdown.
import { assert, eq, fastText, focusInput, newGame, T } from '../lib.mjs'

const row = (menu, id) => `${T(menu)} ${T('menu-row', { id })}`
const focusedId = (app, menu) => app.eval((sel) => document.activeElement?.closest(`${sel} .mrow`)?.dataset.id ?? null, T(menu))
const toastSays = (app, re, label) => app.waitText('#toast', re, { label: label ?? `the toast to say ${re}` })

/** Types a slash command into the chat input and presses Enter; returns the mark from before. */
async function command(app, text) {
  const m = await app.mark()
  await focusInput(app)
  await app.type(text)
  await app.key('Enter')
  return m
}

const cliSent = (app, text, from) => app.waitSent('ctl', { op: 'cli', args: [text] }, from)

async function freshChat(app, project) {
  await newGame(app, project)
  await fastText(app)
}

export default {
  name: 'Model, effort, fast and context panels',
  tests: [
    {
      r: 'R52',
      name: '/model lists supportedModels with the current one on, picks one through the CLI\'s /model, and /model <name> sets it directly',
      async run({ app, project }) {
        await freshChat(app, project)
        await command(app, '/effort auto')
        await toastSays(app, /auto/)
        await command(app, '/model')
        await app.waitVisible(row('model', 'sonnet'))
        eq(await app.text(`${T('model')} header h2`), 'Select model', 'the CLI\'s title')
        for (const id of ['default', 'opus', 'sonnet', 'haiku']) assert(await app.exists(row('model', id)), `row ${id}`)
        assert(await app.exists(`${row('model', 'default')}.on`), 'the current model (Default, which resolves to Opus) is on')
        eq(await focusedId(app, 'model'), 'default', 'the picker starts on the current model')
        const foot = await app.text(`${T('model')} .menu-foot`)
        assert(/● High effort \(default\) · ←\/→ to adjust/.test(foot), `the effort line under the list: ${foot}`)

        // ←/→ adjusts the effort on the line; Enter on a model applies the model, then that effort.
        const before = await app.text(`${T('model')} .menu-foot .mnote`)
        await app.key('ArrowDown')
        await app.key('ArrowDown')
        eq(await focusedId(app, 'model'), 'sonnet', '↓↓ reaches Sonnet')
        await app.key('ArrowLeft')
        await app.waitFor((b) => document.querySelector('[data-test="model"] .menu-foot .mnote')?.textContent !== b, { args: [before], label: 'the effort line changed' })
        const m = await app.mark()
        await app.key('Enter')
        await cliSent(app, '/model sonnet', m)
        await cliSent(app, '/effort medium', m)
        await toastSays(app, /Set model to Sonnet 5\.5/)
        await app.waitHidden(T('model'))

        // The picker reads the CLI's model back: Sonnet is now on.
        await command(app, '/model')
        await app.waitVisible(`${row('model', 'sonnet')}.on`)
        await app.key('Escape')
        await app.waitHidden(T('model'))

        // With an argument there is no panel.
        const m2 = await command(app, '/model haiku')
        await cliSent(app, '/model haiku', m2)
        await toastSays(app, /Set model to Haiku 5\.5/)
        assert(!(await app.exists(T('model'))), 'no picker for /model <name>')
      },
    },
    {
      r: 'R52',
      name: '/effort is the Faster ↔ Smarter slider: ←/→ move the ▲ and Enter applies /effort <level>; /effort <level> applies directly',
      async run({ app, project }) {
        await freshChat(app, project)
        // Back to the model's default (the mock CLI keeps its effort across sessions).
        await command(app, '/effort auto')
        await toastSays(app, /auto/)
        await command(app, '/effort')
        await app.waitVisible(row('effort', 'high'))
        eq(await app.text(`${T('effort')} header h2`), 'Effort', 'the CLI\'s title')
        const ends = await app.text(`${T('effort')} ${T('effort-ends')}`)
        assert(/Faster/.test(ends) && /Smarter/.test(ends), `Faster and Smarter ends: ${ends}`)
        for (const id of ['low', 'medium', 'high', 'xhigh', 'max']) assert(await app.exists(row('effort', id)), `stop ${id}`)
        await app.waitFor(() => document.activeElement?.closest('[data-test="effort"] .mrow')?.dataset.id === 'high', { label: 'the slider starts on the current level' })

        await app.key('ArrowRight')
        eq(await focusedId(app, 'effort'), 'xhigh', '→ moves to xhigh')
        await app.key('ArrowRight')
        await app.key('ArrowRight')
        eq(await focusedId(app, 'effort'), 'max', '→ stops at max')
        await app.key('ArrowLeft')
        await app.key('ArrowLeft')
        await app.key('ArrowLeft')
        eq(await focusedId(app, 'effort'), 'medium', '← back to medium')
        const m = await app.mark()
        await app.key('Enter')
        await cliSent(app, '/effort medium', m)
        await toastSays(app, /Set effort level to medium/)
        await app.waitHidden(T('effort'))

        const m2 = await command(app, '/effort low')
        await cliSent(app, '/effort low', m2)
        await toastSays(app, /Set effort level to low/)
        assert(!(await app.exists(T('effort'))), 'no slider for /effort <level>')
      },
    },
    {
      r: 'R52',
      name: '/fast toggles with Space and confirms through /fast on|off; /fast off applies directly',
      async run({ app, project }) {
        await freshChat(app, project)
        await command(app, '/fast')
        await app.waitVisible(row('fast', 'toggle'))
        eq(await app.text(`${T('fast')} header h2`), 'Fast mode (research preview)', 'the CLI\'s title')
        const was = (await app.text(`${row('fast', 'toggle')} .mm`)).trim()
        const want = was === 'ON' ? 'OFF' : 'ON'
        await app.key(' ')
        await app.waitText(`${row('fast', 'toggle')} .mm`, want, { label: `Space flips it to ${want}` })
        const m = await app.mark()
        await app.key('Enter')
        await cliSent(app, `/fast ${want.toLowerCase()}`, m)
        await toastSays(app, `Fast mode ${want}`)
        await app.waitHidden(T('fast'))

        // Reopened, it shows the new state; Enter without a change keeps it.
        await command(app, '/fast')
        await app.waitText(`${row('fast', 'toggle')} .mm`, want, { label: 'the panel reads the new state' })
        await app.key('Enter')
        await toastSays(app, `Kept Fast mode ${want}`)

        const m2 = await command(app, '/fast off')
        await cliSent(app, '/fast off', m2)
        await toastSays(app, 'Fast mode OFF')
      },
    },
    {
      r: 'R54',
      name: '/context draws the grid and the category legend from getContextUsage, with sections that /context all expands',
      async run({ app, project }) {
        await freshChat(app, project)
        const m = await command(app, '/context')
        await app.waitSent('ctl', { op: 'getContextUsage', args: [{ detail: 'full' }] }, m)
        await app.waitVisible(`${T('context')} ${T('context-grid')}`)
        eq(await app.text(`${T('context')} header h2`), 'Context Usage', 'the CLI\'s title')
        eq(await app.count(`${T('context')} .cx`), 100, 'a 10×10 grid from gridRows')
        const kinds = await app.eval(() => [...document.querySelectorAll('[data-test="context"] .cx')].map((c) => c.classList[1]))
        for (const k of ['full', 'free', 'buf']) assert(kinds.includes(k), `the grid has ${k} squares`)
        // Squares take the category colours (theme.css --c-*).
        const color = await app.eval(() => document.querySelector('[data-test="context"] .cx[data-cat="messages"]')?.getAttribute('style') ?? '')
        assert(color.includes('--c-messages'), `messages squares use --c-messages: ${color}`)

        const total = await app.text(`${T('context')} ${T('context-total')}`)
        assert(/26\.7k\/200k tokens \(13%\)/.test(total), `the total line: ${total}`)
        const cats = await app.attrs(`${T('context')} ${T('context-category')}`, 'data-id')
        for (const id of ['system_prompt', 'system_tools', 'mcp_tools', 'custom_agents', 'memory_files', 'skills', 'messages', 'free_space', 'autocompact_buffer'])
          assert(cats.includes(id), `legend has ${id} (has ${cats})`)
        assert(!cats.includes('mcp_tools_deferred'), 'deferred tools are not in the window legend')
        const legend = await app.text(`${T('context')} .cx-legend`)
        assert(legend.includes('Messages') && legend.includes('6.4k tokens (3.2%)'), `a category line: ${legend}`)

        // Collapsed sections, as the CLI's fullscreen view; Enter on one expands them all.
        const list = await app.text(`${T('context')} .menu-list`)
        for (const want of ['MCP tools', '(loaded on-demand)', 'Custom agents', 'Memory files', 'Skills', '4 tools', '3 agents', '2 files', '3 skills'])
          assert(list.includes(want), `section text ${want}`)
        assert((await app.text(`${T('context')} .menu-foot`)).includes('/context all to expand'), 'the expand hint')
        await app.key('Enter')
        await app.waitVisible(row('context', 'mcp:mcp__graft__graft_find_code'))
        await app.key('Escape')
        await app.waitVisible(row('context', 'more:mcp'))
        await app.key('Escape')
        await app.waitHidden(T('context'))

        await command(app, '/context all')
        await app.waitVisible(row('context', 'agent:code-reviewer'))
        for (const id of ['memory:CLAUDE.md', 'skill:User:triage-workflow', 'mcp:mcp__claude_ai_Slack__slack_read_channel'])
          assert(await app.exists(row('context', id)), `expanded row ${id}`)
        assert(!(await app.text(`${T('context')} .menu-foot`)).includes('/context all to expand'), 'no expand hint when expanded')
      },
    },
  ],
}
