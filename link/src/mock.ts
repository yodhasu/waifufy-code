import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileControl } from './config-files.ts'
import { elicitContent, elicitFields } from './elicit.ts'
import { permissionOptions } from './perm-options.ts'
import type { CanUseTool, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import {
  EMOTIONS,
  type Command,
  type BgTask,
  type CtlOp,
  type RewindPoint,
  type Diff,
  type Emotion,
  type Image,
  type ModelChoice,
  type PersonaPreset,
  type PermissionModeName,
  type Question,
  type SessionEvent,
  type Stats,
  type Todo,
} from './protocol.ts'
import { toPreset, type ResearchOptions } from './research.ts'
import type { SessionApi, SessionFactory, SessionOptions } from './session-api.ts'
import { addressOf } from './settings.ts'
import { voiceActive } from './tts.ts'

// A scripted stand-in for session.ts, used when WC_MOCK=1 (E2E tests, UI work without a plan budget).
// say() picks a scenario by keyword; each one streams the same event shapes, in the same order and at
// a similar pace, as the real Agent SDK session would. No Claude process is ever started.

/** Delay between streamed text deltas. WC_MOCK_TICK_MS shortens it for unit tests. */
const TICK_MS = Number(process.env.WC_MOCK_TICK_MS) || 30
const HANDSHAKE_MS = 8 * TICK_MS
const THINK_MS = 30 * TICK_MS
const TOOL_MS = 12 * TICK_MS
const SHELL_MS = 5 * TICK_MS
/** How long one thinking progress step lasts, and the pause after a todos update. */
const THINK_STEP_MS = 6 * TICK_MS
const TODO_PAUSE_MS = 2 * TICK_MS
/**
 * One build step of the "slow" scenario. Three of them outlast the chat's 20 s threshold for the
 * "finished a long turn" gesture (R35) at the default pace.
 */
const SLOW_STEP_MS = 240 * TICK_MS
/** Same cap as the real session puts on tool results sent to the app (R19). */
export const MAX_OUTPUT = 20_000
const MAX_INPUT = 4_000
/** Delta sizes cycle through these, so words and tags get cut at varied places. */
const CHUNKS = [4, 7, 3, 9, 5, 6, 2, 8]
const CHARS_PER_TOKEN = 4
const CONTEXT_MAX = 200_000
const BASE_CONTEXT = 18_400
const HOUR_MS = 3_600_000
/** Per-turn cost and API time, roughly what a short Opus turn costs. */
const TURN_COST_USD = 0.0412
const TURN_API_MS = 4_800
const TURN_TOKENS_IN = 2_310
const TURN_TOKENS_OUT = 640
const TURN_CACHE_READ = 17_900
const TURN_CACHE_WRITE = 1_420
const TURN_LIMIT_PCT = 0.6
const RESUMED_TURNS = 7
/** Plan limits a fresh mock session starts at, in percent, and when they reset. */
const FIVE_HOUR_PCT = 12
const WEEKLY_PCT = 34
const WEEKLY_OPUS_PCT = 8
const FIVE_HOUR_RESET_MS = 2 * HOUR_MS + 14 * 60_000
const WEEKLY_RESET_MS = 74 * HOUR_MS
/** Context categories, roughly what /context shows for a project with a CLAUDE.md. */
const SYSTEM_TOKENS = 3_100
const TOOLS_TOKENS = 11_800
const MEMORY_TOKENS = 1_900
const AUTOCOMPACT_BUFFER = 33_000
const COMPACT_SUMMARY_TOKENS = 1_200
const THINK_TOKENS_PER_STEP = 9
const RESUMED_COST_USD = 0.4821
/** /cost shows wall time; a session spends roughly this much longer than its API time. */
const WALL_TO_API_RATIO = 1.6
/** How far past MAX_OUTPUT the big log Read goes, so its result is truncated. */
const BIG_LOG_EXTRA = 6_000
const BIG_LOG_FIRST_CONVERSATION = 1000
const DOCS_URL = 'https://docs.example.com/booking-templates'
/** What the CLI tells the model when a tool use is refused, with or without words from the user. */
const REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected."
const REJECTED_SAYING = "The user doesn't want to proceed with this tool use. The user said:\n"

/** What the scenarios produce, for the E2E assertions (tests/e2e) and the unit check. */
export const MOCK = {
  /** Emotions of the "emotions" scenario, in the order the typewriter must reach them. */
  emotionsOrder: ['smile', 'think', 'worried', 'serious', 'happy', 'shy'] as Emotion[],
  longListItems: 10,
  question: {
    single: 'Which environment should I fix first?',
    multi: 'Which checks should I run afterwards?',
  },
  dangerCommand: 'git reset --hard HEAD~1',
  authMessage: 'Not logged in · Please run /login',
  apiMessage: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  crashMessage: 'Claude Code process exited unexpectedly with code 3221225477',
  bigLogPath: 'logs/agent.log',
  fetchUrl: DOCS_URL,
  /** The end of LONG_REPLY's single 320+ character sentence: a collapsed page must never show it (R29). */
  longSentenceTail: 'gets flushed by hand',
  /** The "markdown" reply's link text and target, and its short list (R25). */
  link: { text: 'the template docs', href: DOCS_URL },
  shortList: ['loader.ts', 'booking.md', 'agent.ts'],
}

const COMMANDS: Command[] = [
  { name: 'add-dir', description: 'Add a new working directory', argumentHint: '<path>', builtin: true },
  { name: 'clear', description: 'Clear conversation history and free up context', argumentHint: '', builtin: true },
  { name: 'compact', description: 'Clear conversation history but keep a summary in context', argumentHint: '[instructions]', builtin: true },
  { name: 'context', description: 'Visualize current context usage as a colored grid', argumentHint: '', builtin: true },
  { name: 'cost', description: 'Show the total cost and duration of the current session', argumentHint: '', builtin: true },
  { name: 'effort', description: 'Set the reasoning effort for the current model', argumentHint: '[low|medium|high|xhigh|max]', builtin: true },
  {
    name: 'triage-workflow',
    description: 'Support end-to-end loop for a client complaint about a live AI agent (user)',
    argumentHint: '',
    builtin: false,
  },
  // Two more skills for /skills (W6): a project skill and a plugin skill (plugin skills are locked by their plugin).
  { name: 'release-notes', description: 'Draft release notes from the commits since the last tag (project)', argumentHint: '[tag]', builtin: false },
  { name: 'commit-commands:commit', description: 'Create a git commit with a conventional message (plugin:commit-commands)', argumentHint: '', builtin: false },
  { name: 'init', description: 'Initialize a new CLAUDE.md file with codebase documentation', argumentHint: '', builtin: true },
  { name: 'mcp', description: 'Manage MCP servers', argumentHint: '[reconnect|enable|disable] [server]', builtin: true },
  { name: 'model', description: 'Set the AI model for Claude Code', argumentHint: '[model]', builtin: true },
  { name: 'pr-comments', description: 'Get comments from a GitHub pull request', argumentHint: '', builtin: true },
  { name: 'review', description: 'Review a pull request', argumentHint: '[pr number]', builtin: true },
  {
    name: 'security-review',
    description: 'Complete a security review of the pending changes on the current branch',
    argumentHint: '',
    builtin: true,
  },
  { name: 'usage', description: 'Show plan usage limits', argumentHint: '', builtin: true },
]

const MODELS: ModelChoice[] = [
  { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5 · Most capable for complex work', resolved: 'claude-opus-5-5' },
  { value: 'opus', displayName: 'Opus', description: 'Opus 5.5 · Most capable for complex work', resolved: 'claude-opus-5-5' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5.5 · Best for everyday tasks', resolved: 'claude-sonnet-5-5' },
  { value: 'haiku', displayName: 'Haiku', description: 'Haiku 5.5 · Fastest for quick answers', resolved: 'claude-haiku-5-5' },
]

const resolveModel = (m: string) => MODELS.find((x) => x.value === (m || 'default'))?.resolved ?? m

class Aborted extends Error {}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Aborted())
    const timer = setTimeout(() => (signal.removeEventListener('abort', stop), resolve()), ms)
    const stop = () => (clearTimeout(timer), reject(new Aborted()))
    signal.addEventListener('abort', stop, { once: true })
  })
}

function chunk(text: string) {
  const out: string[] = []
  for (let i = 0, k = 0; i < text.length; k++) {
    const n = CHUNKS[k % CHUNKS.length]!
    out.push(text.slice(i, i + n))
    i += n
  }
  return out
}

const cap = (s: string, max: number) =>
  s.length <= max ? s : `${s.slice(0, max)}\n… [truncated: ${s.length.toLocaleString('en')} characters total, full output in LOG transcript]`

/**
 * Splits streamed text into text and emotion tags, like the real session: a `[` holds the stream back
 * until its `]` (or until it can no longer be a tag), so a tag cut across deltas is still caught.
 */
function tagSplitter(onText: (s: string) => void, onFace: (e: Emotion) => void) {
  const longest = Math.max(...EMOTIONS.map((e) => e.length)) + 2
  let buf = ''
  const take = (n: number) => {
    if (n > 0) onText(buf.slice(0, n))
    buf = buf.slice(n)
  }
  const drain = (isFinal: boolean) => {
    while (buf) {
      const open = buf.indexOf('[')
      if (open === -1) return take(buf.length)
      take(open)
      const close = buf.indexOf(']')
      if (close === -1) {
        if (!isFinal && buf.length < longest) return
        take(1)
        continue
      }
      const word = buf.slice(1, close)
      if (!(EMOTIONS as readonly string[]).includes(word)) {
        take(1)
        continue
      }
      onFace(word as Emotion)
      buf = buf.slice(close + 1).replace(/^ /, '')
    }
  }
  return {
    feed: (s: string) => ((buf += s), drain(false)),
    flush: () => drain(true),
  }
}

function describe(name: string, input: Record<string, unknown>) {
  const v = input.command ?? input.file_path ?? input.pattern ?? input.description ?? input.subject ?? input.url
  return typeof v === 'string' ? v : ''
}

/** `free`: no model usage to count (local commands, and a turn that never got past authentication). */
type Outcome = { ok: boolean; interrupted?: boolean; error?: string; crashed?: boolean; free?: boolean }
type PermissionAnswer = { kind: 'permission'; decision: 'allow' | 'always' | 'deny' | 'feedback'; message?: string }
type QuestionAnswer = { kind: 'question'; answers: Record<string, string> }
type PlanAnswer = { kind: 'plan'; decision: 'auto' | 'manual' | 'keep'; message?: string }
// `message` never set: other scenarios read it off any non-question answer.
type ElicitAnswer = { kind: 'elicit'; action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown>; message?: undefined }
type Answer = PermissionAnswer | QuestionAnswer | PlanAnswer | ElicitAnswer
type Waiting = { resolve(a: Answer): void }

