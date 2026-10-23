// Unit check of link/src/mock.ts: drives every scenario with a fake emit and checks the event
// sequences the app relies on. Run: node tests/unit/mock.test.mjs   (no app, no Claude).
process.env.WC_MOCK_TICK_MS ??= '1'
process.env.WC_DATA_DIR ??= (await import('node:os')).tmpdir()

const { createMockSession, MOCK, MAX_OUTPUT } = await import('../../link/src/mock.ts')
const { defaultSettings, addressOf } = await import('../../link/src/settings.ts')
const { EMOTIONS } = await import('../../link/src/protocol.ts')

const TURN_TIMEOUT_MS = 10_000
const TAG = new RegExp(`\\[(${EMOTIONS.join('|')})\\]`)

let failures = 0
const results = []

function check(cond, msg) {
  if (!cond) throw new Error(msg)
}

/** A session whose events are recorded; `until(pred)` resolves at the first matching event from index `from`. */
function session(opts = {}) {
  const events = []
  const waiters = new Set()
  const settings = defaultSettings()
  settings.profile.callMe = 'Yodha'
  const s = createMockSession({
    epoch: 1,
    cwd: 'C:/work/booking-agent',
    settings,
    ...opts,
    emit(e) {
      events.push(e)
      for (const w of waiters) w()
    },
  })
  const until = (pred, label = 'event', from = 0) =>
    new Promise((resolve, reject) => {
      const find = () => events.slice(from).find(pred)
      if (find()) return resolve(find())
      const timer = setTimeout(() => (waiters.delete(poll), reject(new Error(`timed out waiting for ${label}`))), TURN_TIMEOUT_MS)
      const poll = () => {
        const hit = find()
        if (hit) waiters.delete(poll), clearTimeout(timer), resolve(hit)
      }
      waiters.add(poll)
    })
  const mark = () => events.length
  const since = (k) => events.slice(k)
  return { s, events, until, mark, since, settings }
}

const ASKS = new Set(['ask_permission', 'ask_question', 'ask_plan'])
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms))

/** Runs one turn of `text`, answering asks with `onAsk`, and returns its events up to the stats after turn_end. */
async function turn(h, text, onAsk) {
  const from = h.mark()
  h.s.say(text)
  for (let k = from; ; k++) {
    const e = await h.until((_, i) => i === 0, `turn_end of "${text}"`, k)
    if (ASKS.has(e.t)) onAsk?.(e)
    if (e.t === 'turn_end' || e.t === 'ended') break
  }
  await settle()
  return h.since(from)
}

function textOf(evs) {
  return evs.filter((e) => e.t === 'text').map((e) => e.delta).join('')
}

function commonChecks(evs) {
  const text = textOf(evs)
  check(!TAG.test(text), `emotion tag leaked into text: ${text.match(TAG)?.[0]}`)
  const tools = evs.filter((e) => e.t === 'tool').map((e) => e.id)
  const done = new Set(evs.filter((e) => e.t === 'tool_done').map((e) => e.id))
  const end = evs.find((e) => e.t === 'turn_end')
  if (end && !end.interrupted) for (const id of tools) check(done.has(id), `tool ${id} has no tool_done`)
  if (evs.some((e) => e.t === 'text')) check(evs.some((e) => e.t === 'text_end'), 'text without text_end')
  if (end) {
    const k = evs.indexOf(end)
    check(evs.slice(k).some((e) => e.t === 'stats'), 'no stats after turn_end')
  }
}

async function test(name, fn) {
  try {
    await fn()
    results.push(['PASS', name])
  } catch (e) {
    failures++
    results.push(['FAIL', name, e.message])
  }
}

