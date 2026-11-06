// The optional ticket board (plugins/waifufy-tickets) as the chat's left-column card: off until Settings →
// Plugins turns it on, and read from the plugin's own store through the link. The plugin has no R-number of
// its own (R1–R82 predate it), so these tests carry the plugin's tag, T1.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, eq, newGame, sleep, T, tempDir } from '../lib.mjs'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const PLUGIN = join(ROOT, 'plugins', 'waifufy-tickets')
const CLI = join(PLUGIN, 'bin', 'tickets.mjs')

const BODY = 'Signing in from /checkout bounces straight back to /login.'
const card = (id) => T('tickets-card', { id })
const col = (status) => T('tickets-column', { status })
const head = (id) => `${card(id)} .tickets-card-head`
/** The visible pill of a switch: `.set-toggle input` is `pointer-events: none`, the label around it is not. */
const pill = (id) => `${T(`set-plugins.${id}`)} + i`
/** A card's expanded description, as a page-side selector for the callbacks below. */
const detail = (id) => `[data-test="tickets-card"][data-id="${id}"] .tickets-detail`

/** One ticket per column, filed with the plugin's own CLI (its real writer) in a fresh temp database. */
function seed() {
  const db = join(tempDir('wc-e2e-tickets'), 'kanban.db')
  const env = { ...process.env, WC_TICKETS_DB: db }
  const cli = (...args) => execFileSync(process.execPath, [CLI, ...args], { env, stdio: 'pipe' }).toString()
  const idOf = (out) => out.match(/WC-\d+/)[0]

  cli('add', 'Fix the login redirect', '--project', 'booking-agent', '--priority', '2', '--labels', 'bug,auth', '--body', BODY)
  cli('add', 'Trim the README intro', '--status', 'todo', '--project', 'booking-agent')
  cli('add', 'Rewrite the export pipeline', '--status', 'doing', '--priority', '1')
  cli('move', idOf(cli('add', 'Land the 0.9 banner art')), 'blocked', '--reason', 'waiting on the 0.9 release branch')
  cli('move', idOf(cli('add', 'Move the settings tabs')), 'done')
  cli('add', 'Polish the empty states')
  return db
}