/** How session.ts reads another kind of answer to a permission ask: a plan's 'keep' refuses, anything else allows. */
function asPermission(a: Answer): PermissionAnswer {
  if (a.kind === 'permission') return a
  if (a.kind === 'plan' && a.decision === 'keep') return { kind: 'permission', decision: 'feedback', message: a.message }
  return { kind: 'permission', decision: 'allow' }
}

/** One running turn: its abort signal and the streaming state the scenario helpers share. */
type Turn = { signal: AbortSignal; abort(): void; startedAt: number; tokens: number; textOpen: boolean }

class MockSession implements SessionApi {
  readonly epoch: number
  readonly cwd: string
  private readonly opts: SessionOptions
  private id: string
  private stats: Stats
  /** Prompts sent, oldest first: the rewind menu's points. */
  private prompts: RewindPoint[] = []
  /** Background tasks the mock's `background` scenario starts. */
  private bg: (BgTask & { backgrounded?: boolean })[] = []
  /** The MCP servers /mcp shows; toggling and reconnecting change them. */
  private mcp: MockMcp[] = mockMcpServers()
  private turn?: Turn
  private readonly queue: { text: string; images: Image[] }[] = []
  private readonly waiting = new Map<string, Waiting>()
  private closed = false
  /** Tokens added to context by `!` commands since the last turn. */
  private shellTokens = 0
  private toolSeq = 0

  constructor(opts: SessionOptions) {
    this.opts = opts
    this.epoch = opts.epoch
    this.cwd = opts.cwd
    this.id = opts.resume ?? randomUUID()
    const resumed = opts.resume !== undefined
    this.stats = {
      costUsd: resumed ? RESUMED_COST_USD : 0,
      turns: resumed ? RESUMED_TURNS : 0,
      apiMs: resumed ? RESUMED_TURNS * TURN_API_MS : 0,
      tokensIn: resumed ? RESUMED_TURNS * TURN_TOKENS_IN : 0,
      tokensOut: resumed ? RESUMED_TURNS * TURN_TOKENS_OUT : 0,
      cacheRead: resumed ? RESUMED_TURNS * TURN_CACHE_READ : 0,
      cacheWrite: resumed ? RESUMED_TURNS * TURN_CACHE_WRITE : 0,
      linesAdded: 0,
      linesRemoved: 0,
      context: this.context(resumed ? BASE_CONTEXT + RESUMED_TURNS * TURN_TOKENS_IN : BASE_CONTEXT),
      limits: {
        fiveHour: { pct: FIVE_HOUR_PCT, resetsAt: Date.now() + FIVE_HOUR_RESET_MS, status: 'allowed' },
        weekly: { pct: WEEKLY_PCT, resetsAt: Date.now() + WEEKLY_RESET_MS, status: 'allowed' },
        weeklyOpus: { pct: WEEKLY_OPUS_PCT, resetsAt: Date.now() + WEEKLY_RESET_MS, status: 'allowed' },
      },
      model: resolveModel(opts.settings.claude.model),
      mode: opts.settings.claude.permissionMode,
    }
  }

  sessionId() {
    return this.id
  }

  async start() {
    await new Promise((r) => setTimeout(r, HANDSHAKE_MS))
    if (this.closed) return
    this.emit({
      t: 'ready',
      sessionId: this.id,
      commands: COMMANDS,
      models: MODELS,
      mode: this.stats.mode ?? 'default',
      model: this.stats.model,
      account: 'mock@waifufy.test',
    })
    this.emit({ t: 'state', state: 'idle' })
    this.emitStats()
  }

  say(text: string, images: Image[] = [], _now = false) {
    if (this.closed) return
    // What the rewind menu lists: each prompt, with the entry before it that a rewind keeps.
    if (text.trim() && !text.startsWith('/')) this.prompts.push({ uuid: randomUUID(), text: text.trim(), ...(this.prompts.at(-1) ? { before: `${this.prompts.at(-1)!.uuid}-reply` } : {}) })
    // Like the CLI, a message sent mid-turn waits for the running turn to finish.
    if (this.turn) return void this.queue.push({ text, images })
    void this.run(text, images)
  }

  async shell(command: string) {
    await new Promise((r) => setTimeout(r, SHELL_MS))
    if (this.closed) return
    const { output, code } = fakeShell(command, this.cwd)
    this.shellTokens += Math.ceil((command.length + output.length) / CHARS_PER_TOKEN)
    this.emit({ t: 'shell_result', command, output, code })
    // Like the CLI's default (respondToBashCommands), she answers the output in a turn of its own.
    this.say(`<bash-input>${command}</bash-input>\n<bash-stdout>${output}</bash-stdout><bash-stderr></bash-stderr>`)
  }

  async interrupt() {
    this.turn?.abort()
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.queue.length = 0
    this.turn?.abort()
    this.emit({ t: 'ended', reason: 'closed' })
  }

  async setMode(mode: PermissionModeName) {
    this.stats.mode = mode
    this.emitStats()
  }

  async setModel(model: string) {
    this.stats.model = resolveModel(model)
    this.emitStats()
  }

  /** SDK-shaped answers for the panels' controls (see mockControl), so the E2E suite can drive /mcp, /agents… */
  async control(op: CtlOp, args: unknown[]) {
    if (op === 'rewindPoints') return [...this.prompts].reverse()
    // A prompt that says "no code" changed no files, so its rewind offers only "Restore conversation".
    if (op === 'rewindFiles' && /\bno code\b/i.test(this.prompts.find((p) => p.uuid === args[0])?.text ?? '')) {
      return { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 }
    }
    if (op === 'backgroundTasks') {
      // Ctrl+B: the running mock build moves to the background and the turn ends without it.
      const t = this.bg.find((x) => x.status === 'running' && !x.backgrounded)
      if (t) t.backgrounded = true
      this.emitTasks()
      return !!t
    }
    if (op === 'stopTask') {
      const t = this.bg.find((x) => x.id === args[0])
      if (!t) throw new Error(`No task ${String(args[0])}`)
      t.status = 'killed'
      this.emitTasks()
      return undefined
    }
    // Settings files, CLI subcommands and text reads are real, against the test's own folders (see MOCK_CLAUDE_DIR).
    if (op !== 'cliExec') {
      const files = fileControl(op, args, this.opts.cwd)
      if (files) return files
    }
    // /context reads the CLI's current model; a silent `/model x` changes it CLI-side without a stats event, as in the real link.
    if (op === 'getContextUsage') return { ...mockContextUsage(), model: this.stats.model }
    const pick = op === 'cli' && /^\/model\s+(\S+)/.exec(String(args[0]).trim())?.[1]
    if (pick && MODELS.some((m) => m.value === pick || m.resolved === pick)) this.stats.model = resolveModel(pick)
    return mockControl(this.mcp, op, args)
  }

  answerElicit(id: string, action: ElicitAnswer['action'], content?: Record<string, unknown>) {
    // The same check as session.ts: a form that doesn't fit its schema is refused and stays open.
    if (action === 'accept') elicitContent(elicitFields(MOCK_ELICIT_SCHEMA), content ?? {})
    this.answer(id, { kind: 'elicit', action, content })
  }

  answerPermission(id: string, decision: PermissionAnswer['decision'], message?: string) {
    this.answer(id, { kind: 'permission', decision, message })
  }

  /** Casual exchanges the mock "transcript" got (casual/modes.ts). */
  readonly appended: string[] = []

  appendContext(text: string) {
    this.appended.push(text)
  }

  permit: CanUseTool = async (_name, input) => ({ behavior: 'allow', updatedInput: input })

  answerQuestion(id: string, answers: Record<string, string>) {
    this.answer(id, { kind: 'question', answers })
  }

  answerPlan(id: string, decision: PlanAnswer['decision'], message?: string) {
    this.answer(id, { kind: 'plan', decision, message })
  }

  // ---------------------------------------------------------------- turn plumbing

  private emit(e: SessionEvent) {
    if (this.closed && e.t !== 'ended') return
    this.opts.emit(e)
  }

  private emitStats() {
    this.emit({ t: 'stats', stats: structuredClone(this.stats) })
  }

  private context(used: number): NonNullable<Stats['context']> {
    return {
      used,
      max: CONTEXT_MAX,
      parts: [
        { id: 'system_prompt', tokens: SYSTEM_TOKENS, kind: 'used' },
        { id: 'system_tools', tokens: TOOLS_TOKENS, kind: 'used' },
        { id: 'memory_files', tokens: MEMORY_TOKENS, kind: 'used' },
        { id: 'messages', tokens: Math.max(0, used - SYSTEM_TOKENS - TOOLS_TOKENS - MEMORY_TOKENS), kind: 'used' },
        { id: 'autocompact_buffer', tokens: AUTOCOMPACT_BUFFER, kind: 'buffer' },
      ],
    }
  }

  // Like session.ts, any answer resolves the ask with that id, whatever its kind: the app dismisses a
  // question with a permission 'feedback', for one. Each scenario reads the answer it gets.
  private answer(id: string, a: Answer) {
    const w = this.waiting.get(id)
    if (!w) return
    this.waiting.delete(id)
    w.resolve(a)
  }

  private async run(text: string, images: Image[]) {
    const ctrl = new AbortController()
    const turn: Turn = { signal: ctrl.signal, abort: () => ctrl.abort(), startedAt: Date.now(), tokens: 0, textOpen: false }
    this.turn = turn
    this.emit({ t: 'state', state: 'running' })
    let outcome: Outcome
    try {
      outcome = await this.scenario(turn, text, images)
    } catch (e) {
      if (e instanceof Aborted) outcome = { ok: false, interrupted: true }
      else {
        const message = e instanceof Error ? e.message : String(e)
        this.emit({ t: 'error', kind: 'internal', message })
        outcome = { ok: false, error: message }
      }
    }
    if (turn.textOpen) this.emit({ t: 'text_end' })
    if (this.closed || outcome.crashed) {
      this.turn = undefined
      if (this.closed) return
      this.closed = true
      this.queue.length = 0
      this.opts.emit({ t: 'ended', reason: 'crashed' })
      return
    }
    // The turn stays current until its last event is out, so a say() made from a turn_end handler is
    // queued behind it instead of starting before this turn's stats and idle state.
    this.finish(turn, outcome)
    this.turn = undefined
    const next = this.queue.shift()
    if (next) void this.run(next.text, next.images)
  }

