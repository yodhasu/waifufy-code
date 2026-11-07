// The ticket board as a mod (plugins/waifufy-tickets/mod.json): a sandboxed panel in the chat's left column, read
// from the board's own store by the mod's backend, switched on in Settings → Mods, and refreshed when the agent's
// tool call writes. The panel is a cross-origin iframe, so its DOM is read with app.frameEval. The board has no
// R-number of its own (R1–R82 predate it), so these tests carry its tag, T1.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, eq, newGame, say, sleep, T, tempDir, turnEnd } from '../lib.mjs'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const PLUGIN = join(ROOT, 'plugins', 'waifufy-tickets')
const CLI = join(PLUGIN, 'bin', 'tickets.mjs')

const BODY = 'Signing in from /checkout bounces straight back to /login.'
const panel = T('mod-panel', { id: 'tickets' })
const row = T('mod-row', { id: 'tickets' })
/** The visible pill of a switch: `.set-toggle input` is `pointer-events: none`, the label around it is not. */
const pill = `${row} ${T('set-mods.tickets')} + i`
// Selectors inside the panel frame.
const card = (id) => `[data-test="tickets-card"][data-id="${id}"]`
const head = (id) => `${card(id)} .tickets-card-head`
const isBoard = () => document.querySelector('[data-test="tickets-panel"]')?.dataset.state === 'board'

/**
 * One ticket per column, filed with the board's own CLI (its real writer) in a fresh temp database. The mod
 * finds its store through APPDATA (as the permission model's `%APPDATA%/waifufy-tickets` grant does), so the
 * run points APPDATA at a temp folder and never touches the real board.
 */
function seed() {
  const appdata = tempDir('wc-e2e-tickets')
  const db = join(appdata, 'waifufy-tickets', 'kanban.db')
  const env = { ...process.env, WC_TICKETS_DB: db }
  const cli = (...args) => execFileSync(process.execPath, [CLI, ...args], { env, stdio: 'pipe' }).toString()
  const idOf = (out) => out.match(/WC-\d+/)[0]

  cli('add', 'Fix the login redirect', '--project', 'booking-agent', '--priority', '2', '--labels', 'bug,auth', '--body', BODY)
  cli('add', 'Trim the README intro', '--status', 'todo', '--project', 'booking-agent')
  cli('add', 'Rewrite the export pipeline', '--status', 'doing', '--priority', '1')
  cli('move', idOf(cli('add', 'Land the 0.9 banner art')), 'blocked', '--reason', 'waiting on the 0.9 release branch')
  cli('move', idOf(cli('add', 'Move the settings tabs')), 'done')
  cli('add', 'Polish the empty states')
  return appdata
}

/** Settings → Mods, where the switch lives. `on` is the state the switch should be painted in. */
async function openModsTab(app, on) {
  await app.go('settings')
  await app.waitVisible('[data-tab="mods"]')
  await app.click('[data-tab="mods"]')
  // The switch's own `<input>` is deliberately invisible (opacity 0, pointer-events: none) so the pill beside
  // it can be clicked like a user would; waiting for visibility would never come true, so wait for its state.
  await app.waitFor((want) => document.querySelector('[data-test="set-mods.tickets"]')?.checked === want, {
    args: [on],
    label: `the switch reads ${on ? 'on' : 'off'}`,
  })
}

/** Waits for the debounced settings save to reach settings.json, as a restart would read it. */
async function savedFlag(app, want) {
  for (let i = 0; i < 50; i++) {
    if (app.readSettingsFile()?.plugins?.tickets === want) return true
    await sleep(100)
  }
  return false
}