await test('start emits ready (commands, models) then stats', async () => {
  const h = session()
  await h.s.start()
  const ready = h.events.find((e) => e.t === 'ready')
  check(ready, 'no ready')
  for (const n of ['compact', 'context', 'cost', 'clear', 'model', 'init', 'review', 'triage-workflow']) {
    check(ready.commands.some((c) => c.name === n), `missing command ${n}`)
  }
  check(ready.commands.find((c) => c.name === 'triage-workflow').builtin === false, 'triage-workflow must be a skill')
  check(ready.commands.length >= 8, 'slash picker needs more than 5 rows to scroll')
  check(['default', 'opus', 'sonnet', 'haiku'].every((v) => ready.models.some((m) => m.value === v && m.resolved)), 'models')
  check(ready.mode === 'default', 'mode')
  check(h.events.findIndex((e) => e.t === 'stats') > h.events.indexOf(ready), 'stats after ready')
  check(h.s.sessionId() === ready.sessionId, 'sessionId()')
})

await test('emotions: tags split across deltas become face events in order', async () => {
  const h = session()
  await h.s.start()
  const evs = await turn(h, 'show me your emotions')
  commonChecks(evs)
  const faces = evs.filter((e) => e.t === 'face').map((e) => e.emotion)
  check(JSON.stringify(faces) === JSON.stringify(MOCK.emotionsOrder), `faces ${faces}`)
  const text = textOf(evs)
  check(!text.includes('['), 'a [ reached the text')
  check(text.includes(addressOf(h.settings)), 'uses the address from settings')
  check(text.split('\n\n').length === 3, 'three paragraphs')
  // Each face must come after the text that precedes its tag.
  const k = evs.findIndex((e) => e.t === 'face' && e.emotion === 'think')
  check(textOf(evs.slice(0, k)).endsWith('stale '), 'think fires right after "stale "')
  const end = evs.find((e) => e.t === 'turn_end')
  check(end.ok && !end.interrupted, 'turn_end ok')
})

await test('tools: Read/Grep/Edit/Bash/Agent, todos, agent running→done, phases, truncation', async () => {
  const h = session()
  await h.s.start()
  const evs = await turn(h, 'use some tools please')
  commonChecks(evs)
  const names = evs.filter((e) => e.t === 'tool').map((e) => e.name)
  for (const n of ['Read', 'Grep', 'Edit', 'Bash', 'Agent', 'TaskCreate']) check(names.includes(n), `no ${n}`)
  check(evs.some((e) => e.t === 'tool' && e.sub), 'no subagent tool')
  const agent = evs.filter((e) => e.t === 'agent').map((e) => e.status)
  check(agent.join() === 'running,done', `agent ${agent}`)
  const todos = evs.filter((e) => e.t === 'todos')
  check(todos.length >= 4, 'todos updates')
  check(todos.at(-1).items.every((t) => t.status === 'completed'), 'all quests completed')
  check(todos.some((t) => t.items.some((i) => i.status === 'in_progress')), 'in_progress seen')
  const phases = new Set(evs.filter((e) => e.t === 'progress').map((e) => e.phase))
  for (const p of ['thinking', 'writing', 'tool']) check(phases.has(p), `phase ${p}`)
  check(evs.some((e) => e.t === 'progress' && e.phase === 'tool' && e.note?.startsWith('Bash')), 'ribbon note')
  const bigId = evs.find((e) => e.t === 'tool' && e.detail.endsWith('agent.log')).id
  const big = evs.find((e) => e.t === 'tool_done' && e.id === bigId).output
  check(big.length > MAX_OUTPUT && big.length < MAX_OUTPUT + 200 && big.includes('truncated'), `big output ${big.length}`)
})