  private finish(turn: Turn, o: Outcome) {
    const s = this.stats
    if (!o.free) {
      s.turns++
      s.costUsd += TURN_COST_USD
      s.apiMs += TURN_API_MS
      s.tokensIn += TURN_TOKENS_IN
      s.tokensOut += TURN_TOKENS_OUT + turn.tokens
      s.cacheRead += TURN_CACHE_READ
      s.cacheWrite += TURN_CACHE_WRITE
      s.context = this.context((s.context?.used ?? BASE_CONTEXT) + TURN_TOKENS_IN + turn.tokens + this.shellTokens)
      this.shellTokens = 0
      for (const l of [s.limits.fiveHour, s.limits.weekly]) if (l) l.pct = Math.round((l.pct + TURN_LIMIT_PCT) * 10) / 10
    }
    this.emit({ t: 'turn_end', ok: o.ok, interrupted: o.interrupted === true, error: o.error, seconds: (Date.now() - turn.startedAt) / 1000 })
    this.emitStats()
    this.emit({ t: 'state', state: 'idle' })
  }

  private async think(turn: Turn, ms = THINK_MS) {
    const steps = Math.max(1, Math.round(ms / THINK_STEP_MS))
    for (let k = 0; k < steps; k++) {
      turn.tokens += THINK_TOKENS_PER_STEP
      this.emit({ t: 'progress', phase: 'thinking', outputTokens: turn.tokens })
      await sleep(ms / steps, turn.signal)
    }
  }

  /** Streams one text block. `deltas` are sent as-is, so a scenario can cut tags on purpose. */
  private async speak(turn: Turn, deltas: string | string[]) {
    const list = typeof deltas === 'string' ? chunk(deltas) : deltas
    const splitter = tagSplitter(
      (delta) => this.emit({ t: 'text', delta }),
      (emotion) => this.emit({ t: 'face', emotion }),
    )
    turn.textOpen = true
    // Like a model with the persona's voice lines: one <ja> line at the end of each paragraph, before the blank line.
    const voiced = this.opts.settings.voice.language === 'ja' && voiceActive(this.opts.settings.voice)
    let lines = 0
    let prevNewline = false
    const voice = () => voiced && this.emit({ t: 'voice', text: `はい、レムにお任せください。${++lines}` })
    try {
      for (const [k, d] of list.entries()) {
        // A blank line may come split across two deltas.
        const at = prevNewline && d.startsWith('\n') ? 0 : d.indexOf('\n\n')
        prevNewline = d.endsWith('\n')
        if (at !== -1) {
          splitter.feed(d.slice(0, at))
          voice()
          splitter.feed(d.slice(at))
        } else splitter.feed(d)
        turn.tokens += Math.ceil(d.length / CHARS_PER_TOKEN)
        if (k % CHUNKS.length === 0) this.emit({ t: 'progress', phase: 'writing', outputTokens: turn.tokens })
        await sleep(TICK_MS, turn.signal)
      }
    } finally {
      splitter.flush()
    }
    voice()
    turn.textOpen = false
    this.emit({ t: 'text_end' })
  }

  private toolStart(turn: Turn, name: string, input: Record<string, unknown>, sub = false) {
    const id = `toolu_mock_${String(++this.toolSeq).padStart(4, '0')}`
    const detail = describe(name, input)
    this.emit({ t: 'progress', phase: 'tool', outputTokens: turn.tokens, note: detail ? `${name} · ${detail}` : name })
    this.emit({ t: 'tool', id, name, detail, input: cap(JSON.stringify(input, null, 2), MAX_INPUT), sub })
    return id
  }

  private toolDone(id: string, output: string, ok = true) {
    this.emit({ t: 'tool_done', id, ok, output: cap(output, MAX_OUTPUT) })
  }

  private async tool(turn: Turn, name: string, input: Record<string, unknown>, output: string, o: { ok?: boolean; sub?: boolean } = {}) {
    const id = this.toolStart(turn, name, input, o.sub)
    await sleep(TOOL_MS, turn.signal)
    this.toolDone(id, output, o.ok)
  }

  private ask(turn: Turn, event: (id: string) => SessionEvent) {
    const id = randomUUID()
    return new Promise<Answer>((resolve, reject) => {
      const cancel = () => {
        if (!this.waiting.delete(id)) return
        this.emit({ t: 'ask_cancel', id })
        reject(new Aborted())
      }
      turn.signal.addEventListener('abort', cancel, { once: true })
      this.waiting.set(id, {
        resolve: (a) => {
          turn.signal.removeEventListener('abort', cancel)
          this.emit({ t: 'state', state: 'running' })
          resolve(a)
        },
      })
      this.emit(event(id))
      this.emit({ t: 'state', state: 'requires_action' })
    })
  }

  private async todos(turn: Turn, items: Todo[]) {
    this.emit({ t: 'todos', items: structuredClone(items) })
    await sleep(TODO_PAUSE_MS, turn.signal)
  }

  // ---------------------------------------------------------------- scenarios

  private scenario(turn: Turn, text: string, images: Image[]): Promise<Outcome> {
    const t = text.trim()
    if (t.startsWith('/')) return this.slash(turn, t)
    if (t.startsWith('<bash-input>')) return this.bashReply(turn, t)
    const k = t.toLowerCase()
    if (/\bcrash/.test(k)) return this.crash(turn)
    if (/\bapi error|\boverloaded/.test(k)) return this.apiError(turn)
    if (/\berror\b/.test(k)) return this.authError(turn)
    if (/\bdanger|\breset\b/.test(k)) return this.danger(turn)
    if (/\bfetch\b/.test(k)) return this.fetch(turn)
    if (/\bpermission/.test(k)) return this.permission(turn)
    if (/\belicit|\bmcp input/.test(k)) return this.elicitation(turn)
    if (/\bbackground\b/.test(k)) return this.background(turn)
    if (/\bquestion/.test(k)) return this.question(turn)
    if (/\bplan\b/.test(k)) return this.plan(turn)
    if (/\bpush\b/.test(k)) return this.push(turn)
    if (/\btools?\b/.test(k)) return this.tools(turn)
    if (/\blong\b/.test(k)) return this.long(turn)
    if (/\bslow\b/.test(k)) return this.slow(turn)
    if (/\bmarkdown\b/.test(k)) return this.markdown(turn)
    if (/\bemotion/.test(k)) return this.emotions(turn)
    if (/\b(good job|well done|thank you|you're the best)\b/.test(k)) return this.praised(turn, 1)
    if (/\b(useless|stupid|i hate you)\b/.test(k)) return this.praised(turn, -1)
    return this.echo(turn, t, images)
  }

  /** The CLI's question line and rows for a prompt, as session.ts words them from the SDK's suggestions. */
  private worded(tool: string, input: Record<string, unknown>, suggestions: PermissionUpdate[]) {
    const o = permissionOptions(tool, input, suggestions, true, this.cwd, this.opts.settings.waifu.name.trim() || 'Claude')
    return { question: o.question, choices: o.choices.map(({ id, label, decision, mode }) => ({ id, label, decision, ...(mode ? { mode } : {}) })) }
  }

  private get addr() {
    return addressOf(this.opts.settings)
  }

  /** Her answer to a `!` command's output. */
  private async bashReply(turn: Turn, text: string): Promise<Outcome> {
    await this.think(turn)
    const command = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(text)?.[1]?.trim() ?? ''
    await this.speak(turn, `[nod] I read the output of \`${command}\`, ${this.addr}. Tell me what you'd like done with it.`)
    return { ok: true }
  }

  private async echo(turn: Turn, text: string, images: Image[]): Promise<Outcome> {
    await this.think(turn)
    const mentions = [...text.matchAll(/(?:^|\s)@(\S+)/g)].map((m) => m[1]!)
    const quoted = text.replace(/\s+/g, ' ').slice(0, 80)
    const parts = [`[smile] Yes, ${this.addr}. You said “${quoted}”.`]
    if (images.length) parts.push(`I can see the ${images.length} image${images.length > 1 ? 's' : ''} you sent me.`)
    if (mentions.length) parts.push(`I'll look at ${mentions.map((m) => `\`${m}\``).join(', ')} for you.`)
    parts.push('[nod] What should we do next?')
    await this.speak(turn, parts.join(' '))
    // The CLI's greyed next-prompt suggestion, only when asked for (other scenarios keep the normal placeholder).
    if (/\bsuggest/i.test(text)) this.emit({ t: 'suggestion', text: 'run the tests and fix what fails' })
    return { ok: true }
  }

  /** Her answer to praise (+1) or an unkind word (-1): the session's affection event, as [affection±] makes it. */
  private async praised(turn: Turn, delta: 1 | -1): Promise<Outcome> {
    await this.think(turn)
    this.emit({ t: 'affection', delta })
    await this.speak(turn, delta > 0
      ? `[shy] E-ehehe… thank you, ${this.addr}. [happy] That makes me really happy.`
      : `[sad] …I'm sorry, ${this.addr}. [serious] I'll do better.`)
    return { ok: true }
  }

  private async emotions(turn: Turn): Promise<Outcome> {
    await this.think(turn)
    // Tags are cut across deltas on purpose: the splitter must hold `[smi` back until `le]` arrives.
    await this.speak(turn, [
      `Found it, ${this.addr}! [smi`,
      'le] The prod prompt is stale [th',
      'ink] it still points at the old **booking** template, so the agent never sees the new opening hours.',
      '\n\n[wor',
      'ried] That explains why the client got the wrong answer twice. [',
      'serious] I want to update the prompt and run the `staging` simulation before touching production.',
      '\n\n',
      '[happy] It is a small fix, so it will not take long. [shy',
      '] Please leave it to me…',
    ])
    return { ok: true }
  }

  private async tools(turn: Turn): Promise<Outcome> {
    await this.think(turn)
    await this.speak(turn, "[think] Let me look around first. I'll write down what I'm doing as quests.")
    const quests: Todo[] = [
      { id: '1', content: 'Read the prompt loader', status: 'pending' },
      { id: '2', content: 'Compare staging and production prompts', status: 'pending' },
      { id: '3', content: 'Fix the stale template and run the tests', status: 'pending' },
    ]
    for (const q of quests) {
      await this.tool(turn, 'TaskCreate', { subject: q.content, description: q.content }, `Task #${q.id} created successfully: ${q.content}`)
      await this.todos(turn, quests.slice(0, Number(q.id)))
    }
    quests[0]!.status = 'in_progress'
    await this.todos(turn, quests)
    await this.tool(turn, 'Read', { file_path: join(this.cwd, 'src', 'prompts', 'loader.ts') }, LOADER_SOURCE)
    await this.tool(turn, 'Grep', { pattern: 'stalePrompt', path: this.cwd, output_mode: 'content' }, GREP_OUTPUT)
    quests[0]!.status = 'completed'
    quests[1]!.status = 'in_progress'
    await this.todos(turn, quests)

    const agentId = this.toolStart(turn, 'Agent', {
      description: 'Compare staging prompts',
      subagent_type: 'Explore',
      prompt: 'Compare prompts/staging and prompts/production and report differences in the booking rules.',
    })
    this.emit({ t: 'agent', id: agentId, description: 'Compare staging prompts', status: 'running' })
    const staging = join(this.cwd, 'prompts', 'staging', 'booking.md')
    await this.tool(turn, 'Read', { file_path: staging }, '1\t# Booking rules (v14)\n2\tOpen 09:00–21:00', { sub: true })
    const grep = { pattern: 'opening hours', path: join(this.cwd, 'prompts') }
    await this.tool(turn, 'Grep', grep, 'prompts/production/booking.md:2', { sub: true })
    this.emit({ t: 'agent', id: agentId, description: 'Compare staging prompts', status: 'done' })
    this.toolDone(agentId, 'Staging uses template v14 (09:00–21:00); production still loads v12 (10:00–18:00).')
    quests[1]!.status = 'completed'
    quests[2]!.status = 'in_progress'
    await this.todos(turn, quests)

    await this.tool(
      turn,
      'Edit',
      { file_path: join(this.cwd, 'src', 'prompts', 'loader.ts'), old_string: "'booking-v12'", new_string: "'booking-v14'" },
      `The file ${join(this.cwd, 'src', 'prompts', 'loader.ts')} has been updated successfully.`,
    )
    this.stats.linesAdded = (this.stats.linesAdded ?? 0) + 1
    this.stats.linesRemoved = (this.stats.linesRemoved ?? 0) + 1
    await this.tool(turn, 'Bash', { command: 'npm test', description: 'Run the unit tests' }, TEST_OUTPUT)
    await this.tool(turn, 'Read', { file_path: join(this.cwd, MOCK.bigLogPath) }, bigLog())
    quests[2]!.status = 'completed'
    await this.todos(turn, quests)
    await this.speak(turn, '[happy] All three quests are done! Production now loads the v14 template, and all 42 tests pass.')
    return { ok: true }
  }

  private async permission(turn: Turn): Promise<Outcome> {
    await this.think(turn)
    await this.speak(turn, '[think] The loader still pins the old template. I need to change one line.')
    const path = join(this.cwd, 'src', 'prompts', 'loader.ts')
    const input = { file_path: path, old_string: "const TEMPLATE = 'booking-v12'", new_string: "const TEMPLATE = 'booking-v14'" }
    const id = this.toolStart(turn, 'Edit', input)
    const diffs: Diff[] = [
      {
        path,
        before: "import { load } from './fs'\n\nconst TEMPLATE = 'booking-v12'\n\nexport const prompt = () => load(TEMPLATE)\n",
        after: "import { load } from './fs'\n\nconst TEMPLATE = 'booking-v14'\n\nexport const prompt = () => load(TEMPLATE)\n",
      },
    ]
    const a = asPermission(await this.ask(turn, (askId) => ({
      t: 'ask_permission',
      id: askId,
      tool: 'Edit',
      title: 'Edit loader.ts',
      detail: path,
      diffs,
      canAlways: true,
      danger: false,
      defaultToNo: false,
      ...this.worded('Edit', input, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]),
    })))
    if (a.decision === 'deny') {
      // The CLI's "No": the tool fails and the turn stops, like an interrupt.
      this.toolDone(id, REJECTED, false)
      return { ok: false, interrupted: true }
    }
    if (a.decision === 'feedback') {
      this.toolDone(id, `${REJECTED_SAYING}${a.message ?? ''}`, false)
      await this.speak(turn, `[nod] Understood, ${this.addr}. I'll do it your way instead: “${a.message ?? ''}”.`)
      return { ok: true }
    }
    await sleep(TOOL_MS, turn.signal)
    this.toolDone(id, `The file ${path} has been updated successfully.`)
    this.stats.linesAdded = (this.stats.linesAdded ?? 0) + 1
    this.stats.linesRemoved = (this.stats.linesRemoved ?? 0) + 1
    const always = a.decision === 'always' ? " I'll remember that I may edit files here." : ''
    await this.speak(turn, `[happy] Done! The loader uses the v14 template now.${always}`)
    return { ok: true }
  }

