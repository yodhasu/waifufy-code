// Smoke test against the REAL Agent SDK (no WC_MOCK). It spends plan budget, so it is run by hand only:
//
//   node tests/e2e/real.mjs
//
// Guards: the session must report a Haiku model before anything is sent, and at most MAX_TURNS model turns
// go out: a greeting, one tiny tool use, and a `!git status` she answers (the CLI's respondToBashCommands).
// /context is a local command and costs nothing. After it the harness blocks every further `say` and `shell`.

import { launch, stopVite } from './driver.mjs'
import { EMOTIONS, focusInput, makeProject, newGame, readAll, removeTempDirs, say, T, turnEnd } from './lib.mjs'

const MAX_TURNS = 3
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
/** Sends a message that costs a model turn; a local command (`free`) doesn't count. */
async function realSay(app, text, { free = false } = {}) {
  if (!free && sent >= MAX_TURNS) throw new Error(`budget of ${MAX_TURNS} model turns used up; refusing to send "${text}"`)
  if (!free) sent++
  return say(app, text)
}

/** `!cmd` through the composer; she answers its output, so it costs a model turn. */
async function realShell(app, command) {
  if (sent >= MAX_TURNS) throw new Error(`budget of ${MAX_TURNS} model turns used up; refusing to run "!${command}"`)
  sent++
  const m = await app.mark()
  await focusInput(app)
  await app.type(`!${command}`)
  await app.key('Enter')
  await app.waitSent('shell', {}, m)
  return m
}

/**
 * Answers permission prompts during the turn: "Allow once" for a read-only tool, so the tiny tool use can
 * finish, and No for anything else. `strict`: a refusal is a failure (the prompt asked for a Glob only);
 * otherwise she was free to look further, and the No just ends the turn.
 */
async function answerPrompts(app, from, isDone, { strict = true } = {}) {
  const answered = new Set()
  while (!isDone()) {
    const ask = (await app.events(from, 'ask_permission')).filter((a) => !answered.has(a.id)).at(-1)
    if (ask && (await app.visible(T('ask', { kind: 'permission' })))) {
      answered.add(ask.id)
      const allow = READ_ONLY.has(ask.tool)
      await app.click(T('ask-option', { v: allow ? 'allow' : 'deny' }))
      if (!allow) report(strict ? 'FAIL' : 'INFO', `refused a ${ask.tool} permission prompt`, ask.detail)
    }
    await new Promise((r) => setTimeout(r, PROMPT_POLL_MS))
  }
}

/** Waits for the turn that started at `from` to end, answering its permission prompts meanwhile. */
async function finishTurn(app, from, options) {
  let finished = false
  const turn = turnEnd(app, from, TURN_MS).finally(() => (finished = true))
  // Handled here so a timeout can't crash the process before `finally` closes the app; awaited below.
  turn.catch(() => {})
  await answerPrompts(app, from, () => finished, options)
  return turn
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
  end = await finishTurn(app, m)
  await readAll(app)
  check(end.ok, 'tool turn ends ok', end.error)
  const tools = await app.events(m, 'tool')
  check(tools.length > 0, 'a tool call is reported', tools.map((t) => t.name).join(', '))
  check((await app.events(m, 'tool_done')).length > 0, 'its result is reported')
  check((await app.count(T('action-item'), { visibleOnly: false })) > 0, 'the tool log shows it')

  // 3. `!cmd`: the output is shown, and she answers it in a turn of its own, as the CLI does by default.
  m = await realShell(app, 'git status')
  const shell = await app.waitEvent('shell_result', {}, m, TURN_MS)
  check(/branch/i.test(shell.output), '!git status output arrives', shell.output.split('\n')[0])
  // She may want to look further (a Bash call to check .gitignore, say); that prompt is refused, ending the turn.
  end = await finishTurn(app, m, { strict: false })
  await readAll(app)
  check(end.ok || end.interrupted, 'the !cmd reply turn ends', end.error)
  const answered = (await app.events(m, 'text')).map((e) => e.delta).join('')
  check(answered.trim().length > 0, 'she answers the !cmd output', answered.slice(0, 100))
  // No more model turns from here: only the free local command below may go out.
  await app.eval(() => window.__e2e.block.add('shell'))

  // 4. A local slash command (no model turn).
  m = await realSay(app, '/context', { free: true })
  await app.eval(() => window.__e2e.block.add('say'))
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
console.log(`\n${sent} model turn(s) used · ${tally('FAIL')} failed, ${tally('WARN')} warnings`)
process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0)