export default {
  name: 'Tickets: the board as a mod in the chat (plugins/waifufy-tickets)',
  // On for this file, so the panel under test is the one the user sees; the database is a temp copy of the board's layout.
  launch: () => ({
    settings: { plugins: { tickets: true } },
    env: { APPDATA: seed() },
  }),
  tests: [
    {
      r: 'T1',
      name: 'the panel sits under the mode/model badges and draws every column from the store',
      async run({ app, project }) {
        await newGame(app, project)
        await app.waitVisible(`${panel} iframe`)
        await app.frameWaitFor('tickets', isBoard, { label: 'the board painted' })
        eq(await app.frameEval('tickets', () => document.querySelector('[data-test="tickets-count"]').textContent), '6', 'the header counts every ticket')

        // One group per column, in board order, with the store's count; finished work starts folded.
        eq(
          await app.frameEval('tickets', () => [...document.querySelectorAll('[data-test="tickets-column"]')]
            .map((d) => [d.dataset.status, d.dataset.count, d.open])),
          [['inbox', '2', true], ['todo', '1', true], ['doing', '1', true], ['blocked', '1', true], ['done', '1', false]],
          'columns in order, with counts, and done collapsed',
        )
        eq(await app.frameEval('tickets', () => document.querySelector('[data-test="tickets-column"][data-status="done"] .tickets-col-name')?.textContent), 'Done', 'the store names the column')

        const first = await app.frameEval('tickets', (sel) => document.querySelector(sel).textContent, card('WC-1'))
        assert(first.includes('WC-1') && first.includes('Fix the login redirect'), `the WC-1 card: ${first}`)
        assert(first.includes('booking-agent') && first.includes('bug'), `project and labels on WC-1: ${first}`)
        eq(await app.frameEval('tickets', (sel) => document.querySelector(`${sel} .tickets-pri`)?.textContent, card('WC-1')), '!!', 'priority 2 draws the urgent mark')
        assert((await app.frameEval('tickets', () => document.querySelector('[data-test="tickets-column"][data-status="blocked"]').textContent)).includes('Blocked: waiting on the 0.9 release branch'), 'the blocked reason is shown')

        // It belongs to the left column, between the mode/model badges and the column's footer.
        const order = await app.eval(() => [...document.querySelector('.chat-left').children].map((e) =>
          e.classList.contains('badges') ? 'badges'
            : e.querySelector('[data-test="mod-panel"][data-id="tickets"]') ? 'mod'
              : e.classList.contains('left-foot') ? 'left-foot' : 'other'))
        const at = (name) => order.indexOf(name)
        assert(at('badges') >= 0 && at('mod') > at('badges') && at('left-foot') > at('mod'),
          `the panel sits between the badges and the footer: ${order}`)
        // The built-in card gives way to its mod: one board, not two.
        eq(await app.eval(() => document.querySelectorAll('[data-test="tickets-panel"], .chat-plugin').length), 0, 'no built-in card beside the mod')
      },
    },
    {
      r: 'T1',
      name: 'a card opens its description in place, and the refresh button asks the backend again',
      async run({ app }) {
        const detail = (id) => `${card(id)} .tickets-detail`
        eq(await app.frameEval('tickets', (sel) => document.querySelector(sel) !== null, detail('WC-1')), false, 'closed to start')
        await app.frameClick('tickets', head('WC-1'))
        await app.frameWaitFor('tickets', (sel) => document.querySelector(sel)?.textContent.includes('bounces straight back'), { args: [detail('WC-1')], label: 'the description opens' })
        eq(await app.frameEval('tickets', (sel) => document.querySelector(sel).getAttribute('aria-expanded'), head('WC-1')), 'true', 'the card reports itself open')
        assert((await app.frameEval('tickets', (sel) => document.querySelector(sel).textContent, card('WC-1'))).includes(BODY), 'the description is the ticket body')

        // A refresh is a second real request over the socket, not a repaint of what it already had.
        const m = await app.mark()
        await app.frameClick('tickets', '[data-test="tickets-refresh"]')
        await app.waitSent('mod-call', { id: 'tickets', method: 'board' }, m)
        await app.frameWaitFor('tickets', isBoard, { label: 'repainted' })
        eq(await app.frameEval('tickets', (sel) => document.querySelector(sel) !== null, detail('WC-1')), true, 'a refresh keeps what the user opened')
        await app.frameClick('tickets', head('WC-1'))
        await app.frameWaitFor('tickets', (sel) => document.querySelector(sel) === null, { args: [detail('WC-1')], label: 'the description closes' })
      },
    },
    {
      r: 'T1',
      name: 'Settings → Mods turns the panel off and on again, saving the flag',
      async run({ app }) {
        await openModsTab(app, true)

        await app.click(pill)
        await app.waitFor(() => window.__wc.store.get().plugins?.tickets === false, { label: 'the flag is off in the store' })
        assert(await savedFlag(app, false), 'the flag reached settings.json')

        // Off means the slot is gone entirely — not an empty panel left behind.
        await app.go('chat')
        await app.waitFor((sel) => document.querySelector(sel) === null, { args: [panel], label: 'the panel is unmounted' })

        await openModsTab(app, false)
        await app.click(pill)
        await app.waitFor(() => window.__wc.store.get().plugins?.tickets === true, { label: 'the flag is on again' })
        await app.go('chat')
        await app.waitVisible(`${panel} iframe`)
        await app.frameWaitFor('tickets', () => document.querySelector('[data-test="tickets-count"]')?.textContent === '6', { label: 'the board is back' })
        eq(await app.frameEval('tickets', () => document.querySelectorAll('[data-test="tickets-card"]').length), 6, 'every card came back')
      },
    },
    {
      r: 'T1',
      name: 'a ticket_create through the mods tool server refreshes the panel',
      async run({ app, project }) {
        await newGame(app, project)
        await app.frameWaitFor('tickets', isBoard, { label: 'the board painted' })
        const m = await say(app, 'modtool ticket_create {"title":"Added by the agent","project":"booking-agent"}')
        await turnEnd(app, m)
        await app.waitText(T('dialogue-text'), 'created WC-7', { label: 'her reply carries the tool result' })
        await app.frameWaitFor('tickets', () => document.querySelector('[data-test="tickets-card"][data-id="WC-7"]')?.textContent.includes('Added by the agent'), { label: 'the new card is drawn' })
        eq(await app.frameEval('tickets', () => document.querySelector('[data-test="tickets-count"]').textContent), '7', 'the header counts it')
      },
    },
  ],
}