  private async danger(turn: Turn): Promise<Outcome> {
    await this.think(turn)
    await this.speak(turn, '[worried] The last commit broke the build. The quickest way back is a hard reset…')
    const input = { command: MOCK.dangerCommand, description: 'Discard the last commit and all uncommitted changes' }
    const id = this.toolStart(turn, 'Bash', input)
    const a = asPermission(await this.ask(turn, (askId) => ({
      t: 'ask_permission',
      id: askId,
      tool: 'Bash',
      title: 'Run a destructive command',
      detail: MOCK.dangerCommand,
      diffs: [],
      canAlways: false,
      danger: true,
      defaultToNo: true,
      reason: 'Discards the last commit and every uncommitted change. This cannot be undone.',
    })))
    if (a.decision === 'deny') {
      this.toolDone(id, REJECTED, false)
      return { ok: false, interrupted: true }
    }
    if (a.decision === 'feedback') {
      this.toolDone(id, `${REJECTED_SAYING}${a.message ?? ''}`, false)
      await this.speak(turn, '[nod] Right, nothing gets thrown away. I will revert the commit properly instead.')
      return { ok: true }
    }
    await sleep(TOOL_MS, turn.signal)
    this.toolDone(id, 'HEAD is now at 3fb8a17 v1 contracts: protocol v2, settings schema, module interfaces, app shell')
    await this.speak(turn, '[sigh] It is done. We are back at the last good commit.')
    return { ok: true }
  }

  private async fetch(turn: Turn): Promise<Outcome> {
    await this.think(turn)
    await this.speak(turn, '[think] The template docs should say which version is current. May I read them?')
    const input = { url: MOCK.fetchUrl, prompt: 'Which booking template version is current, and what are its opening hours?' }
    const id = this.toolStart(turn, 'WebFetch', input)
    const a = asPermission(await this.ask(turn, (askId) => ({
      t: 'ask_permission',
      id: askId,
      tool: 'WebFetch',
      title: 'Fetch a web page',
      detail: MOCK.fetchUrl,
      diffs: [],
      canAlways: true,
      danger: false,
      defaultToNo: false,
      ...this.worded('WebFetch', input, [
        { type: 'addRules', rules: [{ toolName: 'WebFetch', ruleContent: `domain:${new URL(MOCK.fetchUrl).hostname}` }], behavior: 'allow', destination: 'localSettings' },
      ]),
    })))
    if (a.decision === 'deny') {
      this.toolDone(id, REJECTED, false)
      return { ok: false, interrupted: true }
    }
    if (a.decision === 'feedback') {
      this.toolDone(id, `${REJECTED_SAYING}${a.message ?? ''}`, false)
      await this.speak(turn, `[nod] All right, no web pages. “${a.message ?? ''}”, then.`)
      return { ok: true }
    }
    await sleep(TOOL_MS, turn.signal)
    this.toolDone(id, 'The current booking template is v14 (since 2026-10-01). Opening hours: 09:00–21:00, every day.')
    await this.speak(turn, '[smile] The docs agree: v14 is current, open from nine to nine.')
    return { ok: true }
  }

  private emitTasks() {
    this.emit({ t: 'bg_tasks', tasks: this.bg.map(({ backgrounded: _, ...t }) => t) })
  }

  /** A long build in a background shell plus a helper agent, and a CLI notification: the /tasks panel's data. */
  private async background(turn: Turn): Promise<Outcome> {
    await this.think(turn)
    const shell: BgTask = { id: `task-${this.bg.length + 1}`, type: 'local_bash', description: 'npm run build -- --watch', status: 'running' }
    const agent: BgTask = { id: `task-${this.bg.length + 2}`, type: 'local_agent', subagent: 'Explore', description: 'Find every caller of loadTemplate', status: 'running', toolUses: 3, tokens: 4100, ms: 9000, lastTool: 'Grep' }
    this.bg.push(shell, agent)
    this.emitTasks()
    this.emit({ t: 'notify', key: 'bg', text: 'Background tasks running · ctrl+b to manage', priority: 'low' })
    await this.speak(turn, `[nod] The build is watching in the background, ${this.addr}, and a helper is looking for callers.`)
    await sleep(TOOL_MS, turn.signal)
    agent.status = 'completed'
    Object.assign(agent, { summary: 'Found 4 callers in src/prompts', toolUses: 7 })
    this.emitTasks()
    return { ok: true }
  }

  /** An MCP server asks for a form (elicitation), as a deploy tool asking which environment and why. */
  private async elicitation(turn: Turn): Promise<Outcome> {
    await this.think(turn)
    const id = this.toolStart(turn, 'mcp__deployer__deploy', { service: 'booking-agent' })
    const fields = elicitFields(MOCK_ELICIT_SCHEMA)
    const a = await this.ask(turn, (askId) => ({ t: 'ask_elicit', id: askId, server: 'deployer', mode: 'form', message: 'Deploy booking-agent: confirm the target', fields }))
    if (a.kind !== 'elicit' || a.action !== 'accept') {
      this.toolDone(id, `The user chose to ${a.kind === 'elicit' ? a.action : 'cancel'} the deploy form.`, false)
      await this.speak(turn, `[nod] All right, ${this.addr}. I won't deploy.`)
      return { ok: true }
    }
    const c = a.content ?? {}
    this.toolDone(id, `Deployed to ${String(c.environment)}`, true)
    await this.speak(turn, `[happy] Deployed to ${String(c.environment)}, ${this.addr}.`)
    return { ok: true }
  }

