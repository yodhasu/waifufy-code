// Stats badges, the backlog (R23) and errors in character (R24).
import { killPid } from '../driver.mjs'
import { assert, byText, fastText, MOCK, newGame, readAll, say, skip, T, turnEnd } from '../lib.mjs'

/** The banner shows as soon as the link socket closes; the shell's first restart waits 500 ms, then Node boots. */
const OFFLINE_SHOW_MS = 5000
const RESTART_MS = 30_000

const STAT_HOOKS = ['context', 'five', 'week', 'cost', 'turns', 'elapsed', 'api', 'tokens-in', 'tokens-out', 'cache'].map((s) => `stat-${s}`)

async function freshChat(app, cwd) {
  await newGame(app, cwd)
  await fastText(app)
}

const statText = (app, hook) => app.eval((sel) => document.querySelector(sel)?.textContent ?? '', T(hook))

/** Clicks the chat's Restart session action and waits for the new session's `ready`. */
async function restartSession(app) {
  await app.waitFor(() => [...document.querySelectorAll('#stage button')].some((b) => window.__e2e.isVisible(b) && /restart/i.test(b.textContent)), {
    label: 'a Restart session button',
  })
  const action = T('dialogue-action', { v: 'restart' })
  const restart = (await app.visible(action)) ? action : await byText(app, /restart/i)
  const r = await app.mark()
  await app.click(restart)
  const start = await app.waitSent('start', {}, r)
  await app.waitEvent('ready', { epoch: start.epoch }, r, 20_000)
}

