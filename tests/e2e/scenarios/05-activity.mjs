// R18–R22: while she works — spinner, ribbon, tool log and detail, permission/question/plan menus,
// quests and party.
import { assert, byText, eq, fastText, focusInput, MOCK, newGame, readAll, say, sleep, T, turnEnd } from '../lib.mjs'

const MIN_ACTIONS = 8
const SPINNER_TICK_MS = 1500
const SPINNER_SHOW_MS = 5000
/** MAX_OUTPUT in link/src/mock.ts: the detail shows the full (capped) result, so it is at least this long. */
const DETAIL_MIN_CHARS = 20_000
/** A little over asks.ts ARM_MS. */
const ASK_ARM_MS = 500

async function freshChat(app, cwd) {
  await newGame(app, cwd)
  await fastText(app)
}

async function askOpen(app, kind, from) {
  await app.waitEvent(`ask_${kind}`, {}, from, 20_000)
  await app.waitVisible(T('ask', { kind }))
}

/** Confirms a multi-select question: its submit option, a button that reads like one, or Enter. */
async function submitAnswers(app) {
  const option = T('ask-option', { v: 'submit' })
  const submit = (await app.exists(option)) ? option : await byText(app, /submit|done|confirm|ok|next/i, T('ask'))
  if (submit) await app.click(submit)
  else await app.key('Enter')
}

const askOptions = (app) => app.attrs(`${T('ask')} ${T('ask-option')}`, 'data-v')

/** The spinner's token count ("↑ 1.2k tokens"), apart from its elapsed seconds. */
const TOKENS = /([\d.]+)\s*(k?)\s*tokens/i
const TOKENS_GROW_MS = 20_000

function spinnerTokens(text) {
  const m = TOKENS.exec(text ?? '')
  return m ? Number(m[1]) * (m[2] ? 1000 : 1) : undefined
}