  private async question(turn: Turn): Promise<Outcome> {
    await this.think(turn)
    await this.speak(turn, '[think] Before I start, I need to know two things.')
    const questions: Question[] = [
      {
        question: MOCK.question.single,
        header: 'Target',
        multiSelect: false,
        options: [
          { label: 'Staging', description: 'Safe to experiment; nobody sees it' },
          { label: 'Production', description: 'What the client sees right now' },
        ],
      },
      {
        question: MOCK.question.multi,
        header: 'Checks',
        multiSelect: true,
        options: [
          { label: 'Unit tests', description: 'npm test, about 20 seconds' },
          { label: 'Chat simulation', description: 'Ten parallel chat-runner conversations' },
          { label: 'Lint', description: 'eslint over the changed files' },
        ],
      },
    ]
    const id = this.toolStart(turn, 'AskUserQuestion', { questions })
    const a = await this.ask(turn, (askId) => ({ t: 'ask_question', id: askId, questions }))
    if (a.kind !== 'question') {
      // Esc on the menu: the app dismisses the question with a permission answer, as the CLI does.
      const deny = a.kind === 'permission' && a.decision === 'deny'
      this.toolDone(id, deny ? REJECTED : `${REJECTED_SAYING}${a.message ?? ''}`, false)
      if (deny) return { ok: false, interrupted: true }
      await this.speak(turn, `[nod] All right, ${this.addr}. I'll start with staging, and you can stop me if that's wrong.`)
      return { ok: true }
    }
    const summary = questions.map((q) => `"${q.question}"="${a.answers[q.question] ?? ''}"`).join(', ')
    this.toolDone(id, `User has answered your questions: ${summary}. You can now continue with the user's answers in mind.`)
    const target = a.answers[MOCK.question.single] ?? '?'
    const checks = a.answers[MOCK.question.multi] ?? 'nothing'
    await this.speak(turn, `[nod] ${target} first, then: ${checks}. [smile] Leave it to me!`)
    return { ok: true }
  }

  private async plan(turn: Turn): Promise<Outcome> {
    await this.think(turn)
    await this.speak(turn, '[think] I looked through everything. Here is my plan, please check it.')
    const planFile = join(homedir(), '.claude', 'plans', 'stale-booking-prompt.md')
    const id = this.toolStart(turn, 'ExitPlanMode', { plan: PLAN, planFilePath: planFile })
    const a = await this.ask(turn, (askId) => ({ t: 'ask_plan', id: askId, plan: PLAN, planFile }))
    if (a.kind === 'permission' && a.decision === 'deny') {
      this.toolDone(id, REJECTED, false)
      return { ok: false, interrupted: true }
    }
    // Another kind of answer reads as session.ts reads it: feedback keeps planning, anything else approves.
    const decision = a.kind === 'plan' ? a.decision : a.kind === 'permission' && a.decision === 'feedback' ? 'keep' : 'manual'
    const message = a.kind === 'question' ? undefined : a.message
    if (decision === 'keep') {
      this.toolDone(id, `The user doesn't want to proceed with this plan yet. The user said:\n${message ?? ''}`, false)
      await this.speak(turn, `[nod] I'll keep planning. ${message ? `About “${message}”: ` : ''}let me look again.`)
      return { ok: true }
    }
    const mode: PermissionModeName = decision === 'auto' ? 'acceptEdits' : 'default'
    this.stats.mode = mode
    this.emitStats()
    this.emit({
      t: 'notice',
      kind: 'info',
      text: mode === 'acceptEdits' ? 'Plan approved · auto-accepting edits' : 'Plan approved · you will review each edit',
    })
    this.toolDone(id, 'User has approved your plan. You can now start coding.')
    await this.tool(
      turn,
      'Edit',
      { file_path: join(this.cwd, 'src', 'prompts', 'loader.ts'), old_string: "'booking-v12'", new_string: "'booking-v14'" },
      `The file ${join(this.cwd, 'src', 'prompts', 'loader.ts')} has been updated successfully.`,
    )
    await this.speak(turn, '[happy] Step one is done. On to the simulation!')
    return { ok: true }
  }

  private async push(turn: Turn): Promise<Outcome> {
    await this.think(turn)
    await this.tool(turn, 'Bash', { command: 'git push origin main', description: 'Push to origin' }, PUSH_OUTPUT)
    await this.speak(turn, '[delighted] Pushed! The fix is on main now.')
    return { ok: true }
  }

  private async long(turn: Turn): Promise<Outcome> {
    await this.think(turn)
    await this.speak(turn, LONG_REPLY)
    return { ok: true }
  }

  /** A turn long enough for the "finished a long turn" gesture, with lines between the tool calls (R35). */
  private async slow(turn: Turn): Promise<Outcome> {
    await this.think(turn)
    await this.speak(turn, '[serious] This needs a full rebuild. It will take a little while.')
    for (const [command, description] of SLOW_STEPS) {
      const id = this.toolStart(turn, 'Bash', { command, description })
      await sleep(SLOW_STEP_MS, turn.signal)
      this.toolDone(id, `> ${command}\n\ndone`)
      await this.speak(turn, `[think] ${description}: done.`)
    }
    await this.speak(turn, `[happy] Everything is rebuilt and green, ${this.addr}!`)
    return { ok: true }
  }

  /** Bold, inline code, a link and a short list: everything the dialogue renders rather than collapses (R25). */
  private async markdown(turn: Turn): Promise<Outcome> {
    await this.think(turn)
    const items = MOCK.shortList.map((f) => `- \`${f}\``).join('\n')
    await this.speak(turn, `[smile] Only three files need the new **template**, see [${MOCK.link.text}](${MOCK.link.href}):\n\n${items}`)
    return { ok: true }
  }

  private async authError(turn: Turn): Promise<Outcome> {
    await this.think(turn)
    this.emit({ t: 'error', kind: 'auth', message: MOCK.authMessage })
    // Like session.ts: the error event already said it, so turn_end carries no error of its own.
    return { ok: false, free: true }
  }

  private async apiError(turn: Turn): Promise<Outcome> {
    await this.think(turn)
    await this.speak(turn, '[think] Let me check the logs…')
    this.emit({ t: 'error', kind: 'api', message: MOCK.apiMessage })
    return { ok: false }
  }

  private async crash(turn: Turn): Promise<Outcome> {
    await this.think(turn)
    this.emit({ t: 'error', kind: 'process', message: MOCK.crashMessage })
    return { ok: false, crashed: true }
  }

  private async slash(turn: Turn, text: string): Promise<Outcome> {
    const [name = '', ...rest] = text.slice(1).split(/\s+/)
    const local = { ok: true, free: true }
    await sleep(TOOL_MS, turn.signal)
    switch (name) {
      case 'context':
        this.emit({ t: 'notice', kind: 'command', text: this.contextReport() })
        return local
      case 'cost':
      case 'usage':
        this.emit({ t: 'notice', kind: 'command', text: this.costReport() })
        return local
      case 'clear':
      case 'reset':
      case 'new':
        this.id = randomUUID()
        this.emit({ t: 'session_id', sessionId: this.id })
        Object.assign(this.stats, { costUsd: 0, turns: 0, apiMs: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 })
        Object.assign(this.stats, { linesAdded: 0, linesRemoved: 0, context: this.context(BASE_CONTEXT) })
        return local
      case 'compact': {
        this.emit({ t: 'progress', phase: 'compacting', outputTokens: 0 })
        await sleep(THINK_MS, turn.signal)
        const before = this.stats.context?.used ?? BASE_CONTEXT
        this.stats.context = this.context(BASE_CONTEXT + COMPACT_SUMMARY_TOKENS)
        const k = (n: number) => `${Math.round(n / 1000)}k`
        this.emit({ t: 'notice', kind: 'compact', text: `Conversation compacted (${k(before)} → ${k(this.stats.context.used)} tokens)` })
        return local
      }
      case 'model':
        if (rest[0]) await this.setModel(rest[0])
        this.emit({ t: 'notice', kind: 'command', text: `Set model to ${this.stats.model}` })
        return local
    }
    if (COMMANDS.some((c) => c.name === name && !c.builtin)) {
      // A skill is a prompt command: it starts a real model turn.
      await this.think(turn)
      await this.tool(turn, 'Skill', { skill: name }, `Launching skill: ${name}`)
      await this.speak(turn, `[serious] Starting the ${name} skill. Paste the client's complaint and I'll trace it.`)
      return { ok: true }
    }
    const near = COMMANDS.find((c) => c.name.startsWith(name.slice(0, 2)))
    this.emit({ t: 'notice', kind: 'command', text: `Unknown command: /${name}${near ? `. Did you mean /${near.name}?` : ''}` })
    return local
  }

  private contextReport() {
    const c = this.stats.context!
    const pct = (n: number) => `${((n / c.max) * 100).toFixed(1)}%`
    const k = (n: number) => `${(n / 1000).toFixed(1)}k`
    const label: Record<string, string> = {
      system_prompt: 'System prompt',
      system_tools: 'System tools',
      memory_files: 'Memory files',
      messages: 'Messages',
      autocompact_buffer: 'Autocompact buffer',
    }
    const rows = c.parts.map((p) => `| ${label[p.id] ?? p.id} | ${k(p.tokens)} | ${pct(p.tokens)} |`)
    const free = c.max - c.used - c.parts.filter((p) => p.kind === 'buffer').reduce((n, p) => n + p.tokens, 0)
    return [
      '## Context Usage',
      '',
      `**Model:** ${this.stats.model}  `,
      `**Tokens:** ${k(c.used)} / ${k(c.max)} (${pct(c.used)})`,
      '',
      '| Category | Tokens | Percentage |',
      '|----------|--------|------------|',
      ...rows,
      `| Free space | ${k(free)} | ${pct(free)} |`,
    ].join('\n')
  }

  private costReport() {
    const s = this.stats
    const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`
    return [
      `Total cost:            $${s.costUsd.toFixed(4)}`,
      `Total duration (API):  ${secs(s.apiMs)}`,
      `Total duration (wall): ${secs(s.apiMs * WALL_TO_API_RATIO)}`,
      `Total code changes:    ${s.linesAdded ?? 0} lines added, ${s.linesRemoved ?? 0} lines removed`,
      'Usage by model:',
      `       ${s.model}:  ${s.tokensIn.toLocaleString('en')} input, ${s.tokensOut.toLocaleString('en')} output, ` +
        `${s.cacheRead.toLocaleString('en')} cache read, ${s.cacheWrite.toLocaleString('en')} cache write ($${s.costUsd.toFixed(4)})`,
    ].join('\n')
  }
}

function fakeShell(command: string, cwd: string): { output: string; code: number | null } {
  const c = command.trim()
  const exit = /^exit\s+(\d+)/.exec(c)
  if (exit) return { output: '', code: Number(exit[1]) }
  if (/^git\s+status/.test(c)) {
    return { output: "On branch main\nYour branch is up to date with 'origin/main'.\n\nnothing to commit, working tree clean", code: 0 }
  }
  if (/^(ls|dir)\b/.test(c)) return { output: 'README.md\npackage.json\nprompts\nsrc\ntests', code: 0 }
  if (/^pwd\b/.test(c)) return { output: cwd, code: 0 }
  const echo = /^echo\s+(.*)$/.exec(c)
  if (echo) return { output: echo[1]!.replace(/^["']|["']$/g, ''), code: 0 }
  return { output: `${c.split(/\s+/)[0]}: ran in ${cwd} (mock shell)`, code: 0 }
}

function bigLog() {
  const lines: string[] = []
  for (let k = 1; lines.join('\n').length < MAX_OUTPUT + BIG_LOG_EXTRA; k++) {
    const at = `2026-10-24T09:${String(k % 60).padStart(2, '0')}:00Z`
    lines.push(`${k}\t${at} INFO agent booking: loaded template booking-v12 for conversation #${BIG_LOG_FIRST_CONVERSATION + k}`)
  }
  return lines.join('\n')
}