for (const decision of ['allow', 'always', 'deny', 'feedback']) {
  await test(`permission: Edit with diff, answer ${decision}`, async () => {
    const h = session()
    await h.s.start()
    let ask
    const evs = await turn(h, 'ask permission to edit', (e) => {
      ask = e
      h.s.answerPermission(e.id, decision, decision === 'feedback' ? 'use a config flag' : undefined)
    })
    commonChecks(evs)
    check(ask?.t === 'ask_permission' && ask.tool === 'Edit' && ask.diffs.length === 1 && ask.canAlways && !ask.danger, 'ask shape')
    check(ask.diffs[0].before.includes('v12') && ask.diffs[0].after.includes('v14'), 'diff')
    check(evs.some((e) => e.t === 'state' && e.state === 'requires_action'), 'requires_action')
    const end = evs.find((e) => e.t === 'turn_end')
    const done = evs.find((e) => e.t === 'tool_done')
    if (decision === 'deny') {
      check(end.interrupted && !end.ok && done.ok === false, 'deny stops the turn')
    } else {
      check(end.ok && !end.interrupted, 'continues')
      check(done.ok === (decision !== 'feedback'), 'tool result')
      if (decision === 'feedback') check(textOf(evs).includes('use a config flag'), 'feedback reaches her')
    }
  })
}

await test('danger: git reset --hard with danger:true, defaultToNo', async () => {
  const h = session()
  await h.s.start()
  let ask
  const evs = await turn(h, 'do something dangerous', (e) => ((ask = e), h.s.answerPermission(e.id, 'allow')))
  commonChecks(evs)
  check(ask.tool === 'Bash' && ask.danger && ask.defaultToNo && ask.detail === MOCK.dangerCommand && !ask.canAlways, 'ask')
})

await test('question: single + multiSelect, answers reach the reply', async () => {
  const h = session()
  await h.s.start()
  let ask
  const evs = await turn(h, 'ask me a question', (e) => {
    ask = e
    h.s.answerQuestion(e.id, { [MOCK.question.single]: 'Staging', [MOCK.question.multi]: 'Unit tests, Lint' })
  })
  commonChecks(evs)
  check(ask.t === 'ask_question' && ask.questions.length === 2, 'two questions')
  check(!ask.questions[0].multiSelect && ask.questions[1].multiSelect, 'single then multi')
  check(textOf(evs).includes('Staging first, then: Unit tests, Lint'), 'answers in reply')
})

// The app's Esc on a question answers it with a permission reply (asks.ts), as session.ts accepts.
for (const decision of ['feedback', 'deny']) {
  await test(`question dismissed with a permission ${decision}: the turn ends`, async () => {
    const h = session()
    await h.s.start()
    const evs = await turn(h, 'ask me a question', (e) => h.s.answerPermission(e.id, decision, 'Continue without it.'))
    commonChecks(evs)
    const end = evs.find((e) => e.t === 'turn_end')
    check(end, 'turn_end arrives')
    const done = evs.find((e) => e.t === 'tool_done' && evs.find((t) => t.t === 'tool' && t.id === e.id)?.name === 'AskUserQuestion')
    check(done?.ok === false, 'the question tool is refused')
    if (decision === 'deny') check(end.interrupted && !end.ok, 'deny stops the turn')
    else check(end.ok && textOf(evs).includes(addressOf(h.settings)), 'she carries on in character')
    check(evs.at(-1).t === 'state' && evs.at(-1).state === 'idle', 'back to idle')
  })
}

await test('plan answered with a permission feedback keeps planning; deny stops', async () => {
  const h = session()
  await h.s.start()
  const keep = await turn(h, 'make a plan', (e) => h.s.answerPermission(e.id, 'feedback', 'check the cache too'))
  check(keep.find((e) => e.t === 'turn_end').ok && textOf(keep).includes('check the cache too'), 'keep planning')
  check(!keep.some((e) => e.t === 'stats' && e.stats.mode === 'acceptEdits'), 'mode unchanged')
  const deny = await turn(h, 'make a plan', (e) => h.s.answerPermission(e.id, 'deny'))
  check(deny.find((e) => e.t === 'turn_end').interrupted, 'deny interrupts')
})

