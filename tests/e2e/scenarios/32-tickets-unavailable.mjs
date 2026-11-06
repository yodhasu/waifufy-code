// The ticket card when the plugin folder is not installed: the link answers `available: false` (it never
// throws), and the card says what to install instead of showing an empty board. Tag T1, as in 31-tickets.mjs.
import { join } from 'node:path'
import { assert, eq, newGame, T, tempDir } from '../lib.mjs'

export default {
  name: 'Tickets: the card explains itself when the plugin folder is missing',
  launch: () => ({
    settings: { plugins: { tickets: true } },
    env: {
      WC_TICKETS_PLUGIN: join(tempDir('wc-e2e-no-plugin'), 'waifufy-tickets'),
      WC_TICKETS_DB: join(tempDir('wc-e2e-tickets'), 'kanban.db'),
    },
  }),
  tests: [
    {
      r: 'T1',
      name: 'available:false names the folder it looked in and the install command, and draws no columns',
      async run({ app, project }) {
        await newGame(app, project)
        await app.waitVisible(T('tickets-unavailable'))
        const text = await app.text(T('tickets-unavailable'))
        assert(text.includes("plugin isn't installed"), `the link's reason is shown: ${text}`)
        assert(text.includes('waifufy-tickets'), `the reason names the folder it looked in: ${text}`)
        assert(text.includes('node plugins/waifufy-tickets/install.mjs'), `the install command: ${text}`)
        eq(await app.text(T('tickets-count')), '—', 'no count for a board that is not there')
        eq(await app.eval(() => document.querySelectorAll('[data-test="tickets-column"]').length), 0, 'no columns')
        eq(await app.eval(() => document.querySelectorAll('[data-test="tickets-card"]').length), 0, 'no cards')
      },
    },
  ],
}