export default {
  name: 'Activity: spinner, tool log, choice menus, quests, party',
  tests: [
    {
      r: 'R18',
      name: 'thinking spinner with elapsed seconds and tokens, a ribbon with the current tool, a live tool log',
      timeout: 60_000,
      async run({ app, project }) {
        await freshChat(app, project)
        const m = await say(app, 'use some tools please')
        await app.waitVisible(T('spinner'), SPINNER_SHOW_MS)
        const s0 = await app.text(T('spinner'))
        await sleep(SPINNER_TICK_MS)
        const s1 = await app.text(T('spinner'))
        assert(/\d+(\.\d+)?\s*s\b/.test(s1), `elapsed seconds in the spinner: "${s1}"`)
        assert(s0 !== s1, 'the spinner counts up')
        await app.waitEvent('tool', {}, m)
        // The ribbon says what she is doing in words, with the tool's target (a path, a pattern, a command).
        await app.waitFor(
          () =>
            window.__e2e.visible('[data-test="ribbon"]') &&
            /loader\.ts|stalePrompt|npm test|agent\.log|booking|quest/.test(document.querySelector('[data-test="ribbon"]').textContent),
          { label: 'the ribbon shows the running tool and its target' },
        )
        const t0 = spinnerTokens(s1)
        assert(t0 !== undefined, `a token count in the spinner: "${s1}"`)
        await app.waitFor(
          (sel, src, n) => {
            const hit = new RegExp(src, 'i').exec(document.querySelector(sel)?.textContent ?? '')
            return hit && Number(hit[1]) * (hit[2] ? 1000 : 1) > n
          },
          { args: [T('spinner'), TOKENS.source, t0], timeout: TOKENS_GROW_MS, label: `the spinner's token count to grow past ${t0}` },
        )
        await app.waitFor(() => document.querySelectorAll('[data-test="action-item"]').length >= 2, { label: 'the tool log fills while she works' })
        await turnEnd(app, m)
        assert((await app.count(T('action-item'), { visibleOnly: false })) >= MIN_ACTIONS, `at least ${MIN_ACTIONS} actions logged`)
        await app.waitHidden(T('spinner'))
        await readAll(app)
      },
    },
    {
      r: 'R19',
      name: 'clicking a tool log entry opens the full input and result, truncated at 20k with a note',
      timeout: 60_000,
      async run({ app, project }) {
        const bigRead = async () => (await app.events(0, 'tool')).filter((e) => e.detail.replace(/\\/g, '/').endsWith(MOCK.bigLogPath)).at(-1)
        if (!(await bigRead()) || (await app.screen()) !== 'chat') {
          await freshChat(app, project)
          const m = await say(app, 'use some tools please')
          await turnEnd(app, m)
        }
        const tool = await bigRead()
        assert(tool, `a tool call reading ${MOCK.bigLogPath}`)
        await app.click(T('action-item', { id: tool.id }))
        await app.waitVisible(T('action-detail'))
        const detail = await app.text(T('action-detail'))
        assert(detail.includes('file_path'), 'the full input is shown')
        assert(detail.includes('truncated'), 'the truncation note is shown')
        assert(detail.length >= DETAIL_MIN_CHARS, `the full (capped) result is shown: ${detail.length} chars`)
        await app.key('Escape')
        await app.waitHidden(T('action-detail'))
      },
    },
    {
      r: 'R22',
      name: 'quests follow the Task tools; the party shows the subagent running then done',
      timeout: 60_000,
      async run({ app, project }) {
        await freshChat(app, project)
        const m = await say(app, 'use some tools please')
        await app.waitVisible(T('quest-item', { status: 'in_progress' }), 20_000)
        await app.waitVisible(T('party-chip', { status: 'running' }), 20_000)
        await turnEnd(app, m)
        eq(await app.count(T('quest-item'), { visibleOnly: false }), 3, 'three quests')
        const statuses = await app.attrs(T('quest-item'), 'data-status')
        assert(statuses.every((s) => s === 'completed'), `all quests completed: ${statuses}`)
        await app.waitFor(() => document.querySelector('[data-test="party-chip"][data-status="done"]'), { label: 'the subagent is done' })
        await readAll(app)
      },
    },
    {
      r: 'R20',
      name: 'permission: Edit diff; keys 1/2/3 pick Allow once / Always / Deny; Deny stops the turn',
      timeout: 120_000,
      async run({ app, project }) {
        await freshChat(app, project)
        for (const [key, expected] of [['1', 'allow'], ['2', 'always'], ['3', 'deny']]) {
          const m = await say(app, 'ask permission to edit')
          await askOpen(app, 'permission', m)
          await app.waitVisible(T('ask-diff'))
          const diff = await app.text(T('ask-diff'))
          assert(diff.includes('booking-v12') && diff.includes('booking-v14'), 'the diff shows before and after')
          const options = await askOptions(app)
          eq(options.slice(0, 3), ['allow', 'always', 'deny'], 'option order')
          // Number keys arm a moment after the menu opens, so a digit typed just before never picks an option.
          await sleep(ASK_ARM_MS)
          await app.key(key)
          const sent = await app.waitSent('permission', {}, m)
          eq(sent.decision, expected, `key ${key}`)
          const end = await turnEnd(app, m)
          if (expected === 'deny') assert(end.interrupted, 'Deny stops the turn')
          await app.waitHidden(T('ask'))
          await readAll(app)
        }
      },
    },
    {
      r: 'R20',
      name: 'permission: "tell Rem instead" sends feedback and she continues',
      async run({ app, project }) {
        await freshChat(app, project)
        const m = await say(app, 'ask permission to edit')
        await askOpen(app, 'permission', m)
        await app.click(T('ask-other'))
        await app.type('use a config flag')
        await app.key('Enter')
        await app.waitSent('permission', { decision: 'feedback', message: 'use a config flag' }, m)
        await turnEnd(app, m)
        await readAll(app)
        await app.waitText(T('dialogue-text'), 'use a config flag', { label: 'she answers the feedback' })
      },
    },
    {
      r: 'R20',
      name: 'permission for a web tool shows its URL',
      async run({ app, project }) {
        await freshChat(app, project)
        const m = await say(app, 'fetch the template docs')
        await askOpen(app, 'permission', m)
        await app.waitText(T('ask'), MOCK.fetchUrl, { label: 'the URL in the permission menu' })
        await sleep(ASK_ARM_MS)
        await app.click(T('ask-option', { v: 'allow' }))
        await app.waitSent('permission', { decision: 'allow' }, m)
        await turnEnd(app, m)
        await readAll(app)
      },
    },
    {
      r: ['R20', 'R35'],
      name: 'danger: a destructive Bash command gets the danger style, shows the command, defaults to No',
      async run({ app, project }) {
        await freshChat(app, project)
        const m = await say(app, 'do something dangerous')
        await askOpen(app, 'permission', m)
        assert((await app.text(T('ask'))).includes(MOCK.dangerCommand), 'the command is shown')
        const danger = await app.eval((sel) => {
          const el = document.querySelector(sel)
          const flagged = (n) => [...n.classList].some((c) => /danger/i.test(c)) || n.dataset.danger === '1' || n.dataset.danger === 'true'
          return flagged(el) || [...el.querySelectorAll('*')].some(flagged)
        }, T('ask'))
        assert(danger, 'the menu (or an element in it) carries a danger class or data-danger')
        const preselected = await app.eval(() => {
          const opts = [...document.querySelectorAll('[data-test="ask"] [data-test="ask-option"]')]
          const hit = opts.find((o) => o === document.activeElement || o.contains(document.activeElement)) ??
            opts.find((o) => o.getAttribute('aria-selected') === 'true' || /\b(selected|active|focus)\b/.test(o.className))
          return hit?.dataset.v ?? null
        })
        eq(preselected, 'deny', 'defaultToNo preselects Deny')
        await app.click(T('ask-option', { v: 'deny' }))
        await app.waitSent('permission', { decision: 'deny' }, m)
        await turnEnd(app, m)
      },
    },
    {
      r: 'R21',
      name: 'AskUserQuestion: single choice then multi-select; answers reach the model',
      timeout: 60_000,
      async run({ app, project }) {
        await freshChat(app, project)
        const m = await say(app, 'ask me a question')
        await askOpen(app, 'question', m)
        await app.waitText(T('ask'), MOCK.question.single)
        await app.click(T('ask-option', { v: 'Staging' }))
        await app.waitText(T('ask'), MOCK.question.multi)
        await app.click(T('ask-option', { v: 'Unit tests' }))
        await app.click(T('ask-option', { v: 'Lint' }))
        await submitAnswers(app)
        const sent = await app.waitSent('answer', {}, m)
        eq(sent.answers[MOCK.question.single], 'Staging', 'single answer')
        const multi = sent.answers[MOCK.question.multi] ?? ''
        assert(multi.includes('Unit tests') && multi.includes('Lint') && !multi.includes('Chat simulation'), `multi answer "${multi}"`)
        await turnEnd(app, m)
        await readAll(app)
        await app.waitText(T('dialogue-text'), 'Staging first', { label: 'the reply uses the answers' })
      },
    },
    {
      r: 'R21',
      name: 'AskUserQuestion: Other (free text) is the answer itself',
      timeout: 60_000,
      async run({ app, project }) {
        await freshChat(app, project)
        const m = await say(app, 'ask me a question')
        await askOpen(app, 'question', m)
        await app.click(T('ask-other'))
        await app.type('Both, carefully')
        await app.key('Enter')
        await app.waitText(T('ask'), MOCK.question.multi)
        await app.click(T('ask-option', { v: 'Lint' }))
        await submitAnswers(app)
        const sent = await app.waitSent('answer', {}, m)
        eq(sent.answers[MOCK.question.single], 'Both, carefully', 'Other text')
        await turnEnd(app, m)
      },
    },
    {
      r: ['R21', 'R13'],
      name: 'plan approval: the plan is shown; auto approves and the mode badge turns acceptEdits',
      async run({ app, project }) {
        await freshChat(app, project)
        const m = await say(app, 'make a plan')
        await askOpen(app, 'plan', m)
        assert((await app.text(T('ask'))).includes('Fix the stale booking prompt'), 'the plan markdown is shown')
        eq((await askOptions(app)).filter((v) => ['auto', 'manual', 'keep'].includes(v)).sort(), ['auto', 'keep', 'manual'], 'plan options')
        await app.click(T('ask-option', { v: 'auto' }))
        await app.waitSent('plan', { decision: 'auto' }, m)
        await app.waitText(T('badge-mode'), /accept|edit/i, { label: 'badge-mode shows acceptEdits' })
        await turnEnd(app, m)
        await app.eval(() => window.__wc.link.send({ t: 'mode', mode: 'default' }))
        await readAll(app)
      },
    },
    {
      r: 'R21',
      name: 'plan approval: keep planning with a note',
      async run({ app, project }) {
        await freshChat(app, project)
        const m = await say(app, 'make a plan')
        await askOpen(app, 'plan', m)
        await app.click(T('ask-other'))
        await app.type('check the cache too')
        await app.key('Enter')
        const sent = await app.waitSent('plan', {}, m)
        assert(sent.decision === 'keep' && sent.message === 'check the cache too', `plan answer ${JSON.stringify(sent)}`)
        await turnEnd(app, m)
        await focusInput(app)
      },
    },
  ],
}