await test('fetch: WebFetch permission shows the URL', async () => {
  const h = session()
  await h.s.start()
  let ask
  const evs = await turn(h, 'fetch the docs', (e) => ((ask = e), h.s.answerPermission(e.id, 'allow')))
  commonChecks(evs)
  check(ask?.tool === 'WebFetch' && ask.detail === MOCK.fetchUrl && !ask.diffs.length, 'ask shape')
  check(evs.find((e) => e.t === 'turn_end').ok, 'turn_end ok')
})

await test('a say() from inside the turn_end handler runs after this turn has gone idle', async () => {
  const events = []
  let sent = false
  let s
  const settings = defaultSettings()
  s = createMockSession({
    epoch: 1,
    cwd: 'C:/work/booking-agent',
    settings,
    emit(e) {
      events.push(e)
      if (e.t === 'turn_end' && !sent) (sent = true), s.say('second')
    },
  })
  await s.start()
  s.say('first')
  const deadline = Date.now() + TURN_TIMEOUT_MS
  while (events.filter((e) => e.t === 'turn_end').length < 2 && Date.now() < deadline) await settle(10)
  await settle()
  const k = events.findIndex((e) => e.t === 'turn_end')
  const order = events.slice(k, k + 4).map((e) => (e.t === 'state' ? `state:${e.state}` : e.t))
  check(JSON.stringify(order) === JSON.stringify(['turn_end', 'stats', 'state:idle', 'state:running']), `order ${order}`)
  check(events.filter((e) => e.t === 'turn_end').length === 2, 'the second message ran')
})

for (const decision of ['auto', 'manual', 'keep']) {
  await test(`plan: ask_plan, answer ${decision}`, async () => {
    const h = session()
    await h.s.start()
    let ask
    const evs = await turn(h, 'make a plan', (e) => ((ask = e), h.s.answerPlan(e.id, decision, decision === 'keep' ? 'check the cache too' : undefined)))
    commonChecks(evs)
    check(ask.t === 'ask_plan' && ask.plan.startsWith('# ') && ask.planFile, 'plan shape')
    const modes = evs.filter((e) => e.t === 'stats').map((e) => e.stats.mode)
    if (decision === 'auto') {
      check(modes.includes('acceptEdits'), 'mode acceptEdits')
      check(evs.some((e) => e.t === 'notice' && /auto-accept/.test(e.text)), 'notice')
    }
    if (decision === 'manual') check(modes.at(-1) === 'default', 'mode default')
    if (decision === 'keep') check(textOf(evs).includes('check the cache too'), 'keep message')
  })
}

await test('long: 10-item list, code block, table, long paragraph', async () => {
  const h = session()
  await h.s.start()
  const evs = await turn(h, 'give me a long answer')
  commonChecks(evs)
  const text = textOf(evs)
  check(text.split('\n').filter((l) => l.startsWith('- ')).length === MOCK.longListItems, 'list items')
  check(text.includes('```ts') && text.includes('| staging'), 'code and table')
  check(text.split('\n').some((l) => l.length > 320), 'a paragraph over 320 chars')
  const sentence = text.split('\n').find((l) => l.endsWith(`${MOCK.longSentenceTail}.`))
  check(sentence?.length > 320 && (sentence.match(/[.!?]/g) ?? []).length === 1, 'a single sentence over 320 chars')
})

await test('slow: longer than the success threshold at the default pace, lines between tools', async () => {
  const h = session()
  await h.s.start()
  const evs = await turn(h, 'do the slow rebuild')
  commonChecks(evs)
  const kinds = evs.filter((e) => e.t === 'tool' || e.t === 'text_end').map((e) => e.t)
  check(kinds.join().includes('tool,text_end,tool,text_end'), `text between tools: ${kinds}`)
  check(evs.find((e) => e.t === 'turn_end').ok, 'turn_end ok')
})

await test('markdown: a link and a short list', async () => {
  const h = session()
  await h.s.start()
  const evs = await turn(h, 'show me some markdown')
  commonChecks(evs)
  const text = textOf(evs)
  check(text.includes(`[${MOCK.link.text}](${MOCK.link.href})`), 'link')
  check(MOCK.shortList.every((f) => text.includes(`- \`${f}\``)) && MOCK.shortList.length < 5, 'short list')
})

