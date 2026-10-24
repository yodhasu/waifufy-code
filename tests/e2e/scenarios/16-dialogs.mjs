// V0.5 dialog parity (docs/V0.5.md): MCP elicitation forms (R59).
import { assert, eq, fastText, newGame, readAll, say, T, turnEnd } from '../lib.mjs'

async function freshChat(app, cwd) {
  await newGame(app, cwd)
  await fastText(app)
}

async function elicitOpen(app, from) {
  await app.waitEvent('ask_elicit', {}, from, 20_000)
  await app.waitVisible(T('ask', { kind: 'elicit' }))
  await app.waitFor(() => document.querySelector('[data-test="ask"]')?.dataset.armed === '1', { label: 'menu armed' })
}

export default {
  name: 'Dialogs: MCP elicitation',
  tests: [
    {
      r: 'R59',
      name: 'elicitation form: required fields are checked in place, then the answers reach the server',
      timeout: 60_000,
      async run({ app, project }) {
        await freshChat(app, project)
        const m = await say(app, 'deploy with mcp input')
        await elicitOpen(app, m)
        await app.waitText(T('ask'), 'requests your input')
        eq(await app.count(T('elicit-field')), 3, 'one row per schema property')
        // Accept with the required fields empty: the form stays open and says why.
        await app.click(T('ask-option', { v: 'accept' }))
        await app.waitVisible(T('elicit-error'))
        await app.waitText(T('elicit-error'), 'Environment is required')
        await app.click('[data-test="elicit-field"][data-name="environment"] .echip[data-v="production"]')
        await app.click('[data-test="elicit-field"][data-name="reason"] input')
        await app.type('hotfix for the prompt')
        await app.click(T('ask-option', { v: 'accept' }))
        const sent = await app.waitSent('elicit', { action: 'accept' }, m)
        eq(sent.content.environment, 'production', 'the picked option')
        eq(sent.content.reason, 'hotfix for the prompt', 'the typed text')
        eq(sent.content.notify, true, 'the boolean keeps its schema default')
        await turnEnd(app, m)
        await readAll(app)
        await app.waitText(T('dialogue-text'), 'Deployed to production')
      },
    },
    {
      r: 'R59',
      name: 'elicitation: Esc cancels and the tool reports it',
      timeout: 60_000,
      async run({ app, project }) {
        await freshChat(app, project)
        const m = await say(app, 'deploy with mcp input')
        await elicitOpen(app, m)
        await app.key('Escape')
        await app.waitSent('elicit', { action: 'cancel' }, m)
        await turnEnd(app, m)
        assert(!(await app.count(T('ask'))), 'the menu closed')
      },
    },
  ],
}