/** Settings → Plugins, where the switch lives. `on` is the state the switch should be painted in. */
async function openPluginsTab(app, on) {
  await app.go('settings')
  await app.waitVisible('[data-tab="plugins"]')
  await app.click('[data-tab="plugins"]')
  // The switch's own `<input>` is deliberately invisible (opacity 0, pointer-events: none) so the pill beside
  // it can be clicked like a user would; waiting for visibility would never come true, so wait for its state.
  await app.waitFor((want) => document.querySelector('[data-test="set-plugins.tickets"]')?.checked === want, {
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
  name: 'Tickets: the optional board card in the chat (plugins/waifufy-tickets)',
  // On for this file, so the card under test is the one the user sees; the database is the plugin's own.
  launch: () => ({
    settings: { plugins: { tickets: true } },
    env: { WC_TICKETS_DB: seed(), WC_TICKETS_PLUGIN: PLUGIN },
  }),
  tests: [
    {
      r: 'T1',
      name: 'the card sits under the mode/model badges and draws every column from the plugin store',
      async run({ app, project }) {
        await newGame(app, project)
        await app.waitVisible(T('tickets-panel'))
        await app.waitFor(() => document.querySelector('[data-test="tickets-panel"]')?.dataset.state === 'board', { label: 'the board painted' })
        eq(await app.text(T('tickets-count')), '6', 'the header counts every ticket')

        // One group per column, in board order, with the store's count; finished work starts folded.
        eq(
          await app.eval(() => [...document.querySelectorAll('[data-test="tickets-column"]')]
            .map((d) => [d.dataset.status, d.dataset.count, d.open])),
          [['inbox', '2', true], ['todo', '1', true], ['doing', '1', true], ['blocked', '1', true], ['done', '1', false]],
          'columns in order, with counts, and done collapsed',
        )
        eq(await app.eval(() => document.querySelector('[data-test="tickets-column"][data-status="done"] .tickets-col-name')?.textContent), 'Done', 'the store names the column')

        const first = await app.text(card('WC-1'))
        assert(first.includes('WC-1') && first.includes('Fix the login redirect'), `the WC-1 card: ${first}`)
        assert(first.includes('booking-agent') && first.includes('bug'), `project and labels on WC-1: ${first}`)
        eq(await app.eval((id) => document.querySelector(`[data-test="tickets-card"][data-id="${id}"] .tickets-pri`)?.textContent, 'WC-1'), '!!', 'priority 2 draws the urgent mark')
        assert((await app.text(col('blocked'))).includes('Blocked: waiting on the 0.9 release branch'), 'the blocked reason is shown')

        // It belongs to the left column, between the mode/model badges and the column's footer.
        const order = await app.eval(() => [...document.querySelector('.chat-left').children].map((e) =>
          e.classList.contains('badges') ? 'badges'
            : e.classList.contains('chat-plugin') ? 'chat-plugin'
              : e.classList.contains('left-foot') ? 'left-foot' : 'other'))
        const at = (name) => order.indexOf(name)
        assert(at('badges') >= 0 && at('chat-plugin') > at('badges') && at('left-foot') > at('chat-plugin'),
          `the card sits between the badges and the footer: ${order}`)
      },
    },
    {
      r: 'T1',
      name: 'a card opens its description in place, and the refresh button asks the link again',
      async run({ app }) {
        eq(await app.eval((sel) => document.querySelector(sel) !== null, detail('WC-1')), false, 'closed to start')
        await app.click(head('WC-1'))
        await app.waitFor((sel) => document.querySelector(sel)?.textContent.includes('bounces straight back'), { args: [detail('WC-1')], label: 'the description opens' })
        eq(await app.eval((id) => document.querySelector(`[data-test="tickets-card"][data-id="${id}"] .tickets-card-head`)?.getAttribute('aria-expanded'), 'WC-1'), 'true', 'the card reports itself open')
        assert((await app.text(card('WC-1'))).includes(BODY), 'the description is the ticket body')

        // A refresh is a second real request over the socket, not a repaint of what it already had.
        const m = await app.mark()
        await app.click(T('tickets-refresh'))
        await app.waitSent('tickets', {}, m)
        await app.waitFor(() => document.querySelector('[data-test="tickets-panel"]')?.dataset.state === 'board', { label: 'repainted' })
        eq(await app.eval((sel) => document.querySelector(sel) !== null, detail('WC-1')), true, 'a refresh keeps what the user opened')
        await app.click(head('WC-1'))
        await app.waitFor((sel) => document.querySelector(sel) === null, { args: [detail('WC-1')], label: 'the description closes' })
      },
    },
    {
      r: 'T1',
      name: 'Settings → Plugins turns the card off and on again, saving the flag',
      async run({ app }) {
        await openPluginsTab(app, true)

        await app.click(pill('tickets'))
        await app.waitFor(() => window.__wc.store.get().plugins?.tickets === false, { label: 'the flag is off in the store' })
        assert(await savedFlag(app, false), 'the flag reached settings.json')

        // Off means the slot is gone entirely — not an empty card left behind.
        await app.go('chat')
        await app.waitFor(() => document.querySelector('.chat-plugin') === null, { label: 'the card is unmounted' })

        await openPluginsTab(app, false)
        await app.click(pill('tickets'))
        await app.waitFor(() => window.__wc.store.get().plugins?.tickets === true, { label: 'the flag is on again' })
        await app.go('chat')
        await app.waitVisible(T('tickets-panel'))
        await app.waitFor(() => document.querySelector('[data-test="tickets-count"]')?.textContent === '6', { label: 'the board is back' })
        eq(await app.eval(() => document.querySelectorAll('[data-test="tickets-card"]').length), 6, 'every card came back')
      },
    },
  ],
}