await test('error: auth error + turn_end ok:false without a second error or cost', async () => {
  const h = session()
  await h.s.start()
  const evs = await turn(h, 'trigger an error')
  const err = evs.find((e) => e.t === 'error')
  check(err?.kind === 'auth' && err.message === MOCK.authMessage, 'auth error')
  const end = evs.find((e) => e.t === 'turn_end')
  check(end && !end.ok && !end.interrupted, 'turn_end ok:false')
  check(end.error === undefined, 'turn_end does not repeat the error')
  const stats = evs.filter((e) => e.t === 'stats').at(-1).stats
  check(stats.costUsd === 0 && stats.turns === 0, 'a failed login costs nothing')
})

await test('api error: error event, turn_end without its own error', async () => {
  const h = session()
  await h.s.start()
  const evs = await turn(h, 'show me an api error')
  check(evs.some((e) => e.t === 'error' && e.kind === 'api'), 'api error')
  const end = evs.find((e) => e.t === 'turn_end')
  check(!end.ok && end.error === undefined, 'turn_end ok:false, no error')
})

await test('crash: error process + ended crashed, then silence', async () => {
  const h = session()
  await h.s.start()
  const evs = await turn(h, 'please crash')
  check(evs.some((e) => e.t === 'error' && e.kind === 'process'), 'process error')
  check(evs.at(-1).t === 'ended' && evs.at(-1).reason === 'crashed', 'ended crashed')
  const n = h.events.length
  h.s.say('hello?')
  await settle(50)
  check(h.events.length === n, 'a crashed session stays silent')
})

await test('/context and /cost: command notices, no turn counted', async () => {
  const h = session()
  await h.s.start()
  for (const cmd of ['/context', '/cost']) {
    const evs = await turn(h, cmd)
    const notice = evs.find((e) => e.t === 'notice')
    check(notice?.kind === 'command', `${cmd} notice`)
    check(cmd === '/context' ? notice.text.includes('Context Usage') : notice.text.includes('Total cost'), `${cmd} text`)
    check(evs.find((e) => e.t === 'turn_end').ok, 'turn_end ok')
  }
  const stats = h.events.filter((e) => e.t === 'stats').at(-1).stats
  check(stats.turns === 0, 'local commands are not turns')
})

await test('/clear: new session id and stats reset', async () => {
  const h = session()
  await h.s.start()
  await turn(h, 'hello there')
  const before = h.s.sessionId()
  const statsBefore = h.events.filter((e) => e.t === 'stats').at(-1).stats
  check(statsBefore.turns === 1 && statsBefore.costUsd > 0, 'a turn was counted')
  const evs = await turn(h, '/clear')
  const sid = evs.find((e) => e.t === 'session_id')
  check(sid && sid.sessionId !== before && h.s.sessionId() === sid.sessionId, 'session id changed')
  const stats = evs.filter((e) => e.t === 'stats').at(-1).stats
  check(stats.turns === 0 && stats.costUsd === 0 && stats.tokensIn === 0, 'stats reset')
})

await test('/unknown and skills', async () => {
  const h = session()
  await h.s.start()
  const unknown = await turn(h, '/contxt')
  check(unknown.find((e) => e.t === 'notice')?.text.startsWith('Unknown command: /contxt'), 'unknown')
  const skill = await turn(h, '/triage-workflow')
  check(skill.some((e) => e.t === 'tool' && e.name === 'Skill'), 'skill runs a turn')
})