const LOADER_SOURCE = [
  "1\timport { load } from './fs'",
  '2\t',
  "3\tconst TEMPLATE = 'booking-v12'",
  '4\t',
  '5\texport const prompt = () => load(TEMPLATE)',
  '6\texport const stalePrompt = TEMPLATE.endsWith(\'v12\')',
].join('\n')

const GREP_OUTPUT = [
  "src/prompts/loader.ts:6:export const stalePrompt = TEMPLATE.endsWith('v12')",
  "src/agent.ts:41:  if (stalePrompt) warn('stale')",
].join('\n')

const TEST_OUTPUT = [
  '> booking-agent@1.4.0 test',
  '> vitest run',
  '',
  ' ✓ src/prompts/loader.test.ts (6 tests) 41ms',
  ' ✓ src/agent.test.ts (36 tests) 388ms',
  '',
  ' Test Files  2 passed (2)',
  '      Tests  42 passed (42)',
  '   Duration  1.92s',
].join('\n')

const SLOW_STEPS = [
  ['npm ci', 'Reinstall the dependencies'],
  ['npm run build', 'Rebuild the agent'],
  ['npm test', 'Run the whole test suite'],
]

const PUSH_OUTPUT = 'To github.com:yodhasu/booking-agent.git\n   3fb8a17..f41032b  main -> main'

const PLAN = [
  '# Fix the stale booking prompt',
  '',
  '1. Point `src/prompts/loader.ts` at the **booking-v14** template.',
  '2. Run the unit tests.',
  '3. Run ten staging chat simulations and compare the answers.',
  '4. Promote the template to production.',
  '',
  '**Risk:** low. Only the template id changes.',
].join('\n')

const LONG_REPLY = [
  "[think] Here is everything I found in the booking agent. It's a lot, so I wrote it all out for you.",
  '',
  'These are the ten places that still read the old template:',
  '',
  ...Array.from({ length: MOCK.longListItems }, (_, k) => `- \`src/flows/step${k + 1}.ts\` loads booking-v12 at startup`),
  '',
  'The fix in each file is the same:',
  '',
  '```ts',
  "import { prompt } from '../prompts/loader'",
  '',
  'export async function step(ctx: Ctx) {',
  '  const system = await prompt()',
  '  return ctx.agent.run({ system, tools: ctx.tools })',
  '}',
  '```',
  '',
  '| Environment | Template | Opening hours |',
  '|-------------|----------|---------------|',
  '| staging     | v14      | 09:00–21:00   |',
  '| production  | v12      | 10:00–18:00   |',
  '',
  '[serious] The production deploy pipeline caches prompts for twenty-four hours. That is why the earlier hotfix never ' +
    'reached the client. The cache key only includes the agent name and not the template version, so even a redeploy ' +
    'keeps serving the stale copy. It stays that way until the cache expires on its own or someone flushes it by hand from the admin panel.',
  '',
  '[worried] The second problem is that every staging simulation since Tuesday has been running against a copy of the production ' +
    'cache that was restored from the nightly backup, which means the ten conversations we compared all saw the same stale template, ' +
    `and the green results we celebrated on Wednesday prove nothing about the new opening hours until that copy ${MOCK.longSentenceTail}.`,
  '',
  '[smile] Shall I fix all ten?',
].join('\n')

export const createMockSession: SessionFactory = (opts) => new MockSession(opts)

// ---------------------------------------------------------------- research (R40)

/** One progress step of the mock research run. */
const RESEARCH_STEP_MS = 12 * TICK_MS
const RESEARCH_SOURCE = 'https://rezero.fandom.com/wiki/Rem'

/**
 * Stand-in for research.ts under WC_MOCK=1: the same progress lines, cancel behaviour and preset shape,
 * with no model call. Notes containing "fail" make it fail, so the error path can be tested too.
 */
export async function mockResearch(o: ResearchOptions): Promise<PersonaPreset> {
  const name = o.name.trim()
  const series = o.series.trim()
  const steps = [
    `Looking up ${name}${series ? ` (${series})` : ''}…`,
    `Searching: ${[name, series, 'personality speech patterns'].filter(Boolean).join(' ')}`,
    `Reading: ${RESEARCH_SOURCE.replace(/^https?:\/\//, '')}`,
    'Writing the roleplay prompt…',
  ]
  try {
    for (const line of steps) {
      o.onProgress(line)
      await sleep(RESEARCH_STEP_MS, o.signal)
    }
  } catch {
    const e = new Error('Research cancelled.')
    e.name = 'AbortError'
    throw e
  }
  if (/\bfail\b/i.test(o.notes)) throw new Error('Research failed: the mock was asked to fail.')
  const preset = toPreset(
    o,
    {
      profile: {
        summary: `${name}${series ? ` from ${series}` : ''}: a mock profile for UI tests.`,
        personality: ['earnest', 'devoted', 'quietly playful'],
        speechPatterns: ['polite, a little formal', 'speaks of herself in the third person when flustered'],
        catchphrases: ['Leave it to me!'],
        addressing: "the user's name with -kun",
        relationshipCues: ['worries when work is risky', 'proud when it goes well'],
        do: ['stay warm and encouraging'],
        dont: ['call the user by a canon character name'],
        sampleLines: ['The tests pass! I did my best.', "That command looks dangerous… are you sure?"],
      },
      prompt: `You are ${name}${series ? ` from ${series}` : ''}. Speak warmly and earnestly. ${o.notes.trim()}`.trim(),
      sources: [RESEARCH_SOURCE],
    },
    [RESEARCH_SOURCE],
  )
  o.onProgress('Done.')
  return preset
}

// ---------------------------------------------------------------- session controls (the CLI's panels)

type MockMcp = {
  name: string
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  scope: string
  config: Record<string, unknown>
  tools: { name: string; description: string; annotations?: { readOnly?: boolean; destructive?: boolean } }[]
  error?: string
}

/** One server per state and scope the CLI's /mcp groups: project, user, claude.ai and built-in. */
function mockMcpServers(): MockMcp[] {
  const tool = (name: string, description: string, readOnly = true) => ({ name, description, annotations: { readOnly } })
  return [
    { name: 'graft', status: 'connected', scope: 'project', config: { type: 'stdio', command: 'graft', args: ['serve'] }, tools: [] },
    { name: 'pencil', status: 'failed', scope: 'user', config: { type: 'stdio', command: 'pencil-mcp' }, tools: [], error: 'Connection closed' },
    { name: 'linear', status: 'needs-auth', scope: 'user', config: { type: 'http', url: 'https://mcp.linear.app/mcp' }, tools: [] },
    {
      name: 'claude.ai Slack', status: 'connected', scope: 'claudeai', config: { type: 'claudeai-proxy', url: 'https://mcp.slack.com', id: 'slack' },
      tools: [tool('slack_send_message', 'Send a message to a channel', false), tool('slack_read_channel', 'Read recent messages in a channel')],
    },
    { name: 'claude-in-chrome', status: 'connected', scope: 'dynamic', config: { type: 'sdk', name: 'claude-in-chrome' }, tools: [tool('navigate', 'Open a URL in a tab', false)] },
  ]
}

const MOCK_AGENTS = [
  { name: 'general-purpose', description: 'General-purpose agent for researching complex questions and multi-step tasks.' },
  { name: 'Explore', description: 'Fast read-only search agent for locating code.', model: 'haiku' },
  { name: 'code-reviewer', description: 'Reviews a diff for bugs.', model: 'sonnet' },
]

/** supportedModels(): the SDK's ModelInfo rows for the MODELS the picker shows (/model, /effort, /fast). */
const MOCK_MODEL_INFO = MODELS.map((m) => ({
  value: m.value,
  resolvedModel: m.resolved,
  displayName: m.displayName,
  description: m.description,
  supportsEffort: true,
  supportedEffortLevels: m.value === 'haiku' ? ['low', 'medium', 'high'] : ['low', 'medium', 'high', 'xhigh', 'max'],
  supportsAdaptiveThinking: m.value !== 'haiku',
  supportsFastMode: m.value !== 'haiku',
  supportsAutoMode: m.value !== 'haiku',
}))

/** What the mock's silent `/fast on|off` and `/effort <level>` have set. */
const mockFast = { on: false, effort: 'auto' }

/**
 * getContextUsage({ detail: 'full' }) in the SDK's SDKControlGetContextUsageResponse shape, with the CLI's 10×10
 * gridRows: each square is 1% of the window, used categories first, the autocompact buffer last, free space between.
 */