export default {
  name: 'Panels: stats, LOG, errors',
  tests: [
    {
      r: ['R18', 'R13'],
      name: 'stats and badges show the session numbers and update after each turn',
      async run({ app, project }) {
        await freshChat(app, project)
        for (const h of STAT_HOOKS) assert(await app.exists(T(h)), `${h} exists`)
        // The session runs the CLI default (Opus); the badge may name the alias row ("Default") or the model.
        await app.waitText(T('badge-model'), /opus|default/i, { label: 'badge-model shows the model' })
        assert((await app.text(T('badge-mode'))).trim().length > 0, 'badge-mode shows the mode')
        let m = await say(app, 'hello there')
        await turnEnd(app, m)
        await app.waitFor(() => /0\.04/.test(document.querySelector('[data-test="stat-cost"]').textContent), { label: 'cost $0.04 after one turn' })
        assert(/\b1\b/.test(await statText(app, 'stat-turns')), 'one turn')
        assert(/1[23]/.test(await statText(app, 'stat-five')), `5-hour limit ~12–13%: ${await statText(app, 'stat-five')}`)
        assert(/3[45]/.test(await statText(app, 'stat-week')), `weekly limit ~34–35%: ${await statText(app, 'stat-week')}`)
        assert(/\d/.test(await statText(app, 'stat-context')), 'context usage')
        assert(/\d/.test(await statText(app, 'stat-tokens-in')) && /\d/.test(await statText(app, 'stat-tokens-out')), 'tokens')
        m = await say(app, 'hello again')
        await turnEnd(app, m)
        await app.waitFor(() => /\b2\b/.test(document.querySelector('[data-test="stat-turns"]').textContent), { label: 'two turns' })
        await app.waitFor(() => /0\.08/.test(document.querySelector('[data-test="stat-cost"]').textContent), { label: 'cost is cumulative' })
        await readAll(app)
      },
    },
    {
      r: 'R23',
      name: 'LOG (Ctrl+O) shows every line, tool calls with results and command output; it can be searched and copied',
      timeout: 60_000,
      async run({ app, project }) {
        await freshChat(app, project)
        let m = await say(app, 'use some tools please')
        await turnEnd(app, m)
        // An SDK command (V0.5: /context is the app's own panel now; /compact still goes to the CLI).
        m = await say(app, '/compact')
        await turnEnd(app, m)
        await readAll(app)
        await app.key('Ctrl+O')
        await app.waitVisible(T('log'))
        const who = new Set(await app.attrs(T('log-entry'), 'data-who'))
        for (const w of ['user', 'char', 'tool']) assert(who.has(w), `LOG has ${w} entries (has ${[...who]})`)
        const all = (await app.texts(T('log-entry'))).join('\n')
        assert(all.includes('use some tools please'), 'my line')
        assert(all.includes('All three quests are done'), 'her line')
        assert(all.includes('42 passed'), 'a tool result')
        assert(/compacted/i.test(all), 'command output')
        const total = await app.count(T('log-entry'))
        await app.click(T('log-search'))
        await app.type('loader')
        await app.waitFor(
          (n) => {
            const shown = [...document.querySelectorAll('[data-test="log-entry"]')].filter((el) => window.__e2e.isVisible(el))
            return shown.length > 0 && shown.length < n && shown.every((el) => /loader/i.test(el.textContent))
          },
          { args: [total], label: 'search filters the entries' },
        )
        const selectable = await app.eval(() => getComputedStyle(document.querySelector('[data-test="log-entry"]')).userSelect !== 'none')
        assert(selectable, 'entries can be selected and copied')
        await app.key('Escape')
        await app.waitHidden(T('log'))
        await app.click(T('qm-log'))
        await app.waitVisible(T('log'))
        await app.key('Escape')
        await app.waitHidden(T('log'))
      },
    },
    {
      r: ['R24', 'R48'],
      name: 'not logged in: she says so in character, LOG has it, and a Log in button is offered',
      async run({ app, project }) {
        await freshChat(app, project)
        const m = await say(app, 'trigger an error')
        const err = await app.waitEvent('error', { kind: 'auth' }, m)
        await turnEnd(app, m)
        const name = (await app.settings()).waifu.name
        await app.waitFor(
          (f, at, n) => window.__e2e.dialogue.slice(f).some((d) => d.at >= at && (d.name.includes(n) || d.text.includes(n)) && d.text.trim().length > 0),
          { args: [m.dialogue, err.at, name], label: 'an in-character line after the error' },
        )
        const action = T('dialogue-action', { v: 'login' })
        const login = (await app.visible(action)) ? action : await byText(app, /log\s*in/i, '#screen-chat')
        assert(login, 'a "Log in" button in the chat')
        const before = await app.mark()
        await app.click(login)
        // The harness blocks `login` so no console opens during tests.
        await app.waitSent('login', {}, before)
        await app.key('Ctrl+O')
        await app.waitVisible(T('log'))
        assert((await app.texts(T('log-entry'))).join('\n').includes(MOCK.authMessage), 'LOG has the error')
        await app.key('Escape')
      },
    },
    {
      r: 'R24',
      name: 'the session crashes: an error shows, and Restart session brings her back',
      async run({ app, project }) {
        await freshChat(app, project)
        const m = await say(app, 'please crash')
        await app.waitEvent('ended', { reason: 'crashed' }, m)
        await app.key('Ctrl+O')
        await app.waitVisible(T('log'))
        assert((await app.texts(T('log-entry'))).join('\n').includes(MOCK.crashMessage), 'LOG has the crash')
        await app.key('Escape')
        await app.waitHidden(T('log'))
        await restartSession(app)
        const again = await say(app, 'are you back?')
        await turnEnd(app, again)
      },
    },
    {
      r: 'R24',
      name: 'the sidecar dies: the offline banner shows, the shell restarts it, and Restart session brings her back',
      timeout: 90_000,
      async run({ app, project }) {
        if (app.target !== 'app') skip('the Tauri shell restarts the sidecar, and browser mode has no shell')
        await freshChat(app, project)
        const pids = app.sidecarPids()
        assert(pids.length > 0, 'the sidecar runs as a node.exe child of the shell')
        for (const pid of pids) killPid(pid)
        await app.waitVisible('#offline.show', OFFLINE_SHOW_MS)
        await app.waitFor(() => !document.getElementById('offline').classList.contains('show'), {
          timeout: RESTART_MS,
          label: 'the offline banner to go away (the sidecar restarted)',
        })
        const fresh = app.sidecarPids()
        assert(fresh.length > 0 && fresh.every((p) => !pids.includes(p)), `a new sidecar runs (was ${pids}, now ${fresh})`)
        assert(app.alive(), 'the app itself kept running')
        await restartSession(app)
        await fastText(app)
        const m = await say(app, 'are you back?')
        await turnEnd(app, m)
        await readAll(app)
      },
    },
  ],
}
