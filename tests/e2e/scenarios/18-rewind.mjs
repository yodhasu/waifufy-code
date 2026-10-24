// /rewind and Esc Esc (R61): the CLI's message selector, newest first with each prompt's code changes, its confirm
// options, and the restores: rewindFiles for the code, a restart cut before the prompt for the conversation, with
// the prompt back in the composer.
import { assert, eq, fastText, focusInput, newGame, readAll, say, T, turnEnd } from '../lib.mjs'

const MENU = T('rewind')
const row = (id) => `${MENU} ${T('menu-row', { id })}`
const rows = (app) => app.eval((sel) => [...document.querySelectorAll(`${sel} [data-test="menu-row"]`)].map((b) => ({
  id: b.dataset.id, label: b.querySelector('.ml b').textContent, hint: b.querySelector('.ml small')?.textContent ?? '', off: b.classList.contains('off'),
})), MENU)
const title = (app) => app.eval((sel) => document.querySelector(`${sel} header h2`)?.textContent ?? '', MENU)
const composer = (app) => app.eval(() => document.querySelector('[data-test="chat-input"]')?.value ?? '')

async function freshChat(app, cwd) {
  await newGame(app, cwd)
  await fastText(app)
  // A draft a previous test's rewind put back stays in the composer across chats.
  await app.setValue(T('chat-input'), '')
}

/** Sends a prompt and waits for her whole answer, so the prompt is idle again. */
async function prompt(app, text) {
  const m = await say(app, text)
  await turnEnd(app, m)
  await readAll(app)
}

/** Esc Esc on the empty, idle prompt. */
async function escEsc(app) {
  await app.waitFor(() => !document.querySelector('[data-test="chat-input"]')?.disabled && !document.querySelector('[data-test="chat-input"]').value, { label: 'idle, empty prompt' })
  await app.key('Escape')
  await app.key('Escape')
  await app.waitVisible(`${MENU} ${T('menu-row')}`)
}

const ctlSent = (app, from, op) => app.sent(from, 'ctl').then((list) => list.filter((c) => c.op === op))

export default {
  name: 'Rewind',
  tests: [
    {
      r: 'R61',
      name: 'Esc Esc lists the prompts newest first; "Restore code and conversation" rewinds files, restarts cut before the prompt, and puts it back',
      timeout: 120_000,
      async run({ app, project }) {
        await freshChat(app, project)
        // A first prompt, so the two under test both have an entry before them to cut at.
        await prompt(app, 'hello there')
        await prompt(app, 'fix the loader')
        await prompt(app, 'now the booking flow')

        const m = await app.mark()
        await escEsc(app)
        eq(await title(app), 'Rewind', 'titled Rewind')
        const list = await rows(app)
        eq(list.map((r) => r.label).join(' | '), '(current) | now the booking flow | fix the loader | hello there', 'newest first, after (current)')
        assert(list[0].off, '(current) is not pickable')
        eq(list[2].hint, 'app.ts +3 −1', "the row's code changes")
        const dry = await ctlSent(app, m, 'rewindFiles')
        assert(dry.length >= 3 && dry.every((c) => c.args[1]?.dryRun === true), `list stats come from dry runs: ${JSON.stringify(dry)}`)

        const older = list[2].id
        await app.click(row(older))
        await app.waitVisible(row('both'))
        const opts = await rows(app)
        eq(opts.map((r) => r.label).join(' | '), 'Restore code and conversation | Restore conversation | Restore code | Never mind', 'the CLI options')
        assert(opts[0].hint.includes('The code will be restored +3 −1 in app.ts.'), `code line: ${opts[0].hint}`)
        await app.waitText(`${MENU} .menu-foot`, 'need claude in a terminal')

        const before = await app.mark()
        await app.click(row('both'))
        const restart = await app.waitSent('start', { dropsTurn: older }, before, 15_000)
        assert(restart.resume, 'restarts the same save')
        assert(restart.resumeAt?.endsWith('-reply'), `cut at the entry before the prompt: ${restart.resumeAt}`)
        const sent = await app.sent(before)
        const code = sent.findIndex((s) => s.t === 'ctl' && s.op === 'rewindFiles' && s.args[0] === older && !s.args[1]?.dryRun)
        const st = sent.findIndex((s) => s.t === 'start')
        assert(code >= 0 && code < st, 'the code is restored before the restart')
        await app.waitEvent('ready', { epoch: restart.epoch }, before, 20_000)
        await app.waitFor(() => document.querySelector('[data-test="chat-input"]')?.value === 'fix the loader', { label: 'the old prompt is back in the composer' })
      },
    },
    {
      r: 'R61',
      name: 'the first prompt with no code changes offers only "Restore conversation", which starts fresh with the prompt as the draft',
      timeout: 90_000,
      async run({ app, project }) {
        await freshChat(app, project)
        await prompt(app, 'no code here please')
        await escEsc(app)
        const list = await rows(app)
        eq(list[1].hint, 'No code changes', 'no code changes on the row')
        await app.click(row(list[1].id))
        await app.waitVisible(row('conversation'))
        eq((await rows(app)).map((r) => r.label).join(' | '), 'Restore conversation | Never mind', 'no code options')
        const m = await app.mark()
        await app.click(row('conversation'))
        if (await app.waitVisible('#confirm', 5000).catch(() => false)) await app.click('#confirmYes')
        const fresh = await app.waitFor((f) => window.__e2e.sent.slice(f).find((s) => s.t === 'start' && !s.resume), { args: [m.sent], label: 'a fresh start' })
        await app.waitEvent('ready', { epoch: fresh.epoch }, m, 20_000)
        eq(await composer(app), 'no code here please', 'the prompt is back in the composer')
        assert(!(await ctlSent(app, m, 'rewindFiles')).length, 'no code restore')
      },
    },
    {
      r: 'R61',
      name: '/rewind with nothing sent says "Nothing to rewind to yet."; Esc closes',
      async run({ app, project }) {
        await freshChat(app, project)
        await focusInput(app)
        await app.type('/rewind')
        await app.key('Enter')
        await app.waitText(MENU, 'Nothing to rewind to yet.')
        await app.key('Escape')
        await app.waitHidden(MENU)
      },
    },
  ],
}
