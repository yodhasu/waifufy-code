// R62 /tasks (alias /bashes): the CLI's "Background" dialog on the mock's "background" scenario (link/src/mock.ts):
// a running shell (task-1) and an Explore agent (task-2) that completes a moment later.
import { assert, eq, fastText, focusInput, newGame, say, T, turnEnd } from '../lib.mjs'

const row = (id) => `[data-test="tasks"] [data-test="menu-row"][data-id="${id}"]`
const title = (app) => app.eval(() => document.querySelector('[data-test="tasks"] header h2')?.textContent ?? '')
/** The heading of the group a row sits in ("Shells", "Local agents", "Completed"). */
const groupOf = (app, id) => app.eval((id) => {
  const r = document.querySelector(`[data-test="tasks"] [data-test="menu-row"][data-id="${id}"]`)
  return r?.closest('.mgroup')?.querySelector('h3')?.firstChild?.textContent.trim() ?? ''
}, id)

async function slash(app, text) {
  await focusInput(app)
  await app.type(text)
  await app.type(' ')
  await app.key('Enter')
}

async function openTasks(app, name = '/tasks') {
  await slash(app, name)
  await app.waitVisible(T('tasks'))
  await app.waitFor(() => document.querySelector('[data-test="tasks"] header h2')?.textContent === 'Background', { label: '/tasks open' })
}

export default {
  name: '/tasks Background panel',
  tests: [
    {
      r: 'R62',
      name: 'with nothing in the background, /tasks and /bashes show the CLI empty text',
      async run({ app, project }) {
        await newGame(app, project)
        await fastText(app)
        await openTasks(app)
        assert((await app.text(T('tasks'))).includes('No tasks currently running'), 'the empty text')
        await app.key('Escape')
        await app.waitHidden(T('tasks'))
        await openTasks(app, '/bashes')
        assert((await app.text(T('tasks'))).includes('No tasks currently running'), 'the alias opens it too')
        await app.key('Escape')
        await app.waitHidden(T('tasks'))
      },
    },
    {
      r: 'R62',
      name: 'the shell and the agent are grouped live; the agent moves to Completed while the panel is open; Enter shows the detail',
      async run({ app, project }) {
        await newGame(app, project)
        await fastText(app)
        const m = await say(app, 'start the background build')
        await app.waitEvent('bg_tasks', {}, m)
        await openTasks(app)
        await app.waitVisible(row('task-1'))
        await app.waitVisible(row('task-2'))
        const shell = await app.text(row('task-1'))
        assert(shell.includes('npm run build -- --watch') && shell.includes('●') && shell.includes('running'), `the shell row: ${shell}`)
        eq(await groupOf(app, 'task-1'), 'Shells', 'the shell group')
        const firstGroup = await groupOf(app, 'task-2')
        assert(['Local agents', 'Completed'].includes(firstGroup), `the agent group: ${firstGroup}`)
        // The mock completes the agent a moment after it starts; the open panel redraws on its own.
        await app.waitFor(() => {
          const r = document.querySelector('[data-test="tasks"] [data-test="menu-row"][data-id="task-2"]')
          return r?.closest('.mgroup')?.querySelector('h3')?.textContent.startsWith('Completed') && r.textContent.includes('Found 4 callers')
        }, { label: 'the agent completed live', timeout: 15_000 })
        const agent = await app.text(row('task-2'))
        assert(agent.includes('✔') && agent.includes('done') && agent.includes('7 tools') && agent.includes('4.1k tokens'), `the done agent row: ${agent}`)
        assert((await app.text(T('tasks'))).includes('1 active shell'), 'the counts line')
        // A bg_tasks update that adds a monitor shows up without touching the panel.
        // Session events carry the session's epoch; the injected one copies the last real one.
        const last = (await app.events(m, 'bg_tasks')).at(-1)
        await app.inject({ ...last, tasks: [...last.tasks, { id: 'mon-1', type: 'monitor_mcp', description: 'Watch the deploy log', status: 'running' }] })
        await app.waitVisible(row('mon-1'))
        eq(await groupOf(app, 'mon-1'), 'Monitors', 'the monitor group')
        // Enter on the agent: its detail with every field.
        await app.click(row('task-2'))
        await app.waitFor(() => document.querySelector('[data-test="tasks"] header h2')?.textContent === 'Find every caller of loadTemplate', { label: 'agent detail' })
        const detail = await app.text(T('tasks'))
        for (const want of ['Status:', 'Completed', '4.1k tokens', '7 tools', '9s', 'Prompt:', 'Progress:', 'Found 4 callers in src/prompts', 'Explore']) {
          assert(detail.includes(want), `the agent detail shows ${want}`)
        }
        assert(!(await app.count(row('stop'))), 'no Stop for a finished agent')
        await app.key('Escape')
        eq(await title(app), 'Background', 'back to the list')
        await app.click(row('task-1'))
        await app.waitFor(() => document.querySelector('[data-test="tasks"] header h2')?.textContent === 'npm run build -- --watch', { label: 'shell detail' })
        const sd = await app.text(T('tasks'))
        assert(sd.includes('Command:') && sd.includes('running') && sd.includes('Output:'), 'the shell detail')
        await app.waitVisible(row('stop'))
        await app.key('Escape')
        await app.key('Escape')
        await app.waitHidden(T('tasks'))
      },
    },
    {
      r: 'R62',
      name: 'x on the running shell sends stopTask and the row shows it stopped',
      async run({ app, project }) {
        await newGame(app, project)
        await fastText(app)
        const m = await say(app, 'start the background build')
        await turnEnd(app, m)
        await openTasks(app)
        await app.waitVisible(row('task-1'))
        await app.eval(() => document.querySelector('[data-test="tasks"] [data-test="menu-row"][data-id="task-1"]').focus())
        const s = await app.mark()
        await app.key('x')
        const sent = await app.waitSent('ctl', { op: 'stopTask' }, s)
        eq(sent.args, ['task-1'], 'stopTask for the shell')
        await app.waitFor(() => /⚠.*stopped/.test(document.querySelector('[data-test="tasks"] [data-test="menu-row"][data-id="task-1"]')?.textContent ?? ''), { label: 'the shell stopped' })
        assert(!(await app.text(T('tasks'))).includes('active shell'), 'no active shell left in the counts')
        // x on a stopped task does nothing more.
        const s2 = await app.mark()
        await app.key('x')
        await new Promise((r) => setTimeout(r, 300))
        eq((await app.sent(s2, 'ctl')).filter((c) => c.op === 'stopTask').length, 0, 'no second stopTask')
        await app.key('Escape')
        await app.waitHidden(T('tasks'))
      },
    },
    {
      r: 'R62',
      name: 'Ctrl+B while she works sends backgroundTasks and says where to manage it',
      async run({ app, project }) {
        await newGame(app, project)
        await fastText(app)
        const m = await say(app, 'start the background build')
        await app.waitEvent('bg_tasks', {}, m)
        const s = await app.mark()
        await app.key('Ctrl+B')
        await app.waitSent('ctl', { op: 'backgroundTasks' }, s)
        await app.waitFor(() => /Moved to the background · \/tasks to manage|Nothing to send to the background/.test(document.body.innerText), { label: 'the Ctrl+B toast' })
        await turnEnd(app, m)
      },
    },
  ],
}
