// Smoke test against the REAL Agent SDK (no WC_MOCK). It spends plan budget, so it is run by hand only:
//
//   node tests/e2e/real.mjs
//
// Guards: the session must report a Haiku model before anything is sent, and at most MAX_MESSAGES
// messages go out in total (a greeting, one tiny tool use, and /context, which is free). After the last
// one the harness blocks every further `say`.

import { launch, stopVite } from './driver.mjs'
import { EMOTIONS, makeProject, newGame, readAll, removeTempDirs, say, T, turnEnd } from './lib.mjs'

const MAX_MESSAGES = 3
const TURN_MS = 120_000
const PROMPT_POLL_MS = 300
/** The only tools a prompt may be allowed for: this runs on the user's real account. */
const READ_ONLY = new Set(['Glob', 'Grep', 'Read', 'LS'])
const MODEL = 'haiku'
const TAG = new RegExp(`\\[(${EMOTIONS.join('|')})\\]`)

const results = []
const report = (status, what, detail = '') => {
  results.push({ status, what })
  console.log(`${status.padEnd(4)}  ${what}${detail ? `  (${detail})` : ''}`)
}
const check = (cond, what, detail) => report(cond ? 'PASS' : 'FAIL', what, detail)
const soft = (cond, what, detail) => report(cond ? 'PASS' : 'WARN', what, detail)

let sent = 0
async function realSay(app, text) {
  if (sent >= MAX_MESSAGES) throw new Error(`message budget of ${MAX_MESSAGES} used up; refusing to send "${text}"`)
  sent++
  const m = await say(app, text)
  if (sent === MAX_MESSAGES) await app.eval(() => window.__e2e.block.add('say'))
  return m
}

/**
 * Answers permission prompts during the turn: "Allow once" for a read-only tool, so the tiny tool use can
 * finish, and No for anything else (reported as a failure, since the prompt asked for a Glob only).
 */
async function answerPrompts(app, from, isDone) {
  const answered = new Set()
  while (!isDone()) {
    const ask = (await app.events(from, 'ask_permission')).filter((a) => !answered.has(a.id)).at(-1)
    if (ask && (await app.visible(T('ask', { kind: 'permission' })))) {
      answered.add(ask.id)
      const allow = READ_ONLY.has(ask.tool)
      await app.click(T('ask-option', { v: allow ? 'allow' : 'deny' }))
      if (!allow) report('FAIL', `refused a ${ask.tool} permission prompt`, ask.detail)
    }
    await new Promise((r) => setTimeout(r, PROMPT_POLL_MS))
  }
}

let app
try {
  app = await launch({ mock: false, settings: { claude: { model: MODEL } }, tag: 'real' })
  const project = makeProject('real-smoke')
  const start = await newGame(app, project)
  await app.updateSettings({ motion: { textCps: 0, autoDelayMs: 50 } })
  const ready = await app.waitEvent('ready', { epoch: start.epoch }, 0, 60_000)
  // Make sure the session really runs on Haiku before a single message is sent.
  const m0 = await app.mark()
  await app.eval((model) => window.__wc.link.send({ t: 'model', model }), MODEL)
  const stats = await app.waitFor(
    (f) => window.__e2e.events.slice(f).filter((e) => e.t === 'stats').map((e) => e.stats.model).find((x) => /haiku/i.test(x ?? '')),
    { args: [m0.events], timeout: 20_000, label: 'stats.model to report Haiku' },
  ).catch(() => undefined)
  if (!stats && !/haiku/i.test(ready.model ?? '')) throw new Error(`the session is not on Haiku (ready.model=${ready.model}); nothing was sent`)
  check(true, 'session on Haiku before sending', stats ?? ready.model)
  check(ready.commands.length > 0 && ready.models.length > 0, 'ready lists commands and models', `${ready.commands.length} commands`)

  // 1. Persona and inline emotion tags.
  let m = await realSay(app, 'Hi! Who are you? Answer in one short sentence.')
  let end = await turnEnd(app, m, TURN_MS)
  await readAll(app)
  check(end.ok, 'greeting turn ends ok', end.error)
  const faces = await app.events(m, 'face')
  soft(faces.length > 0, 'she uses inline emotion tags', faces.map((f) => f.emotion).join(' '))
  const lines = await app.dialogueLog(m)
  check(!lines.some((d) => TAG.test(d.text)), 'no emotion tag reaches the dialogue')
  const settings = await app.settings()
  const said = lines.map((d) => d.text).join(' ')
  soft(said.includes(settings.waifu.name) || said.includes(settings.profile.callMe), 'the persona shows (her name or how she calls you)', said.slice(0, 120))

  // 2. One tiny, read-only tool use.
  m = await realSay(app, 'Use the Glob tool to list the files in this folder, then tell me how many there are. Be brief.')
  let finished = false
  const turn = turnEnd(app, m, TURN_MS).finally(() => (finished = true))
  // Handled here so a timeout can't crash the process before `finally` closes the app; awaited below.
  turn.catch(() => {})
  await answerPrompts(app, m, () => finished)
  end = await turn
  await readAll(app)
  check(end.ok, 'tool turn ends ok', end.error)
  const tools = await app.events(m, 'tool')
  check(tools.length > 0, 'a tool call is reported', tools.map((t) => t.name).join(', '))
  check((await app.events(m, 'tool_done')).length > 0, 'its result is reported')
  check((await app.count(T('action-item'), { visibleOnly: false })) > 0, 'the tool log shows it')

  // 3. A local slash command (no model turn).
  m = await realSay(app, '/context')
  end = await turnEnd(app, m, TURN_MS)
  const notice = (await app.events(m, 'notice')).find((n) => n.kind === 'command')
  check(Boolean(notice) && /context/i.test(notice.text), '/context output arrives as a command notice', notice?.text.slice(0, 60))

  const last = (await app.events(0, 'stats')).at(-1)?.stats
  const filled = last?.costUsd > 0 && last?.context?.used > 0
  check(filled, 'stats: cost and context are filled', last && `$${last.costUsd.toFixed(4)}, ${last.context?.used} tokens`)
  soft(/haiku/i.test((await app.text(T('badge-model'))) ?? ''), 'badge-model shows Haiku')
} catch (e) {
  report('FAIL', 'real smoke test', e.message)
  await app?.screenshot('real-FAIL').catch(() => {})
} finally {
  await app?.close()
  stopVite()
  removeTempDirs()
}
const tally = (s) => results.filter((r) => r.status === s).length
console.log(`\n${sent} message(s) sent · ${tally('FAIL')} failed, ${tally('WARN')} warnings`)
process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0)