await test('default echo: address, images and @mentions; stats cumulative', async () => {
  const h = session()
  await h.s.start()
  const from = h.mark()
  h.s.say('look at @src/app.ts', [{ mediaType: 'image/png', data: 'AAAA' }])
  await h.until((e) => e.t === 'turn_end', 'turn_end', from)
  await settle()
  const evs = h.since(from)
  commonChecks(evs)
  const text = textOf(evs)
  check(text.includes('1 image') && text.includes('`src/app.ts`'), `echo: ${text}`)
  check(evs.filter((e) => e.t === 'face').length >= 1, 'echo has tags')
  await turn(h, 'again')
  const costs = h.events.filter((e) => e.t === 'stats').map((e) => e.stats.costUsd)
  check(costs.at(-1) > costs[costs.length - 3], 'cost grows')
  check(h.events.filter((e) => e.t === 'stats').at(-1).stats.turns === 2, 'turns')
})

await test('interrupt: mid-stream and while asking', async () => {
  const h = session()
  await h.s.start()
  const from = h.mark()
  h.s.say('show me your emotions')
  await h.until((e) => e.t === 'text', 'first text', from)
  await h.s.interrupt()
  const end = await h.until((e) => e.t === 'turn_end', 'turn_end', from)
  check(end.interrupted, 'interrupted')
  const evs = h.since(from)
  check(evs.some((e) => e.t === 'text_end'), 'open text block closed')
  const from2 = h.mark()
  h.s.say('ask permission')
  const ask = await h.until((e) => e.t === 'ask_permission', 'ask', from2)
  await h.s.interrupt()
  await h.until((e) => e.t === 'ask_cancel' && e.id === ask.id, 'ask_cancel', from2)
  const end2 = await h.until((e) => e.t === 'turn_end', 'turn_end 2', from2)
  check(end2.interrupted, 'interrupted while asking')
  h.s.answerPermission(ask.id, 'allow')
  await settle(20)
  check(!h.since(from2).some((e) => e.t === 'tool_done' && e.ok), 'a late answer does nothing')
})

await test('messages sent mid-turn run afterwards, in order', async () => {
  const h = session()
  await h.s.start()
  const from = h.mark()
  h.s.say('first message')
  h.s.say('second message')
  const first = await h.until((e) => e.t === 'turn_end', 'first turn_end', from)
  await h.until((e) => e.t === 'turn_end', 'second turn_end', h.events.indexOf(first) + 1)
  const ends = h.since(from).filter((e) => e.t === 'turn_end')
  check(ends.length === 2, `turn_end count ${ends.length}`)
  const text = textOf(h.since(from))
  check(text.indexOf('first message') < text.indexOf('second message'), 'order')
})

await test('shell, setMode, setModel, resume, close', async () => {
  const h = session({ resume: 'resumed-session-id' })
  await h.s.start()
  check(h.s.sessionId() === 'resumed-session-id', 'resume keeps the id')
  check(h.events.find((e) => e.t === 'stats').stats.turns > 0, 'resumed stats are cumulative')
  await h.s.shell('git status')
  const sh = h.events.find((e) => e.t === 'shell_result')
  check(sh?.command === 'git status' && sh.code === 0 && sh.output.includes('On branch'), 'shell_result')
  await h.s.shell('exit 2')
  check(h.events.filter((e) => e.t === 'shell_result').at(-1).code === 2, 'exit code')
  await h.s.setMode('plan')
  check(h.events.at(-1).t === 'stats' && h.events.at(-1).stats.mode === 'plan', 'mode')
  await h.s.setModel('haiku')
  check(h.events.at(-1).stats.model === 'claude-haiku-5-5', 'model resolved')
  h.s.say('a long goodbye')
  await h.until((e) => e.t === 'progress', 'progress')
  h.s.close()
  const n = h.events.length
  check(h.events.at(-1).t === 'ended' && h.events.at(-1).reason === 'closed', 'ended closed')
  await settle(100)
  check(h.events.length === n, 'silent after close')
})

const width = Math.max(...results.map((r) => r[1].length))
for (const [status, name, err] of results) console.log(`${status}  ${name.padEnd(width)}${err ? `  ${err}` : ''}`)
console.log(`\n${results.length - failures}/${results.length} passed`)
process.exit(failures ? 1 : 0)
