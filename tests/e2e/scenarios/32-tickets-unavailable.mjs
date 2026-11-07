// The ticket panel when the board's database can't be opened: the mod's backend answers `available: false`
// (it never throws), and the panel says what is wrong instead of showing an empty board. Tag T1, as in
// 31-tickets.mjs. A directory where kanban.db should be makes the store fail to open.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { assert, eq, newGame, T, tempDir } from '../lib.mjs'

export default {
  name: 'Tickets: the panel explains itself when the board cannot be read',
  launch: () => {
    const appdata = tempDir('wc-e2e-tickets-broken')
    mkdirSync(join(appdata, 'waifufy-tickets', 'kanban.db'), { recursive: true })
    return { settings: { plugins: { tickets: true } }, env: { APPDATA: appdata } }
  },
  tests: [
    {
      r: 'T1',
      name: 'available:false shows the backend reason and where to look, and draws no columns',
      async run({ app, project }) {
        await newGame(app, project)
        await app.waitVisible(`${T('mod-panel', { id: 'tickets' })} iframe`)
        await app.frameWaitFor('tickets', () => document.querySelector('[data-test="tickets-unavailable"]'), { label: 'the unavailable state' })
        const text = await app.frameEval('tickets', () => document.querySelector('[data-test="tickets-unavailable"]').textContent)
        assert(text.includes("can't be read"), `the panel says so: ${text}`)
        assert(text.includes('waifufy-tickets'), `it names the folder to check: ${text}`)
        assert(text.trim().split('\n').filter(Boolean).length >= 2, `it carries the backend's reason: ${text}`)
        eq(await app.frameEval('tickets', () => document.querySelector('[data-test="tickets-count"]').textContent), '—', 'no count for a board that is not there')
        eq(await app.frameEval('tickets', () => document.querySelectorAll('[data-test="tickets-column"]').length), 0, 'no columns')
        eq(await app.frameEval('tickets', () => document.querySelectorAll('[data-test="tickets-card"]').length), 0, 'no cards')
      },
    },
  ],
}