function mockContextUsage() {
  const max = 200_000
  const cats = [
    { id: 'system_prompt', name: 'System prompt', tokens: 3100, color: 'promptBorder', kind: 'used' },
    { id: 'system_tools', name: 'System tools', tokens: 11_800, color: 'inactive', kind: 'used' },
    { id: 'mcp_tools', name: 'MCP tools', tokens: 2400, color: 'cyan_FOR_SUBAGENTS_ONLY', kind: 'used' },
    { id: 'custom_agents', name: 'Custom agents', tokens: 600, color: 'permission', kind: 'used' },
    { id: 'memory_files', name: 'Memory files', tokens: 900, color: 'claude', kind: 'used' },
    { id: 'skills', name: 'Skills', tokens: 1500, color: 'warning', kind: 'used' },
    { id: 'messages', name: 'Messages', tokens: 6400, color: 'purple_FOR_SUBAGENTS_ONLY', kind: 'used' },
    { id: 'mcp_tools_deferred', name: 'MCP tools (deferred)', tokens: 4100, color: 'cyan_FOR_SUBAGENTS_ONLY', kind: 'deferred', isDeferred: true },
  ] as const
  const used = cats.filter((c) => c.kind === 'used').reduce((n, c) => n + c.tokens, 0)
  const buffer = { id: 'autocompact_buffer', name: 'Autocompact buffer', tokens: 33_000, color: 'inactive', kind: 'buffer' } as const
  const free = { id: 'free_space', name: 'Free space', tokens: max - used - buffer.tokens, color: 'promptBorder', kind: 'free' } as const
  const per = max / 100
  type Square = { color: string; isFilled: boolean; categoryName: string; tokens: number; percentage: number; squareFullness: number }
  const square = (c: { name: string; color: string; tokens: number }, fullness: number, filled = true): Square =>
    ({ color: c.color, isFilled: filled, categoryName: c.name, tokens: c.tokens, percentage: (c.tokens / max) * 100, squareFullness: fullness })
  const squares: Square[] = []
  for (const c of cats.filter((x) => x.kind === 'used')) {
    const exact = c.tokens / per
    for (let i = 0; i < Math.floor(exact); i++) squares.push(square(c, 1))
    if (exact % 1 > 0) squares.push(square(c, exact % 1))
  }
  const tail = Array.from({ length: Math.round(buffer.tokens / per) }, () => square(buffer, 1))
  while (squares.length < 100 - tail.length) squares.push(square(free, 0, false))
  squares.push(...tail)
  const gridRows = Array.from({ length: 10 }, (_, r) => squares.slice(r * 10, r * 10 + 10))
  return {
    categories: [...cats, free, buffer],
    totalTokens: used,
    maxTokens: max,
    rawMaxTokens: max,
    percentage: Math.round((used / max) * 100),
    gridRows,
    model: 'claude-opus-5-5',
    memoryFiles: [
      { path: 'C:\\Users\\dev\\.claude\\CLAUDE.md', type: 'User', tokens: 400 },
      { path: 'CLAUDE.md', type: 'Project', tokens: 500 },
    ],
    mcpTools: [
      { name: 'mcp__graft__graft_find_code', serverName: 'graft', tokens: 1300, isLoaded: true },
      { name: 'mcp__graft__graft_trace_calls', serverName: 'graft', tokens: 1100, isLoaded: true },
      { name: 'mcp__claude_ai_Slack__slack_send_message', serverName: 'claude_ai_Slack', tokens: 2100, isLoaded: false },
      { name: 'mcp__claude_ai_Slack__slack_read_channel', serverName: 'claude_ai_Slack', tokens: 2000, isLoaded: false },
    ],
    agents: [
      { agentType: 'code-reviewer', source: 'projectSettings', tokens: 250 },
      { agentType: 'general-purpose', source: 'built-in', tokens: 180 },
      { agentType: 'Explore', source: 'built-in', tokens: 170 },
    ],
    skills: {
      totalSkills: 3,
      includedSkills: 3,
      tokens: 1500,
      skillFrontmatter: [
        { name: 'triage-workflow', source: 'userSettings', tokens: 700 },
        { name: 'simplify', source: 'built-in', tokens: 420 },
        { name: 'code-review', source: 'built-in', tokens: 380 },
      ],
    },
    autoCompactThreshold: max - buffer.tokens,
    isAutoCompactEnabled: true,
    messageBreakdown: {
      toolCallTokens: 900,
      toolResultTokens: 3100,
      attachmentTokens: 0,
      assistantMessageTokens: 1500,
      userMessageTokens: 900,
      redirectedContextTokens: 0,
      unattributedTokens: 0,
      toolCallsByType: [
        { name: 'Read', callTokens: 400, resultTokens: 2300 },
        { name: 'Bash', callTokens: 500, resultTokens: 800 },
      ],
      attachmentsByType: [],
    },
    apiUsage: { input_tokens: 12, output_tokens: 900, cache_creation_input_tokens: 2100, cache_read_input_tokens: 21_000 },
  }
}

function mockControl(mcp: MockMcp[], op: CtlOp, args: unknown[]): unknown {
  const server = (name: unknown) => {
    const s = mcp.find((x) => x.name === name)
    if (!s) throw new Error(`No MCP server named ${String(name)}`)
    return s
  }
  switch (op) {
    case 'mcpServerStatus':
      return mcp.map((s) => ({ ...s, source: s.scope, tools: s.status === 'connected' ? s.tools : undefined }))
    case 'reconnectMcpServer': {
      const s = server(args[0])
      if (s.status === 'disabled') throw new Error(`${s.name} is disabled`)
      s.status = 'connected'
      s.error = undefined
      return undefined
    }
    case 'toggleMcpServer': {
      const s = server(args[0])
      s.status = args[1] ? 'connected' : 'disabled'
      return undefined
    }
    case 'mcpLogin':
      server(args[0]).status = 'connected'
      return undefined
    case 'mcpLogout':
      server(args[0]).status = 'needs-auth'
      return `Cleared credentials for ${String(args[0])}`
    case 'cli':
      return mockCli(String(args[0]))
    case 'supportedAgents':
      return MOCK_AGENTS
    case 'accountInfo':
      return MOCK_ACCOUNT
    case 'getContextUsage':
      return mockContextUsage()
    case 'supportedModels':
      return MOCK_MODEL_INFO
    case 'initializationResult':
      return {
        commands: COMMANDS,
        agents: MOCK_AGENTS,
        output_style: 'default',
        available_output_styles: ['default', 'Explanatory', 'Learning'],
        models: MOCK_MODEL_INFO,
        account: MOCK_ACCOUNT,
        claude_code_version: '2.1.309',
        fast_mode_state: mockFast.on ? 'on' : 'off',
      }
    case 'usage':
      return mockUsage()
    case 'supportedCommands':
      return COMMANDS
    case 'reloadSkills':
      return { skills: COMMANDS.filter((c) => !c.builtin) }
    case 'cliExec':
      return mockPluginCli((Array.isArray(args[0]) ? args[0] : []).map(String))
    case 'reloadPlugins':
    case 'reloadOutputStyles':
      return {}
    case 'rewindFiles':
      return { canRewind: true, filesChanged: ['src/app.ts'], insertions: 3, deletions: 1 }
    case 'applyFlagSettings':
    case 'updateSettings':
    case 'setMaxThinkingTokens':
    case 'stopTask':
    case 'setMcpPermissionModeOverride':
      return undefined
    default:
      throw new Error(`The mock session has no ${op} control`)
  }
}

const MOCK_ACCOUNT = { email: 'dev@example.com', organization: 'Example Org', subscriptionType: 'max', tokenSource: 'claude.ai', apiProvider: 'firstParty' }

/** The SDK's experimental `/usage` data (SDKControlGetUsageResponse) for a Max plan, as the Settings Usage tab reads it. */
function mockUsage() {
  const at = (ms: number) => new Date(Date.now() + ms).toISOString()
  return {
    session: {
      total_cost_usd: 0.0412,
      total_api_duration_ms: 8_400,
      total_duration_ms: 64_000,
      total_lines_added: 3,
      total_lines_removed: 1,
      model_usage: {
        'claude-opus-5-5': {
          inputTokens: 1_200, outputTokens: 640, cacheReadInputTokens: 18_000, cacheCreationInputTokens: 4_100,
          webSearchRequests: 0, costUSD: 0.0412, contextWindow: 200_000, maxOutputTokens: 32_000,
        },
      },
    },
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: FIVE_HOUR_PCT, resets_at: at(FIVE_HOUR_RESET_MS) },
      seven_day: { utilization: WEEKLY_PCT, resets_at: at(WEEKLY_RESET_MS) },
      seven_day_sonnet: { utilization: 3, resets_at: at(WEEKLY_RESET_MS) },
      seven_day_opus: { utilization: WEEKLY_OPUS_PCT, resets_at: at(WEEKLY_RESET_MS) },
      model_scoped: [{ display_name: 'Fable', utilization: 21, resets_at: at(WEEKLY_RESET_MS) }],
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: 'USD' },
    },
    behaviors: null,
  }
}

/** The /config rows the mock CLI offers headless (id → its usage options), with the CLI's labels for "Set … to …". */
const MOCK_CONFIG_ROWS: Record<string, [label: string, options: string]> = {
  theme: ['Theme', 'auto|dark|light|light-daltonized|dark-daltonized|light-ansi|dark-ansi'],
  notifChannel: ['Local notifications', 'auto|iterm2|terminal_bell|iterm2_with_bell|kitty|ghostty|notifications_disabled'],
  autoCompact: ['Auto-compact', 'true|false'],
  autoContinueAtUsageLimit: ['Continue automatically at usage limit', 'true|false'],
  tips: ['Show tips', 'true|false'],
  reduceMotion: ['Reduce motion', 'true|false'],
  thinking: ['Thinking mode', 'true|false'],
  fast: ['Fast mode (Opus 5.5)', 'true|false'],
  promptSuggestionEnabled: ['Prompt suggestions', 'true|false'],
  recap: ['Session recap', 'true|false'],
  checkpoints: ['Rewind code (checkpoints)', 'true|false'],
  verbose: ['Verbose output', 'true|false'],
  progressBar: ['Terminal progress bar', 'true|false'],
  precomputeCompactionEnabled: ['Precompute compaction', 'true|false'],
  timeFormat: ['Time format', 'auto|12-hour|24-hour|24-hour-utc'],
  permissionMode: ['Default permission mode', 'default|plan|acceptEdits|auto|dontAsk'],
  worktreeBaseRef: ['Worktree base ref', 'fresh|head'],
  useAutoModeDuringPlan: ['Use auto mode during plan', 'true|false'],
  gitignore: ['Respect .gitignore in file picker', 'true|false'],
  outputStyle: ['Output style', 'default|Explanatory|Learning'],
  language: ['Language', '<value>'],
  editor: ['Editor mode', 'normal|vim'],
  modelProposedGoals: ['Claude-proposed goals', 'auto|alwaysAsk|disabled'],
  model: ['Model', 'default|opus|sonnet|haiku'],
}

/** What the mock's `/config key=value` has set, so a panel that reads back sees its change. */
export const mockConfig = new Map<string, string>()

