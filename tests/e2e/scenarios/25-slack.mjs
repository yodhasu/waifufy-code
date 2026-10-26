// Slack (docs/V0.5.md R74–R76) against the mock link's workspace (link/src/slack.ts mockApi): sign-in in Settings,
// the SLACK button's unread badge, the /slack inbox, reading a conversation and a thread, marking read, and
// answering. Her Slack tools (R76) need the real SDK; tests/unit/slack.test.mjs covers what they call.
import { assert, eq, fastText, newGame, setField, T } from '../lib.mjs'

const row = (id) => `[data-test="slack"] [data-test="menu-row"][data-id="${id}"]`
const title = (app) => app.eval(() => document.querySelector('[data-test="slack"] header h2')?.textContent ?? '')
const badge = (app) => app.eval(() => document.querySelector('[data-test="qm-slack"]')?.dataset.badge ?? '')
const slackStatus = (app) => app.eval(() => document.querySelector('[data-test="slack-status"]')?.textContent ?? '')

async function openSlackTab(app) {
  await app.go('settings')
  await app.waitVisible('[data-tab="slack"]')
  await app.click('[data-tab="slack"]')
  await app.waitVisible(T('slack-status'))
}

/** Signs in with the mock app unless the link already is. */
async function signIn(app) {
  await openSlackTab(app)
  if ((await slackStatus(app)).includes('Signed in')) return
  await setField(app, 'slack.clientId', '123.456')
  await app.click(T('set-slack.signin'))
  await app.waitFor(() => document.querySelector('[data-test="slack-status"]')?.textContent.includes('Signed in to Mock Team as You'), { label: 'signed in' })
}

async function openInbox(app) {
  await app.click(T('qm-slack'))
  await app.waitVisible(T('slack'))
  await app.waitFor(() => document.querySelector('[data-test="slack"] header h2')?.textContent === 'Slack', { label: '/slack loaded' })
}

export default {
  name: 'Slack: sign-in, the unread inbox, reading, marking read and answering',
  tests: [
    {
      r: 'R74',
      name: 'Settings → Slack: the manifest names the callback; a refused client ID says why; sign-in shows who; sign out',
      async run({ app }) {
        await openSlackTab(app)
        if ((await slackStatus(app)).includes('Signed in')) {
          await app.click(T('set-slack.signout'))
          await app.waitFor(() => document.querySelector('[data-test="slack-status"]')?.textContent.includes('Not signed in'), { label: 'signed out' })
        }
        assert((await app.text(T('slack-manifest'))).includes('http://localhost:47917/slack/callback'), 'the manifest lists the callback')
        assert((await app.text(T('slack-manifest'))).includes('pkce_enabled: true'), 'PKCE')
        await setField(app, 'slack.clientId', 'mock-fail')
        await app.click(T('set-slack.signin'))
        await app.waitFor(() => /client ID/.test(document.querySelector('[data-test="slack-status"]')?.textContent ?? ''), { label: 'the refusal' })
        await signIn(app)
        eq(await app.eval(() => document.querySelector('[data-test="set-slack.signout"]').disabled), false, 'sign out offered')
      },
    },
    {
      r: 'R75',
      name: 'the SLACK badge counts unread conversations; /slack lists them; a conversation opens on its first unread message',
      async run({ app, project }) {
        await signIn(app)
        await newGame(app, project)
        await fastText(app)
        await app.waitFor(() => document.querySelector('[data-test="qm-slack"]')?.dataset.badge === '2', { label: 'badge 2', timeout: 15_000 })
        await openInbox(app)
        assert((await app.text(row('c:D0ALICE'))).includes('2 unread'), 'the DM')
        assert((await app.text(row('c:C0GENERAL'))).includes('3 unread'), '#general')
        assert((await app.text(row('c:C0GENERAL'))).includes('Shipped the fix'), 'the newest message as the hint')
        await app.click(row('c:C0GENERAL'))
        await app.waitFor(() => document.querySelector('[data-test="slack"] header h2')?.textContent === '#general', { label: '#general' })
        const focused = await app.eval(() => document.activeElement?.closest('[data-test="menu-row"]')?.textContent ?? '')
        assert(focused.includes('Lunch?'), `focus on the first unread message, got: ${focused}`)
        assert((await app.text(T('slack'))).includes('@You can you review #42?'), 'mentions shown as names')
        // A message with replies opens its thread; Esc comes back.
        await app.key('Enter')
        await app.waitFor(() => document.querySelector('[data-test="slack"] header h2')?.textContent === 'Thread in #general', { label: 'thread' })
        assert((await app.text(T('slack'))).includes('Noodles?'), 'the replies')
        await app.key('Escape')
        eq(await title(app), '#general', 'back')
        await app.click(row('read'))
        await app.waitFor(() => document.querySelector('[data-test="qm-slack"]')?.dataset.badge === '1', { label: 'badge 1' })
        await app.key('Escape')
        eq(await title(app), 'Slack', 'back to the inbox')
        assert(!(await app.eval(() => !!document.querySelector('[data-test="slack"] [data-id="c:C0GENERAL"]'))), '#general left the inbox')
        await app.key('Escape')
        await app.waitHidden(T('slack'))
      },
    },
    {
      r: 'R75',
      name: 'writing in a conversation sends as you (Ctrl+Enter), shows it, and reads the conversation',
      async run({ app, project }) {
        await signIn(app)
        await newGame(app, project)
        await fastText(app)
        await openInbox(app)
        await app.waitVisible(row('c:D0ALICE'))
        await app.click(row('c:D0ALICE'))
        await app.waitFor(() => document.querySelector('[data-test="slack"] header h2')?.textContent === 'Alice', { label: 'the DM' })
        await app.click(row('reply'))
        await app.waitVisible(T('slack-compose'))
        await app.type('It is live now')
        const m = await app.mark()
        await app.key('Ctrl+Enter')
        await app.waitSent('slack_send', { channel: 'D0ALICE', text: 'It is live now' }, m)
        await app.waitHidden(T('slack-compose'))
        await app.waitFor(() => document.querySelector('[data-test="slack"]')?.textContent.includes('You (you)') && document.querySelector('[data-test="slack"]')?.textContent.includes('It is live now'), { label: 'the sent message' })
        await app.waitFor(() => (document.querySelector('[data-test="qm-slack"]')?.dataset.badge ?? '') === '', { label: 'nothing unread' })
        eq(await badge(app), '', 'badge cleared')
      },
    },
    {
      r: 'R74',
      name: 'signed out, /slack says how to set it up and opens Settings → Slack',
      async run({ app, project }) {
        await openSlackTab(app)
        if ((await slackStatus(app)).includes('Signed in')) await app.click(T('set-slack.signout'))
        await app.waitFor(() => document.querySelector('[data-test="slack-status"]')?.textContent.includes('Not signed in'), { label: 'signed out' })
        await newGame(app, project)
        await openInbox(app)
        assert((await app.text(T('slack'))).includes('Settings → Slack'), 'the setup hint')
        await app.click(row('settings'))
        await app.waitVisible(T('slack-status'))
      },
    },
  ],
}
