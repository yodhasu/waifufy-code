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

async function permissionOpen(app, from) {
  await app.waitEvent('ask_permission', {}, from, 20_000)
  await app.waitVisible(T('ask', { kind: 'permission' }))
  await app.waitFor(() => document.querySelector('[data-test="ask"]')?.dataset.armed === '1', { label: 'menu armed' })
}

const rowLabels = (app) => app.eval(() => [...document.querySelectorAll('[data-test="ask-option"]')].map((b) => b.querySelector('span').textContent))

export default {
  name: 'Dialogs: permission wording, MCP elicitation',
  tests: [
    {
      r: 'R60',
      name: 'an edit prompt asks the CLI question and offers "switch to Accept edits"; Shift+Tab picks it',
      timeout: 60_000,
      async run({ app, project }) {
        await freshChat(app, project)
        const m = await say(app, 'ask permission to edit')
        await permissionOpen(app, m)
        await app.waitText(T('ask-question'), 'Do you want to make this edit to loader.ts?')
        const labels = await rowLabels(app)
        eq(labels[0], 'Yes', 'Yes first')
        eq(labels[1], 'Yes, and switch to Accept edits for this session (shift+tab)', 'the mode row')
        assert(labels.at(-1).startsWith('No, and tell '), `No last: ${labels.at(-1)}`)
        await app.key('Shift+Tab')
        const sent = await app.waitSent('permission', { decision: 'always' }, m)
        assert(sent.option?.startsWith('mode-'), `the mode row's option: ${sent.option}`)
        await turnEnd(app, m)
      },
    },
    {
      r: 'R60',
      name: 'a fetch prompt offers "don\'t ask again" for its host',
      timeout: 60_000,
      async run({ app, project }) {
        await freshChat(app, project)
        const m = await say(app, 'fetch the docs')
        await permissionOpen(app, m)
        await app.waitText(T('ask-question'), 'to fetch this content?')
        const labels = await rowLabels(app)
        assert(labels.some((l) => /^Yes, and don't ask again for \S+\.\S+$/.test(l)), `a host row in ${JSON.stringify(labels)}`)
        await app.click(T('ask-option', { v: 'always' }))
        const sent = await app.waitSent('permission', { decision: 'always' }, m)
        assert(sent.option?.startsWith('rule-'), `the rule row's option: ${sent.option}`)
        await turnEnd(app, m)
      },
    },
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