/** The CLI's headless `/config` answers: the usage list, or one "Set <label> to <value>" line (or refusal) per pair. */
function mockConfigCli(pairs: string[]) {
  if (!pairs.length) {
    const lines = Object.entries(MOCK_CONFIG_ROWS).map(([id, [, opts]]) => `  ${id}=${opts}`).sort()
    return `Usage: /config key=value [key=value ...]\n${lines.join('\n')}`
  }
  return pairs
    .map((pair) => {
      const i = pair.indexOf('=')
      if (i <= 0) return `Expected key=value, got "${pair}". Run /config to see what's available.`
      const k = pair.slice(0, i)
      const v = pair.slice(i + 1)
      const id = Object.keys(MOCK_CONFIG_ROWS).find((x) => x.toLowerCase() === k.toLowerCase())
      if (!id) return `${k} isn't a /config setting. Run /config to see what's available.`
      const [label, opts] = MOCK_CONFIG_ROWS[id]
      if (opts === 'true|false') {
        const b = ['true', '1', 'on', 'yes'].includes(v.toLowerCase()) ? 'true' : ['false', '0', 'off', 'no'].includes(v.toLowerCase()) ? 'false' : undefined
        if (!b) return `${label} takes true or false, not "${v}".`
        mockConfig.set(id, b)
        return `Set ${label} to ${b}`
      }
      const opt = opts === '<value>' ? v : opts.split('|').find((o) => o.toLowerCase() === v.toLowerCase())
      if (!opt) return `${label} takes one of: ${opts.split('|').join(', ')}.`
      mockConfig.set(id, opt)
      return `Set ${label} to ${opt}`
    })
    .join('\n')
}

/** The CLI's text answers to the slash commands panels run silently (`/config`, `/effort`, `/fast`). */
function mockCli(text: string): string {
  const [name, ...rest] = text.trim().slice(1).split(/\s+/)
  if (name === 'config') return mockConfigCli(rest)
  if (name === 'effort') {
    const level = rest[0]
    if (!level || level === 'current' || level === 'status')
      return mockFast.effort === 'auto' ? 'Effort level: auto (currently high)' : `Current effort level: ${mockFast.effort} (${mockFast.effort})`
    mockFast.effort = level
    if (level === 'auto') return 'Effort level set to auto'
    return `Set effort level to ${level} ${level === 'max' ? '(this session only)' : '(saved as your default for new sessions)'}`
  }
  if (name === 'fast') {
    mockFast.on = rest[0] ? rest[0] !== 'off' : !mockFast.on
    return `Fast mode ${mockFast.on ? 'ON' : 'OFF'}`
  }
  if (name === 'model') {
    const m = MODELS.find((x) => x.value === rest[0] || x.resolved === rest[0])
    if (!m) return `Usage: /model <name>. Available: ${MODELS.map((x) => x.value).filter((v) => v !== 'default').join(', ')}, default, or a full model ID.`
    return `Set model to ${m.displayName === 'Default (recommended)' ? `Default (${m.description.split(' · ')[0]})` : m.description.split(' · ')[0]}`
  }
  // The CLI's headless /add-dir (session only). A path with "missing" in it doesn't exist.
  if (name === 'add-dir') {
    const dir = rest.join(' ')
    if (!dir) return 'Usage: /add-dir <path>'
    return /missing/i.test(dir) ? `Path ${dir} was not found.` : `Added ${dir} as a working directory for this session`
  }
  return `Ran /${name}`
}

// ---------------------------------------------------------------- `claude plugin …` (the /plugin panel, W6)

type MockPlugin = { name: string; marketplace: string; description: string; version: string; installs: number }
type MockInstalled = { id: string; scope: string; enabled: boolean; version: string; errors?: string[] }

/** Two marketplaces with a small catalog, one plugin installed and one that fails to load. Shared by every mock session. */
const mockPlugins = {
  marketplaces: [
    { name: 'claude-plugins-official', source: 'github', repo: 'anthropics/claude-plugins-official' },
    { name: 'acme-tools', source: 'github', repo: 'acme/claude-plugins' },
  ],
  catalog: [
    { name: 'commit-commands', marketplace: 'claude-plugins-official', description: 'Commands for git commit workflows', version: '1.0.0', installs: 48210 },
    { name: 'code-review', marketplace: 'claude-plugins-official', description: 'Automated code review for pull requests', version: '1.2.0', installs: 35120 },
    { name: 'pr-review-toolkit', marketplace: 'claude-plugins-official', description: 'Specialized agents for reviewing pull requests', version: '0.4.1', installs: 9120 },
    { name: 'broken-hooks', marketplace: 'acme-tools', description: 'Example hooks (fails to load)', version: '0.1.0', installs: 12 },
    { name: 'acme-lint', marketplace: 'acme-tools', description: 'Lint fixes on save', version: '2.0.0', installs: 830 },
  ] as MockPlugin[],
  installed: [
    { id: 'commit-commands@claude-plugins-official', scope: 'user', enabled: true, version: '1.0.0' },
    { id: 'broken-hooks@acme-tools', scope: 'project', enabled: true, version: '0.1.0', errors: ['Hook load failed: hooks/hooks.json is not valid JSON'] },
  ] as MockInstalled[],
}

/** `claude plugin <args>` answered like the CLI 2.1.309's `--json` output (one JSON document, or one result line). */
function mockPluginCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const ok = (v: unknown) => ({ code: 0, stdout: `${JSON.stringify(v, null, 2)}\n`, stderr: '' })
  const line = (v: Record<string, unknown>) => ({ code: v.outcome === 'failed' ? 1 : 0, stdout: `${JSON.stringify(v)}\n`, stderr: '' })
  const flag = (f: string) => args.includes(f)
  const opt = (f: string, f2?: string) => {
    const i = args.findIndex((a) => a === f || a === f2)
    return i >= 0 ? args[i + 1] : undefined
  }
  const st = mockPlugins
  const [, verb, arg] = args
  const find = (p: string) => st.installed.find((x) => x.id === p || x.id.split('@')[0] === p)
  if (args[0] !== 'plugin') return { code: 1, stdout: '', stderr: `claude ${args.join(' ')}: not in the mock` }
  if (verb === 'list') {
    const installed = st.installed.map((x) => ({
      id: x.id, version: x.version, scope: x.scope, enabled: x.enabled,
      installPath: `~/.claude/plugins/cache/${x.id.replace('@', '/')}/${x.version}`,
      installedAt: '2026-10-01T09:00:00.000Z', lastUpdated: '2026-10-01T09:00:00.000Z', errors: x.errors,
    }))
    if (!flag('--available')) return ok(installed)
    const available = st.catalog
      .filter((p) => !find(`${p.name}@${p.marketplace}`))
      .map((p) => ({ pluginId: `${p.name}@${p.marketplace}`, name: p.name, description: p.description, marketplaceName: p.marketplace, version: p.version, installCount: p.installs }))
    return ok({ installed, available })
  }
  if (verb === 'marketplace') {
    const name = args[3]
    switch (arg) {
      case 'list':
        return ok(st.marketplaces.map((m) => ({ ...m, installLocation: `~/.claude/plugins/marketplaces/${m.name}` })))
      case 'add': {
        const src = name ?? ''
        if (!/^[\w.-]+\/[\w.-]+$|^https?:|^\.{0,2}[\\/]/.test(src)) return line({ command: 'marketplace-add', outcome: 'failed', message: 'Invalid marketplace source format. Try: owner/repo, https://..., or ./path' })
        const mname = src.split(/[\\/]/).filter(Boolean).at(-1)!.replace(/\.git$|\.json$/, '')
        if (!st.marketplaces.some((m) => m.name === mname)) st.marketplaces.push({ name: mname, source: 'github', repo: src })
        return line({ command: 'marketplace-add', outcome: 'ok', marketplace: mname, message: `Successfully added marketplace: ${mname}` })
      }
      case 'remove': {
        if (!st.marketplaces.some((m) => m.name === name)) return line({ command: 'marketplace-remove', outcome: 'failed', marketplace: name, message: `Marketplace '${name}' not found` })
        st.marketplaces = st.marketplaces.filter((m) => m.name !== name)
        st.installed = st.installed.filter((x) => !x.id.endsWith(`@${name}`))
        return line({ command: 'marketplace-remove', outcome: 'ok', marketplace: name, message: `Successfully removed marketplace: ${name}` })
      }
      case 'update':
        return line({ command: 'marketplace-update', outcome: 'ok', marketplace: name, message: `Successfully updated marketplace: ${name}` })
    }
  }
  const scope = opt('-s', '--scope')
  if (verb === 'install') {
    const [pname, mkt] = (arg ?? '').split('@')
    const p = st.catalog.find((x) => x.name === pname && (!mkt || x.marketplace === mkt))
    if (!p) return line({ command: 'install', outcome: 'failed', plugin: arg, scope: scope ?? 'user', message: `Plugin "${arg}" not found in any marketplace`, failureCode: 'plugin_not_found' })
    const id = `${p.name}@${p.marketplace}`
    if (!find(id)) st.installed.push({ id, scope: scope ?? 'user', enabled: true, version: p.version })
    return line({ command: 'install', outcome: 'ok', plugin: arg, pluginId: id, scope: scope ?? 'user', message: `Successfully installed plugin: ${id} (scope: ${scope ?? 'user'})`, installedVersion: p.version })
  }
  if (verb === 'uninstall' || verb === 'enable' || verb === 'disable' || verb === 'update') {
    const x = find(arg ?? '')
    if (!x) return line({ command: verb, outcome: 'failed', plugin: arg, message: `Plugin "${arg}" is not installed` })
    if (verb === 'uninstall') st.installed = st.installed.filter((y) => y !== x)
    if (verb === 'enable' || verb === 'disable') {
      if (x.enabled === (verb === 'enable')) return line({ command: verb, outcome: 'failed', plugin: arg, pluginId: x.id, message: `Plugin "${x.id}" is already ${verb}d` })
      x.enabled = verb === 'enable'
    }
    const past = verb === 'update' ? 'updated' : `${verb}${verb.endsWith('e') ? 'd' : 'ed'}`
    return line({ command: verb, outcome: 'ok', plugin: arg, pluginId: x.id, scope: x.scope, message: `Successfully ${past} plugin: ${x.id} (scope: ${x.scope})` })
  }
  return { code: 1, stdout: '', stderr: `error: unknown command '${verb}'` }
}

/** The deploy form the mock's elicitation scenario asks for: a choice, a required text and a boolean. */
export const MOCK_ELICIT_SCHEMA = {
  type: 'object',
  properties: {
    environment: { type: 'string', title: 'Environment', enum: ['staging', 'production'], enumNames: ['Staging', 'Production'] },
    reason: { type: 'string', title: 'Reason', description: 'Shown in the deploy log', minLength: 3 },
    notify: { type: 'boolean', title: 'Notify the channel', default: true },
  },
  required: ['environment', 'reason'],
}
