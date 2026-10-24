import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  getSessionMessages,
  query,
  type AccountInfo,
  type CanUseTool,
  type ModelInfo,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type ElicitationRequest,
  type ElicitationResult,
  type Query,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { mcpLogin, mcpLogout } from './auth.ts'
import { fileControl } from './config-files.ts'
import { elicitContent, elicitFields } from './elicit.ts'
import { buildPersona } from './persona.ts'
import {
  EMOTIONS,
  type CtlOp,
  type ElicitField,
  type Emotion,
  type Image,
  type Limit,
  type PermissionModeName,
  type Question,
  type SessionEvent,
  type Stats,
  type Todo,
} from './protocol.ts'
import type { SessionApi, SessionFactory, SessionOptions } from './session-api.ts'
import { bashModeMessages, childEnv, runShell } from './shell.ts'
import { ANSI, buildDiffs, clip, describeTool, isDestructive, prettyInput, str, toolLabel, toolOutput } from './tools.ts'

/** CLI stderr lines kept for error messages. */
const STDERR_LINES = 40
/** How many of them an error message quotes. */
const STDERR_TAIL = 12
/** How long a panel waits for a slash command it ran (cliCommand) to answer. */
const CLI_COMMAND_TIMEOUT_MS = 20_000
/** Token-count updates for the spinner are sent at most this often; phase changes go out at once. */
const PROGRESS_MS = 250
/** The context gauge is re-read this long after the last main-agent tool result. */
const CONTEXT_REFRESH_MS = 1500
/** Rough size of a token, for the spinner's count while a message is still streaming. */
const CHARS_PER_TOKEN = 4
const TOKENS_PER_K = 1000
const MS_PER_S = 1000
/** Identifies the app to the CLI in its telemetry and logs. */
const CLIENT_APP = 'waifufy-code'
/** The model name the CLI gives messages it makes itself (command output, error notices). */
const SYNTHETIC_MODEL = '<synthetic>'
/** Placeholder texts of synthetic messages, which say nothing to show. */
const PLACEHOLDERS = new Set(['(no content)', 'No response requested.'])

// The CLI's own wording for "No" and "No, and tell Claude what to do differently".
const DENY_MESSAGE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected. STOP what you are doing and wait for the user to tell you how to proceed."
const FEEDBACK_MESSAGE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n"
const KEEP_PLANNING = 'The user wants to keep planning. Keep refining the plan and present it again with ExitPlanMode when it is ready.'
const KEEP_PLANNING_FEEDBACK = 'The user wants to keep planning. Revise the plan with this feedback, then present it again with ExitPlanMode:\n'

const AUTH_ERRORS = new Set<SDKAssistantMessageError>(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required'])

const ERROR_TEXT: Partial<Record<SDKAssistantMessageError, string>> = {
  authentication_failed: 'Claude Code is not logged in. Use Log in on the title screen (or run `claude` in a terminal and type /login), then try again.',
  oauth_org_not_allowed: "This account's organization does not allow Claude Code. Log in with another account.",
  account_on_hold: 'This Claude account is on hold. Check it on claude.ai, then log in again.',
  verification_required: 'Claude needs the account to be verified. Log in again to continue.',
  billing_error: 'Claude reported a billing problem with this account.',
  rate_limit: 'The usage limit is reached. Check the limit gauges for when it resets.',
  overloaded: 'Claude is overloaded right now. Try again in a moment.',
  model_not_found: 'The selected model is not available for this account. Pick another one with /model.',
  cloud_credential_error: 'The cloud provider rejected its credentials.',
}

/** terminal_reason values for a turn the user stopped: not an error. */
const INTERRUPTED = new Set(['aborted_streaming', 'aborted_tools'])
/** terminal_reason values that end a turn early without anything having gone wrong. */
const SOFT_STOPS: Record<string, string> = {
  max_turns: 'Stopped after reaching the maximum number of turns.',
  stop_hook_prevented: 'A Stop hook ended the turn.',
  hook_stopped: 'A hook stopped the turn.',
}

const LOCAL_OUTPUT = /<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/g
const TODO_STATUS = new Set<Todo['status']>(['pending', 'in_progress', 'completed'])
const MODES = new Set<string>(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] satisfies PermissionModeName[])
/** User text the CLI writes itself (bash-mode records, local command input and output), which is not a prompt. */
const NOT_A_PROMPT = /^\s*<(bash-|local-command-|command-name>)/

type Phase = Extract<SessionEvent, { t: 'progress' }>['phase']
type AskOptions = Parameters<CanUseTool>[2]
type AskKind = 'permission' | 'question' | 'plan'
type Pending = { kind: AskKind; input: Record<string, unknown>; suggestions?: PermissionUpdate[]; canAlways: boolean; resolve(r: PermissionResult): void }
type AgentStatus = Extract<SessionEvent, { t: 'agent' }>['status']
type ContextUsage = Awaited<ReturnType<Query['getContextUsage']>>
type ToolResult = { type: 'tool_result'; tool_use_id: string; content?: unknown; is_error?: boolean }
type UsageWindow = { utilization: number | null; resets_at: string | null } | null | undefined

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const freshStats = (): Stats => ({ costUsd: 0, turns: 0, apiMs: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, limits: {} })
const kTokens = (n: number) => (n >= TOKENS_PER_K ? `${(n / TOKENS_PER_K).toFixed(1)}k` : String(n))

/** Text blocks of a message's content, which is a string or an array of blocks. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b: { type?: string }) => b?.type === 'text')
    .map((b: { text?: string }) => b.text ?? '')
    .join('\n')
}

/** Local command output as the CLI prints it, without its wrapper tags and terminal colors. */
const commandText = (s: string) => s.replace(ANSI, '').replace(/<\/?local-command-(stdout|stderr|caveat)>/g, '').trim()

function accountLabel(a: AccountInfo | undefined) {
  if (!a) return undefined
  return a.email ?? (a.apiProvider && a.apiProvider !== 'firstParty' ? a.apiProvider : undefined)
}

type SettingsJson = { permissions?: { defaultMode?: unknown }; respondToBashCommands?: unknown }

/** A value from the enabled Claude Code settings files (user, project, local), later ones winning as the CLI merges them. */
function fromSettings<T>(cwd: string, sources: readonly string[], pick: (json: SettingsJson) => T | undefined): T | undefined {
  const files: [string, string][] = [
    ['user', join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')],
    ['project', join(cwd, '.claude', 'settings.json')],
    ['local', join(cwd, '.claude', 'settings.local.json')],
  ]
  let value: T | undefined
  for (const [source, file] of files) {
    if (!sources.includes(source)) continue
    try {
      const v = pick(JSON.parse(readFileSync(file, 'utf8')) as SettingsJson)
      if (v !== undefined) value = v
    } catch {
      // Missing or unreadable: this source sets nothing.
    }
  }
  return value
}

/**
 * The mode the CLI starts in when the app leaves it to the settings files: `permissions.defaultMode`.
 * system/init only confirms it with the first turn.
 */
function settingsMode(cwd: string, sources: readonly string[]): PermissionModeName {
  // The CLI ignores escalating modes from the repo-committed project file; so does the badge.
  const own = fromSettings(cwd, sources.filter((s) => s !== 'project'), (j) => j.permissions?.defaultMode)
  const project = sources.includes('project') ? fromSettings(cwd, ['project'], (j) => j.permissions?.defaultMode) : undefined
  const mode = own ?? (ESCALATING.has(String(project)) ? undefined : project)
  return typeof mode === 'string' && MODES.has(mode) ? (mode as PermissionModeName) : 'default'
}

const ESCALATING = new Set(['acceptEdits', 'auto', 'bypassPermissions'])

const DESTINATIONS: Record<string, string> = {
  localSettings: 'this project (.claude/settings.local.json)',
  projectSettings: 'this project (.claude/settings.json)',
  userSettings: 'all your projects',
  session: 'this session',
  cliArg: 'this session',
}

/** What "don't ask again" saves, like the CLI's label: "Bash(npm run test:*) in this project". */
function describeAlways(updates: PermissionUpdate[]): string {
  const parts: string[] = []
  for (const u of updates) {
    const where = DESTINATIONS[u.destination] ?? u.destination
    if (u.type === 'addRules' || u.type === 'replaceRules') {
      const rules = u.rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)).join(', ')
      parts.push(`allow ${rules} in ${where}`)
    } else if (u.type === 'addDirectories') parts.push(`access to ${u.directories.join(', ')} in ${where}`)
    else if (u.type === 'setMode') parts.push(`switch to ${u.mode} for ${where}`)
  }
  return parts.join('; ')
}

/** Whether Claude answers a `!cmd`'s output, as the CLI's `respondToBashCommands` setting says (default: yes). */
function respondsToBash(cwd: string, sources: readonly string[]) {
  const v = fromSettings(cwd, sources, (j) => (typeof j.respondToBashCommands === 'boolean' ? j.respondToBashCommands : undefined))
  return v ?? true
}

/** The messages the user typed, fed to query() as they are sent. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = []
  private wake?: () => void
  private closed = false

  push(m: SDKUserMessage) {
    if (this.closed) return
    this.queue.push(m)
    this.wake?.()
  }

  close() {
    this.closed = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator]() {
    while (!this.closed) {
      const next = this.queue.shift()
      if (next) yield next
      else await new Promise<void>((r) => (this.wake = r))
    }
  }
}

/** Tags models improvise despite the list, mapped to the nearest real emotion so they never show as text. */
const TAG_ALIASES: Record<string, Emotion> = {
  blush: 'shy', blushing: 'shy', embarrassed: 'shy', giggle: 'happy', laugh: 'happy', grin: 'happy', joy: 'happy',
  wink: 'smile', smirk: 'smile', excited: 'delighted', cheer: 'delighted', thinking: 'think', confused: 'think',
  cry: 'teary', crying: 'teary', tears: 'teary', frown: 'sad', gasp: 'surprised', shock: 'surprised', huff: 'pout',
  annoyed: 'pout', mad: 'angry', relieved: 'smile', determined: 'serious', concerned: 'worried', nervous: 'worried',
}
const emotionOf = (word: string): Emotion | undefined =>
  (EMOTIONS as readonly string[]).includes(word) ? (word as Emotion) : TAG_ALIASES[word]
const LONGEST_TAG = Math.max(...[...EMOTIONS, ...Object.keys(TAG_ALIASES)].map((e) => e.length)) + 2
/** After a stripped tag, no space is put back before these. */
const NO_SPACE_BEFORE = /^[.,!?;:)\]}…'"’”\n]/

/**
 * Splits streamed text into text and emotion tags, in order. A `[` holds the stream back until its `]`
 * (or until it can no longer be a tag), so a tag split across deltas is still caught. Tags inside
 * inline code or code fences are left alone, and the spaces around a removed tag collapse to one.
 */
export class TagParser {
  private buf = ''
  /** Trailing spaces not yet sent: dropped if a tag follows them. */
  private held = ''
  /** Last character sent; a newline at the start of a block. */
  private last = '\n'
  private afterTag = false
  /** Whitespace touched the tag (or tags) just removed. */
  private spaced = false
  /** Length of the backtick run that opened the current code span or fence; 0 outside code. */
  private ticks = 0
  private onText: (s: string) => void
  private onFace: (e: Emotion) => void

  constructor(onText: (s: string) => void, onFace: (e: Emotion) => void) {
    this.onText = onText
    this.onFace = onFace
  }

  feed(s: string) {
    this.buf += s
    this.drain(false)
  }

  /** End of a text block: sends whatever is held back and resets for the next block. */
  flush() {
    this.drain(true)
    this.buf = this.held = ''
    this.last = '\n'
    this.afterTag = this.spaced = false
    this.ticks = 0
  }

  private drain(final: boolean) {
    const b = this.buf
    let text = ''
    let i = 0
    while (i < b.length) {
      const c = b[i]
      if (c === '`') {
        let j = i
        while (j < b.length && b[j] === '`') j++
        // The run may go on in the next delta, and its length decides what it opens or closes.
        if (j === b.length && !final) break
        const run = j - i
        if (this.ticks === 0) this.ticks = run
        else if (run === this.ticks) this.ticks = 0
        text += b.slice(i, j)
        i = j
        continue
      }
      if (c === '\n' && this.ticks > 0 && this.ticks < 3) this.ticks = 0
      if (c === '[' && this.ticks === 0) {
        const close = b.indexOf(']', i)
        if (close === -1 && !final && b.length - i < LONGEST_TAG) break
        const word = close === -1 ? '' : b.slice(i + 1, close).trim().toLowerCase()
        if (close !== -1 && close - i <= LONGEST_TAG && emotionOf(word)) {
          this.text(text)
          text = ''
          this.tag(emotionOf(word)!)
          i = close + 1
          continue
        }
      }
      text += c
      i++
    }
    this.text(text)
    this.buf = b.slice(i)
  }

  private text(s: string) {
    if (!s) return
    if (this.afterTag) {
      const t = s.replace(/^[ \t]+/, '')
      if (t !== s) this.spaced = true
      if (!t) return
      this.afterTag = false
      if (this.spaced && !/\s/.test(this.last) && !NO_SPACE_BEFORE.test(t)) this.send(' ')
      s = t
    } else {
      s = this.held + s
      this.held = ''
    }
    const trailing = /[ \t]+$/.exec(s)
    if (trailing) {
      this.held = trailing[0]
      s = s.slice(0, trailing.index)
    }
    this.send(s)
  }

  private tag(e: Emotion) {
    if (!this.afterTag) {
      this.spaced = this.held.length > 0
      this.afterTag = true
    }
    this.held = ''
    this.onFace(e)
  }

  private send(s: string) {
    if (!s) return
    this.last = s[s.length - 1]
    this.onText(s)
  }
}

class Session implements SessionApi {
  readonly epoch: number
  readonly cwd: string
  private opts: SessionOptions
  private q?: Query
  private inbox = new Inbox()
  private sid?: string
  private stats: Stats = freshStats()
  private models: ModelInfo[] = []
  private pending = new Map<string, Pending>()
  /** Open MCP elicitations, by the id the app answers with. */
  private elicits = new Map<string, { fields: ElicitField[]; elicitationId?: string; finish(r: ElicitationResult): void }>()
  private tags: TagParser
  private textOpen = false
  /** Content block types of the main agent's message being streamed, by index. */
  private blocks = new Map<number, string>()
  /** Ids of main-agent messages that arrived as stream events; a complete message not in here was never streamed. */
  private streamed = new Set<string>()
  /** Tool calls waiting for their result, for todo and subagent tracking. */
  private uses = new Map<string, { name: string; input: Record<string, unknown> }>()
  private todos = new Map<string, Todo>()
  private agents = new Map<string, { description: string; status: AgentStatus }>()
  /**
   * Uuids of `!cmd` context appends. The CLI still runs a (model-free) turn for each, with its own
   * result and running/idle states; those are hidden, since nothing was asked.
   */
  private silent = new Set<string>()
  /** A slash command a panel ran (cliCommand): its output is collected for the panel instead of shown. */
  private capture?: { uuid: string; out: string[]; done(text: string): void }
  /** cliCommand calls run one at a time, so each output lands with the call that asked for it. */
  private cliChain: Promise<unknown> = Promise.resolve()
  /** The CLI reported 'running' for silent appends only, so its 'idle' is hidden too. */
  private quiet = false
  /** The user sent while an append ran: the append's own 'idle', if the CLI sends one before the user's turn, is hidden. */
  private swallowIdle = false
  /** `!cmd` runs in progress, stopped by Esc and by the session ending. */
  private shells = new Set<AbortController>()
  private stderr: string[] = []
  private closed = false
  private ended = false
  /** A turn is in flight (sent, no result yet). */
  private running = false
  private turnStart = 0
  /** Something was shown for the current turn, so a local command's result text would be a repeat. */
  private shown = false
  /** The turn's API or auth error was already sent, so its result doesn't repeat it. */
  private errorShown = false
  private haveResult = false
  /** Output tokens of the turn: finished messages, the current message's reported count, and an estimate while it streams. */
  private tokens = { done: 0, reported: 0, estimate: 0 }
  private phase: Phase = 'thinking'
  private note?: string
  private lastProgress = 0
  private refreshing?: Promise<void>
  private refreshAgain = false
  private contextTimer?: ReturnType<typeof setTimeout>

  constructor(opts: SessionOptions) {
    this.opts = opts
    this.epoch = opts.epoch
    this.cwd = opts.cwd
    // A new session gets its id now, so the app can register the save before the first turn.
    this.sid = opts.resume ?? randomUUID()
    this.tags = new TagParser(
      (delta) => this.emit({ t: 'text', delta }),
      (emotion) => this.emit({ t: 'face', emotion }),
    )
  }

  sessionId() {
    return this.sid
  }

  async start() {
    // The SDK reports a missing folder as a binary that failed to launch.
    if (!existsSync(this.cwd)) return this.die(`The folder ${this.cwd} does not exist.`)
    let q: Query
    try {
      q = this.q = query({ prompt: this.inbox, options: this.options() })
    } catch (e) {
      return this.die(`Claude Code could not start: ${message(e)}`)
    }
    void this.pump(q)
    const c = this.opts.settings.claude
    const mode = c.permissionMode === 'default' ? settingsMode(this.cwd, c.settingSources) : c.permissionMode
    try {
      // These answer as soon as the CLI's handshake completes; system/init only comes with the first turn.
      const [init, ctx] = await Promise.all([
        q.initializationResult(),
        q.getContextUsage({ detail: 'summary' }).catch(() => undefined),
        this.seedTurns(),
      ])
      if (this.ended) return
      this.models = init.models
      this.stats.mode = mode
      this.stats.model = ctx?.model || this.resolveModel(this.opts.settings.claude.model)
      if (ctx) this.applyContext(ctx)
      this.emit({
        t: 'ready',
        sessionId: this.sid,
        commands: init.commands.map((x) => ({ name: x.name, description: x.description, argumentHint: x.argumentHint, builtin: x.builtin === true, ...(x.aliases?.length ? { aliases: x.aliases } : {}) })),
        models: init.models.map((x) => ({ value: x.value, displayName: x.displayName, description: x.description, resolved: x.resolvedModel, supportsAuto: x.supportsAutoMode === true })),
        mode,
        model: this.stats.model,
        account: accountLabel(init.account),
        bypassAvailable: this.opts.settings.claude.permissionMode === 'bypassPermissions',
      })
      this.emitStats()
      await this.refreshStats()
    } catch (e) {
      if (!this.closed) this.die(`Claude Code did not finish starting: ${message(e)}`)
    }
  }

  private options(): Options {
    const s = this.opts.settings
    const c = s.claude
    return {
      cwd: this.cwd,
      ...(this.opts.resume ? { resume: this.opts.resume } : { sessionId: this.sid }),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: buildPersona(s) },
      // The same CLAUDE.md, skills, MCP servers, hooks and permission rules as the terminal.
      settingSources: c.settingSources,
      ...(c.model ? { model: c.model } : {}),
      // 'default' is left out, so a defaultMode from the user's settings.json still applies, as in the CLI.
      ...(c.permissionMode !== 'default' ? { permissionMode: c.permissionMode } : {}),
      ...(c.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      includePartialMessages: true,
      // As in the terminal: file snapshots per message, so /rewind (in the terminal, for now) can restore code.
      enableFileCheckpointing: true,
      ...(this.opts.claudePath ? { pathToClaudeCodeExecutable: this.opts.claudePath } : {}),
      // Without the first variable the SDK swallows session_state_changed. childEnv() leaves out the
      // link's credentials, which every command the model runs would otherwise see.
      env: { ...childEnv(), CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1', CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP },
      stderr: (d) => this.onStderr(d),
      canUseTool: (name, input, o) => this.ask(name, input, o),
      onElicitation: (request, o) => this.elicit(request, o.signal),
    }
  }

  say(text: string, images: Image[] = []) {
    if (this.ended) {
      return this.emit({ t: 'error', kind: 'process', message: 'This session has ended. Resume it or start a new one to keep going.' })
    }
    if (!text && !images.length) return
    this.send(
      images.length
        ? [
            // Images first, then the text, as the CLI sends a pasted screenshot.
            ...images.map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mediaType, data: img.data } })),
            ...(text ? [{ type: 'text' as const, text }] : []),
          ]
        : text,
    )
  }

  /** Sends a user message as a turn, or as the next one when a turn is running. */
  private send(content: SDKUserMessage['message']['content']) {
    const busy = this.running
    if (!busy) this.beginTurn()
    if (this.quiet) {
      // The CLI is already 'running' (for an append) and won't say so again for this turn.
      this.quiet = false
      this.swallowIdle = true
      this.emit({ t: 'state', state: 'running' })
    }
    this.inbox.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      origin: { kind: 'human' },
      uuid: randomUUID(),
      ...(busy ? { priority: 'next' as const } : {}),
    })
  }

  async shell(command: string) {
    const abort = new AbortController()
    this.shells.add(abort)
    const run = await runShell(command, this.cwd, abort.signal)
    this.shells.delete(abort)
    // Stopped by the session ending: there is no transcript left to record it in.
    if (this.ended) return
    this.emit({ t: 'shell_result', command, output: run.output, code: run.code })
    const [caveat, input, output] = bashModeMessages(command, run)
    // As in the CLI: by default she answers the output, in a turn without the caveat. A command the user
    // stopped, or `respondToBashCommands: false`, is only recorded in context: caveat first, no turn.
    if (!abort.signal.aborted && respondsToBash(this.cwd, this.opts.settings.claude.settingSources)) {
      return this.send([
        { type: 'text', text: input },
        { type: 'text', text: output },
      ])
    }
    for (const text of [caveat, input, output]) {
      const uuid = randomUUID()
      this.silent.add(uuid)
      this.inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, shouldQuery: false, uuid })
    }
    this.scheduleContextRefresh()
  }

  async interrupt() {
    this.stopShells()
    for (const [id, p] of this.pending) {
      this.emit({ t: 'ask_cancel', id })
      p.resolve({ behavior: 'deny', message: DENY_MESSAGE, interrupt: true })
    }
    this.pending.clear()
    for (const [id, e] of this.elicits) {
      this.emit({ t: 'ask_cancel', id })
      e.finish({ action: 'cancel' })
    }
    await this.q?.interrupt().catch(() => undefined)
  }

  close() {
    if (this.closed) return
    if (!this.ended) this.emit({ t: 'ended', reason: 'closed' })
    this.ended = this.closed = true
    clearTimeout(this.contextTimer)
    this.stopShells()
    for (const p of this.pending.values()) p.resolve({ behavior: 'deny', message: 'The session was closed.', interrupt: true })
    this.pending.clear()
    this.inbox.close()
    this.q?.close()
  }

  async setMode(mode: PermissionModeName) {
    try {
      await this.q?.setPermissionMode(mode)
      this.stats.mode = mode
      this.emitStats()
    } catch (e) {
      this.emit({ t: 'error', kind: 'internal', message: `Could not switch to ${mode} mode: ${message(e)}` })
    }
  }

  async setModel(model: string) {
    try {
      await this.q?.setModel(model || undefined)
      const ctx = await this.q?.getContextUsage({ detail: 'summary' }).catch(() => undefined)
      this.stats.model = this.models.find((m) => m.value === model)?.resolvedModel ?? ctx?.model ?? model
      this.emitStats()
    } catch (e) {
      this.emit({ t: 'error', kind: 'internal', message: `Could not switch the model to ${model}: ${message(e)}` })
    }
  }

  /**
   * Runs a CLI slash command for a panel (`/config theme=dark`, `/effort high`) and resolves with its text output.
   * It is sent like a silent append, so no turn, spinner or notice shows. Refused while a turn runs: its output
   * would come back mixed with hers.
   */
  cliCommand(text: string): Promise<string> {
    const run = this.cliChain.then(() => {
      if (this.running) throw new Error('Wait until she finishes this turn')
      if (!this.q || this.ended) throw new Error('The session is not ready yet')
      const uuid = randomUUID()
      this.silent.add(uuid)
      return new Promise<string>((done, fail) => {
        const timer = setTimeout(() => {
          if (this.capture?.uuid === uuid) this.capture = undefined
          fail(new Error(`${text.split(' ')[0]} did not answer`))
        }, CLI_COMMAND_TIMEOUT_MS)
        this.capture = { uuid, out: [], done: (t) => (clearTimeout(timer), done(t)) }
        this.inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid })
      })
    })
    this.cliChain = run.catch(() => undefined)
    return run
  }

  /** One of the SDK's session controls (CTL_OPS), for the app's versions of the CLI's interactive panels. */
  async control(op: CtlOp, args: unknown[]) {
    if (op === 'cli') return this.cliCommand(String(args[0]))
    const files = fileControl(op, args, this.cwd, this.opts.claudePath)
    if (files) return files
    if (op === 'mcpLogin') return mcpLogin(String(args[0]), this.cwd, this.opts.claudePath)
    if (op === 'mcpLogout') return mcpLogout(String(args[0]), this.cwd, this.opts.claudePath)
    const q = this.q
    if (!q) throw new Error('The session is not ready yet')
    const name = op === 'usage' ? 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET' : op
    const fn = (q as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name]
    if (typeof fn !== 'function') throw new Error(`This Claude Code version has no ${op} control`)
    const data = await fn.apply(q, args)
    // A change the stats line shows (MCP servers, the effort level) is picked up on the next stats refresh.
    if (op === 'reconnectMcpServer' || op === 'toggleMcpServer' || op === 'applyFlagSettings') this.scheduleContextRefresh()
    return data
  }

  answerPermission(id: string, decision: 'allow' | 'always' | 'deny' | 'feedback', note?: string) {
    const p = this.take(id)
    if (!p) return
    if (decision === 'deny') return p.resolve({ behavior: 'deny', message: DENY_MESSAGE, interrupt: true })
    if (decision === 'feedback') return p.resolve({ behavior: 'deny', message: FEEDBACK_MESSAGE + (note?.trim() || '(no details)') })
    const always = decision === 'always' && p.canAlways && p.suggestions
    p.resolve({ behavior: 'allow', updatedInput: p.input, ...(always ? { updatedPermissions: p.suggestions } : {}) })
  }

  answerQuestion(id: string, answers: Record<string, string>) {
    const p = this.take(id)
    p?.resolve({ behavior: 'allow', updatedInput: { ...p.input, answers } })
  }

  answerPlan(id: string, decision: 'auto' | 'manual' | 'keep', note?: string) {
    const p = this.take(id)
    if (!p) return
    if (decision === 'keep') return p.resolve({ behavior: 'deny', message: note?.trim() ? KEEP_PLANNING_FEEDBACK + note.trim() : KEEP_PLANNING })
    // Like the CLI's "Yes, and auto-accept edits" / "Yes, manually approve edits": the choice sets the mode,
    // rather than falling back to whatever mode was on before plan mode.
    const mode = decision === 'auto' ? 'acceptEdits' : 'default'
    p.resolve({ behavior: 'allow', updatedInput: p.input, updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] })
    // The CLI reports the new mode with its next status message; show it right away.
    this.stats.mode = mode
    this.emitStats()
  }

  // ---------------------------------------------------------------- internals

  private stopShells() {
    for (const abort of this.shells) abort.abort()
    this.shells.clear()
  }

  private emit(e: SessionEvent) {
    if (!this.closed) this.opts.emit(e)
  }

  private emitStats() {
    this.emit({ t: 'stats', stats: { ...this.stats, limits: { ...this.stats.limits } } })
  }

  private notice(text: string, kind: Extract<SessionEvent, { t: 'notice' }>['kind']) {
    if (!text) return
    if (kind === 'command' || kind === 'compact') this.shown = true
    this.emit({ t: 'notice', text, kind })
  }

  private onStderr(data: string) {
    // Also into the sidecar's own log, which packaging writes to a file.
    process.stderr.write(`[cli] ${data}${data.endsWith('\n') ? '' : '\n'}`)
    for (const line of data.split(/\r?\n/)) if (line.trim()) this.stderr.push(line)
    if (this.stderr.length > STDERR_LINES) this.stderr.splice(0, this.stderr.length - STDERR_LINES)
  }

  /**
   * The CLI failed: one error with its last words, open asks withdrawn, then `ended`. The server drops the
   * session on 'ended' without closing it, so a CLI that is still alive (a failed handshake) is closed here.
   */
  private die(text: string) {
    if (this.ended) return
    this.ended = true
    this.running = false
    clearTimeout(this.contextTimer)
    this.stopShells()
    const tail = this.stderr.slice(-STDERR_TAIL).join('\n')
    this.emit({ t: 'error', kind: 'process', message: tail ? `${text}\n\n${tail}` : text })
    for (const [id, p] of this.pending) {
      this.emit({ t: 'ask_cancel', id })
      p.resolve({ behavior: 'deny', message: 'Claude Code stopped.', interrupt: true })
    }
    this.pending.clear()
    this.emit({ t: 'ended', reason: 'crashed' })
    // Also keeps pump() from reporting the abort error that closing causes.
    this.closed = true
    this.inbox.close()
    this.q?.close()
  }

  private async pump(q: Query) {
    try {
      for await (const m of q) {
        try {
          this.onMessage(m)
        } catch (e) {
          this.emit({ t: 'error', kind: 'internal', message: `Could not handle a ${m.type} message: ${message(e)}` })
        }
      }
      if (!this.closed) this.die('Claude Code exited unexpectedly.')
    } catch (e) {
      // After close() the iterator ends with an abort error; that one is expected.
      if (!this.closed) this.die(`Claude Code stopped: ${message(e)}`)
    }
  }

  /**
   * On resume, Turns continue from the transcript: one per prompt typed since the last compaction. Like the CLI,
   * a message with no origin counts as typed (terminal prompts carry none); tool results and the CLI's own
   * records (bash mode, local commands) don't.
   */
  private async seedTurns() {
    if (!this.opts.resume) return
    try {
      const msgs = await getSessionMessages(this.opts.resume, { dir: this.cwd })
      this.stats.turns = msgs.filter((m) => {
        const extra = m as { origin?: { kind?: string }; is_meta?: boolean }
        if (m.type !== 'user' || m.parent_tool_use_id || extra.is_meta) return false
        if (extra.origin !== undefined && extra.origin.kind !== 'human') return false
        const content = (m.message as { content?: unknown } | undefined)?.content
        if (Array.isArray(content) && content.some((b: { type?: string }) => b?.type === 'tool_result')) return false
        const text = textOf(content)
        // A `!cmd` she answered carries its output in the same message (one turn); a recorded-only one doesn't.
        return !NOT_A_PROMPT.test(text) || (text.startsWith('<bash-input>') && text.includes('<bash-stdout>'))
      }).length
    } catch {
      // No transcript to count: Turns start at 0.
    }
  }

  private resolveModel(value: string) {
    if (!value) return undefined
    return this.models.find((m) => m.value === value)?.resolvedModel ?? value
  }

  private beginTurn() {
    this.running = true
    this.turnStart = Date.now()
    this.shown = this.errorShown = false
    this.tokens = { done: 0, reported: 0, estimate: 0 }
    this.lastProgress = 0
    this.progress('thinking')
  }

  private progress(phase: Phase, note?: string) {
    const changed = phase !== this.phase || note !== this.note
    if (changed) {
      this.phase = phase
      this.note = note
    }
    const now = Date.now()
    if (!changed && now - this.lastProgress < PROGRESS_MS) return
    this.lastProgress = now
    const t = this.tokens
    const outputTokens = Math.round(t.done + Math.max(t.reported, t.estimate))
    this.emit({ t: 'progress', outputTokens, phase, ...(this.note ? { note: this.note } : {}) })
  }

  private endText() {
    if (!this.textOpen) return
    this.textOpen = false
    this.tags.flush()
    this.emit({ t: 'text_end' })
  }

  private onMessage(m: SDKMessage) {
    switch (m.type) {
      case 'stream_event':
        return this.onStream(m)
      case 'assistant':
        return this.onAssistant(m)
      case 'user':
        return this.onUser(m)
      case 'result':
        return this.onResult(m)
      case 'system':
        return this.onSystem(m)
      case 'rate_limit_event':
        return this.onRateLimit(m.rate_limit_info)
      case 'tool_progress':
        if (!m.parent_tool_use_id) this.progress('tool', `${toolLabel(m.tool_name)} · ${Math.round(m.elapsed_time_seconds)}s`)
        return
      case 'conversation_reset':
        return this.adoptSession(m.new_conversation_id)
    }
  }

  private onStream(m: Extract<SDKMessage, { type: 'stream_event' }>) {
    // Only the main agent speaks in the dialogue box; subagents show up as actions.
    if (m.parent_tool_use_id) return
    const ev = m.event
    switch (ev.type) {
      case 'message_start':
        this.streamed.add(ev.message.id)
        this.blocks.clear()
        this.tokens.done += Math.max(this.tokens.reported, this.tokens.estimate)
        this.tokens.reported = this.tokens.estimate = 0
        return this.progress('thinking')
      case 'content_block_start': {
        const block = ev.content_block
        this.blocks.set(ev.index, block.type)
        if (block.type === 'text') {
          this.textOpen = true
          return this.progress('writing')
        }
        if (block.type === 'tool_use') return this.progress('tool', toolLabel(block.name))
        return this.progress('thinking')
      }
      case 'content_block_delta': {
        const d = ev.delta
        const chunk = d.type === 'text_delta' ? d.text : d.type === 'thinking_delta' ? d.thinking : d.type === 'input_json_delta' ? d.partial_json : ''
        this.tokens.estimate += chunk.length / CHARS_PER_TOKEN
        if (d.type === 'text_delta') {
          this.shown = true
          this.tags.feed(d.text)
        }
        return this.progress(this.phase, this.note)
      }
      case 'content_block_stop':
        if (this.blocks.get(ev.index) === 'text') this.endText()
        return
      case 'message_delta':
        this.tokens.reported = ev.usage.output_tokens
        return this.progress(this.phase, this.note)
    }
  }

  private onAssistant(m: Extract<SDKMessage, { type: 'assistant' }>) {
    const sub = m.parent_tool_use_id !== null
    if (!sub && m.error) {
      // Auth and API failures arrive as a synthetic assistant message with an error code.
      this.shown = this.errorShown = true
      const detail = textOf(m.message.content).trim()
      const friendly = ERROR_TEXT[m.error]
      const text = friendly ? (detail && !friendly.includes(detail) ? `${friendly}\n${detail}` : friendly) : detail || `Claude reported an error: ${m.error}`
      this.emit({ t: 'error', kind: AUTH_ERRORS.has(m.error) ? 'auth' : 'api', message: text })
    } else if (!sub && !this.streamed.has(m.message.id)) {
      // Never streamed: output of a command like /context, or a reply the CLI fetched without streaming.
      for (const block of m.message.content) {
        if (block.type !== 'text' || !block.text.trim() || PLACEHOLDERS.has(block.text.trim())) continue
        this.shown = true
        if (m.message.model === SYNTHETIC_MODEL) this.notice(commandText(block.text), 'command')
        else {
          this.textOpen = true
          this.tags.feed(block.text)
          this.endText()
        }
      }
    }
    for (const block of m.message.content) {
      if (block.type === 'tool_use') this.onToolUse(block.id, block.name, (block.input ?? {}) as Record<string, unknown>, sub)
    }
  }

  private onToolUse(id: string, name: string, input: Record<string, unknown>, sub: boolean) {
    this.uses.set(id, { name, input })
    this.emit({ t: 'tool', id, name: toolLabel(name), detail: describeTool(name, input, this.cwd), input: prettyInput(input), sub })
    if (name === 'Agent' || name === 'Task') this.setAgent(id, str(input.description) || str(input.subagent_type), 'running')
    if (name === 'TodoWrite' && !sub && Array.isArray(input.todos)) {
      const items = input.todos as { content?: unknown; status?: unknown }[]
      this.todos = new Map(items.map((t, i) => [`todo-${i}`, { id: `todo-${i}`, content: str(t.content), status: this.todoStatus(t.status) }]))
      this.emitTodos()
    }
  }

  private onUser(m: Extract<SDKMessage, { type: 'user' }>) {
    const content = m.message.content
    const results = Array.isArray(content) ? (content.filter((b) => b.type === 'tool_result') as unknown as ToolResult[]) : []
    if (!results.length) {
      // A local command's output can come back as a user message wrapped in <local-command-stdout>.
      const out = [...textOf(content).matchAll(LOCAL_OUTPUT)].map((x) => x[2]).join('\n')
      if (this.capture && out.trim()) return void this.capture.out.push(commandText(out))
      if (!this.shown && out.trim()) this.notice(commandText(out), 'command')
      return
    }
    const sub = m.parent_tool_use_id !== null
    for (const block of results) {
      // The structured result belongs to the message's only tool_result.
      const structured = results.length === 1 ? m.tool_use_result : undefined
      const ok = block.is_error !== true
      this.emit({ t: 'tool_done', id: block.tool_use_id, ok, output: toolOutput(block.content, structured) })
      const use = this.uses.get(block.tool_use_id)
      this.uses.delete(block.tool_use_id)
      if (use) this.track(block.tool_use_id, use.name, use.input, ok, structured as Record<string, unknown> | undefined)
    }
    if (!sub) {
      this.progress('thinking')
      this.scheduleContextRefresh()
    }
  }

  /** Quest log and party from tool results: Task* ids only exist in the result. */
  private track(id: string, name: string, input: Record<string, unknown>, ok: boolean, r: Record<string, unknown> | undefined) {
    switch (name) {
      case 'Agent':
      case 'Task': {
        // Background agents answer at once with async_launched; they finish with a task_notification.
        const status = str(r?.status)
        if (!ok) this.setAgent(id, '', 'failed')
        else if (status !== 'async_launched' && status !== 'remote_launched') this.setAgent(id, '', 'done')
        return
      }
      case 'TaskCreate': {
        const task = r?.task as { id?: string; subject?: string } | undefined
        if (!ok || !task?.id) return
        this.todos.set(task.id, { id: task.id, content: task.subject || str(input.subject), status: 'pending' })
        return this.emitTodos()
      }
      case 'TaskUpdate': {
        const taskId = str(input.taskId) || str(r?.taskId)
        if (!ok || r?.success === false || !taskId) return
        if (input.status === 'deleted') this.todos.delete(taskId)
        else {
          const prev = this.todos.get(taskId)
          this.todos.set(taskId, {
            id: taskId,
            content: str(input.subject) || prev?.content || `#${taskId}`,
            status: input.status ? this.todoStatus(input.status) : (prev?.status ?? 'pending'),
          })
        }
        return this.emitTodos()
      }
      case 'TaskList': {
        const tasks = r?.tasks as { id: string; subject: string; status: unknown }[] | undefined
        if (!ok || !Array.isArray(tasks)) return
        this.todos = new Map(tasks.map((t) => [t.id, { id: t.id, content: t.subject, status: this.todoStatus(t.status) }]))
        return this.emitTodos()
      }
      case 'TaskGet': {
        const task = r?.task as { id: string; subject: string; status: unknown } | null | undefined
        if (!ok || !task) return
        this.todos.set(task.id, { id: task.id, content: task.subject, status: this.todoStatus(task.status) })
        return this.emitTodos()
      }
    }
  }

  private todoStatus(v: unknown): Todo['status'] {
    return TODO_STATUS.has(v as Todo['status']) ? (v as Todo['status']) : 'pending'
  }

  private emitTodos() {
    this.emit({ t: 'todos', items: [...this.todos.values()] })
  }

  private setAgent(id: string, description: string, status: AgentStatus) {
    const prev = this.agents.get(id)
    const desc = description || prev?.description || 'Helper'
    if (prev?.status === status && prev.description === desc) return
    this.agents.set(id, { description: desc, status })
    this.emit({ t: 'agent', id, description: desc, status })
  }

  private onResult(m: Extract<SDKMessage, { type: 'result' }>) {
    const sent = m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : [])
    const appendOnly = sent.length > 0 && sent.every((id) => this.silent.has(id))
    if (this.capture && sent.includes(this.capture.uuid)) {
      const c = this.capture
      this.capture = undefined
      // Output arrives as its own message before the result; a command with none answers in the result text.
      c.done([...new Set(c.out)].join('\n') || commandText(m.subtype === 'success' ? m.result : ''))
    }
    for (const id of sent) this.silent.delete(id)
    if (appendOnly) {
      // Appends queued behind a turn finish after it, so the last of them is what ends the CLI's run.
      if (!(m.queued_turn_count ?? 0) && !this.swallowIdle) {
        this.running = false
        this.turnStart = 0
      }
      return
    }
    this.swallowIdle = false
    this.endText()
    const reason = m.terminal_reason ?? ''
    const interrupted = INTERRUPTED.has(reason)
    const soft = SOFT_STOPS[reason]
    let error: string | undefined
    if (m.subtype === 'success') {
      if (m.is_error && !interrupted) error = m.result || 'The turn failed.'
      // A local command (/context, /cost, an unknown /x) answers only through the result text.
      else if (!this.shown && m.result.trim()) this.notice(commandText(m.result), 'command')
    } else if (!interrupted && !soft) {
      error = m.errors.join('\n') || m.subtype.replaceAll('_', ' ')
    }
    if (soft) this.notice(soft, 'info')

    // Cost, API time and modelUsage are running totals for the session (they carry over on resume).
    // Error results can carry zeroes, so a total never goes down here; /clear resets them in adoptSession.
    this.haveResult = true
    this.stats.costUsd = Math.max(this.stats.costUsd, m.total_cost_usd)
    this.stats.apiMs = Math.max(this.stats.apiMs, m.duration_api_ms)
    const usage = Object.values(m.modelUsage ?? {})
    if (usage.length) this.applyModelUsage(usage)
    this.stats.turns++

    const now = Date.now()
    // An API or auth error already went out with its assistant message; the turn still ends as failed.
    const fresh = error && !this.errorShown ? { error } : {}
    this.emit({ t: 'turn_end', ok: !error, interrupted, ...fresh, seconds: this.turnStart ? (now - this.turnStart) / MS_PER_S : 0 })
    this.emitStats()

    this.streamed.clear()
    this.shown = this.errorShown = false
    this.tokens = { done: 0, reported: 0, estimate: 0 }
    // Messages sent during the turn run next without new input, so their turn starts now.
    if ((m.queued_turn_count ?? 0) > 0) this.turnStart = now
    else {
      this.running = false
      this.turnStart = 0
    }
    void this.refreshStats()
  }

  private onSystem(m: Extract<SDKMessage, { type: 'system' }>) {
    switch (m.subtype) {
      case 'init': {
        this.adoptSession(m.session_id)
        const mode = m.permissionMode as PermissionModeName
        if (m.model !== this.stats.model || mode !== this.stats.mode) {
          this.stats.model = m.model
          this.stats.mode = mode
          this.emitStats()
        }
        return
      }
      case 'status':
        if (m.permissionMode && m.permissionMode !== this.stats.mode) {
          this.stats.mode = m.permissionMode as PermissionModeName
          this.emitStats()
        }
        if (m.status === 'compacting') this.progress('compacting')
        else if (this.phase === 'compacting') this.progress('thinking')
        if (m.compact_result === 'failed') this.notice(`Compacting failed${m.compact_error ? `: ${m.compact_error}` : '.'}`, 'info')
        return
      case 'session_state_changed':
        if (m.state === 'running' && !this.running && this.silent.size) {
          this.quiet = true
          return
        }
        if (m.state === 'idle' && this.quiet) {
          this.quiet = false
          return
        }
        if (m.state === 'idle' && this.swallowIdle) {
          this.swallowIdle = false
          return
        }
        // The CLI's idle is the authoritative end of a run, whatever results came before it.
        if (m.state === 'idle') {
          this.running = false
          this.turnStart = 0
        }
        // A turn the user didn't start (a finished background agent reporting back) starts here.
        if (m.state === 'running' && !this.turnStart) {
          this.running = true
          this.turnStart = Date.now()
        }
        return this.emit({ t: 'state', state: m.state })
      case 'commands_changed':
        return this.emit({
          t: 'commands',
          commands: m.commands.map((x) => ({ name: x.name, description: x.description, argumentHint: x.argumentHint, builtin: x.builtin === true, ...(x.aliases?.length ? { aliases: x.aliases } : {}) })),
        })
      case 'elicitation_complete':
        // The server saw the URL flow finish (a sign-in in the browser): its dialog has nothing left to wait for.
        for (const [id, e] of this.elicits) {
          if (e.elicitationId !== m.elicitation_id) continue
          this.emit({ t: 'ask_cancel', id })
          e.finish({ action: 'accept' })
        }
        return
      case 'local_command_output':
        if (this.capture) return void this.capture.out.push(commandText(m.content))
        if (!this.shown) this.notice(commandText(m.content), 'command')
        return
      case 'compact_boundary': {
        const { trigger, pre_tokens: pre, post_tokens: post } = m.compact_metadata
        const how = trigger === 'auto' ? 'Context compacted automatically' : 'Context compacted'
        this.notice(`${how}: ${kTokens(pre)}${post !== undefined ? ` → ${kTokens(post)}` : ''} tokens.`, 'compact')
        return void this.refreshStats()
      }
      case 'api_retry': {
        const status = m.error_status ? ` ${m.error_status}` : ''
        const wait = Math.round(m.retry_delay_ms / MS_PER_S)
        this.notice(`API error${status} (${m.error.replaceAll('_', ' ')}). Retrying ${m.attempt}/${m.max_retries} in ${wait}s…`, 'retry')
        return this.progress('retrying', `${m.attempt}/${m.max_retries}`)
      }
      case 'thinking_tokens':
        this.tokens.estimate += m.estimated_tokens_delta
        return this.progress(this.phase, this.note)
      case 'task_started':
        if (!m.ambient && (m.task_type === 'local_agent' || m.subagent_type)) this.setAgent(m.tool_use_id ?? m.task_id, m.description, 'running')
        return
      case 'task_notification': {
        const id = m.tool_use_id ?? m.task_id
        const agent = this.agents.get(id)
        if (!agent) return
        this.setAgent(id, '', m.status === 'completed' ? 'done' : 'failed')
        if (m.summary && !m.skip_transcript) this.notice(`${agent.description}: ${m.summary}`, 'info')
        return
      }
      case 'permission_denied': {
        const why = m.decision_reason || m.message
        return this.notice(`${toolLabel(m.tool_name)} was denied${why ? `: ${why}` : '.'}`, 'info')
      }
      case 'informational':
        if (m.level === 'warning' || m.level === 'notice') this.notice(m.content.replace(ANSI, ''), 'info')
        return
    }
  }

  private onRateLimit(info: Extract<SDKMessage, { type: 'rate_limit_event' }>['rate_limit_info']) {
    const key = info.rateLimitType === 'five_hour' ? 'fiveHour' : info.rateLimitType === 'seven_day' ? 'weekly' : info.rateLimitType === 'seven_day_opus' ? 'weeklyOpus' : undefined
    const prev = key ? this.stats.limits[key] : undefined
    // Event utilization is a 0–1 fraction from the API headers, resetsAt is in seconds.
    const resetsAt = info.resetsAt ? info.resetsAt * MS_PER_S : prev?.resetsAt
    if (info.status === 'rejected' && prev?.status !== 'rejected') {
      const when = resetsAt ? ` It resets at ${new Date(resetsAt).toLocaleString()}.` : ''
      this.notice(`Usage limit reached.${when}`, 'info')
    }
    if (!key) return
    const pct = info.utilization !== undefined ? info.utilization * 100 : info.status === 'rejected' ? 100 : (prev?.pct ?? 0)
    this.stats.limits[key] = { pct, resetsAt, status: info.status }
    this.emitStats()
  }

  /** A new session id means /clear (or a plan-mode reset): the CLI's totals start over, so ours do too. */
  private adoptSession(id: string) {
    if (!id || id === this.sid) return
    const cleared = this.sid !== undefined
    this.sid = id
    this.emit({ t: 'session_id', sessionId: id })
    if (!cleared) return
    const { model, mode, limits } = this.stats
    this.stats = { ...freshStats(), model, mode, limits }
    this.haveResult = false
    this.todos.clear()
    this.emitTodos()
    this.emitStats()
    void this.refreshStats()
  }

  private applyModelUsage(usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }[]) {
    const sum = (f: (u: (typeof usage)[number]) => number) => usage.reduce((n, u) => n + (f(u) || 0), 0)
    this.stats.tokensIn = sum((u) => u.inputTokens)
    this.stats.tokensOut = sum((u) => u.outputTokens)
    this.stats.cacheRead = sum((u) => u.cacheReadInputTokens)
    this.stats.cacheWrite = sum((u) => u.cacheCreationInputTokens)
  }

  private applyContext(ctx: ContextUsage) {
    this.stats.context = {
      used: ctx.totalTokens,
      max: ctx.maxTokens,
      parts: ctx.categories
        .filter((c) => (c.kind === 'used' || c.kind === 'buffer') && c.id)
        .map((c) => ({ id: c.id as string, tokens: c.tokens, kind: c.kind })),
    }
    if (ctx.model) this.stats.model = ctx.model
  }

  /** Re-reads the context gauge shortly after tool results, so a long turn doesn't leave it stale. */
  private scheduleContextRefresh() {
    clearTimeout(this.contextTimer)
    this.contextTimer = setTimeout(() => {
      void this.q
        ?.getContextUsage({ detail: 'summary' })
        .then((ctx) => {
          this.applyContext(ctx)
          this.emitStats()
        })
        .catch(() => undefined)
    }, CONTEXT_REFRESH_MS)
  }

  /** Context use, lines changed and plan limits. Calls overlapping a running refresh coalesce into one more. */
  private refreshStats(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true
      return this.refreshing
    }
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false
        await this.readStats()
      } while (this.refreshAgain && !this.ended)
    })().finally(() => (this.refreshing = undefined))
    return this.refreshing
  }

  private async readStats() {
    const q = this.q
    if (!q || this.ended) return
    const [ctx, usage] = await Promise.all([
      q.getContextUsage({ detail: 'summary' }).catch(() => undefined),
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }).catch(() => undefined),
    ])
    if (ctx) this.applyContext(ctx)
    const session = usage?.session
    if (session) {
      this.stats.linesAdded = session.total_lines_added
      this.stats.linesRemoved = session.total_lines_removed
      // Before the first result (a resumed session) this is the only source of the carried-over totals.
      if (!this.haveResult) {
        this.stats.costUsd = session.total_cost_usd
        this.stats.apiMs = session.total_api_duration_ms
        this.applyModelUsage(Object.values(session.model_usage ?? {}))
      }
    }
    const limits = usage?.rate_limits_available ? usage.rate_limits : undefined
    if (limits) {
      // The usage API reports 0–100 and ISO times; the status comes only from rate_limit_event.
      const toLimit = (w: UsageWindow, prev: Limit | undefined): Limit | undefined =>
        w && typeof w.utilization === 'number'
          ? { pct: w.utilization, resetsAt: w.resets_at ? Date.parse(w.resets_at) : prev?.resetsAt, status: prev?.status }
          : prev
      const l = this.stats.limits
      l.fiveHour = toLimit(limits.five_hour, l.fiveHour)
      l.weekly = toLimit(limits.seven_day, l.weekly)
      l.weeklyOpus = toLimit(limits.seven_day_opus, l.weeklyOpus)
    }
    this.emitStats()
  }

  /** Every permission check, AskUserQuestion and plan approval becomes a choice menu in the app. */
  private async ask(name: string, input: Record<string, unknown>, o: AskOptions): Promise<PermissionResult> {
    const cancelled: PermissionResult = { behavior: 'deny', message: 'Cancelled.' }
    const kind: AskKind = name === 'AskUserQuestion' ? 'question' : name === 'ExitPlanMode' ? 'plan' : 'permission'
    const diffs = kind === 'permission' ? await buildDiffs(name, input, this.cwd).catch(() => []) : []
    if (o.signal.aborted || this.ended) return cancelled
    const id = randomUUID()
    const canAlways = (o.suggestions?.length ?? 0) > 0 && !o.suppressAlwaysAllowRule
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(id, { kind, input, suggestions: o.suggestions, canAlways, resolve })
      o.signal.addEventListener(
        'abort',
        () => {
          if (!this.pending.delete(id)) return
          this.emit({ t: 'ask_cancel', id })
          resolve(cancelled)
        },
        { once: true },
      )
      if (kind === 'question') return this.emit({ t: 'ask_question', id, questions: this.questions(input) })
      if (kind === 'plan') {
        const planFile = str(input.planFilePath)
        return this.emit({ t: 'ask_plan', id, plan: str(input.plan), ...(planFile ? { planFile } : {}) })
      }
      const shellTool = name === 'Bash' || name === 'PowerShell' || name === 'Monitor'
      const reason = this.reason(o, shellTool ? str(input.description) : '')
      // Nothing is approved unseen: a tool without a diff or a command (MCP tools above all) shows all its parameters.
      const full = !shellTool && !diffs.length ? prettyInput(input) : ''
      const always = canAlways ? describeAlways(o.suggestions ?? []) : ''
      this.emit({
        t: 'ask_permission',
        id,
        tool: toolLabel(name),
        // '' when the CLI gives no title: the app words its own.
        title: this.inVoice(o.title || o.displayName || ''),
        detail: shellTool ? clip(str(input.command)) : describeTool(name, input, this.cwd),
        diffs,
        canAlways,
        danger: isDestructive(name, input),
        defaultToNo: o.defaultToNo === true,
        ...(reason ? { reason } : {}),
        ...(full ? { input: full } : {}),
        ...(always ? { always } : {}),
      })
    })
  }

  /** The bridge writes prompts as "Claude wants to …"; in this app the character is the one asking. */
  private inVoice(text: string) {
    const name = this.opts.settings.waifu.name.trim()
    return name ? text.replace(/\bClaude\b(?! Code)/g, name) : text
  }

  /** The sub-line under the prompt: what the command does (its own description), then why the CLI asks. */
  private reason(o: AskOptions, purpose: string) {
    const parts = [purpose, o.description && this.inVoice(o.description), o.decisionReason, o.blockedPath && `Path: ${o.blockedPath}`]
    return [...new Set(parts.filter((x): x is string => !!x?.trim()))].join(' · ') || undefined
  }

  private questions(input: Record<string, unknown>): Question[] {
    const qs = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : []
    return qs.map((q) => ({
      question: str(q.question),
      header: str(q.header),
      multiSelect: q.multiSelect === true,
      options: (Array.isArray(q.options) ? (q.options as Record<string, unknown>[]) : []).map((x) => ({
        label: str(x.label),
        description: str(x.description),
        ...(typeof x.preview === 'string' ? { preview: x.preview } : {}),
      })),
    }))
  }

  /** An MCP server asks for input: shown as a form or URL menu (ask_elicit) until answered or the server gives up. */
  private elicit(r: ElicitationRequest, signal: AbortSignal): Promise<ElicitationResult> {
    const id = randomUUID()
    const fields = r.mode === 'url' ? [] : elicitFields(r.requestedSchema)
    return new Promise((resolve) => {
      const finish = (res: ElicitationResult) => {
        if (!this.elicits.delete(id)) return
        signal.removeEventListener('abort', onAbort)
        resolve(res)
      }
      const onAbort = () => {
        this.emit({ t: 'ask_cancel', id })
        finish({ action: 'cancel' })
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.elicits.set(id, { fields, finish, elicitationId: r.elicitationId })
      this.emit({
        t: 'ask_elicit',
        id,
        server: r.serverName,
        mode: r.mode === 'url' ? 'url' : 'form',
        message: r.message,
        ...(r.title ? { title: r.title } : {}),
        ...(r.url ? { url: r.url } : {}),
        fields,
      })
    })
  }

  /** The user's answer to an elicitation. A form that doesn't fit its schema is refused with the reason. */
  answerElicit(id: string, action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>) {
    const e = this.elicits.get(id)
    if (!e) return
    if (action !== 'accept' || !e.fields.length) return e.finish({ action })
    e.finish({ action, content: elicitContent(e.fields, content ?? {}) })
  }

  private take(id: string) {
    const p = this.pending.get(id)
    this.pending.delete(id)
    return p
  }
}

export const createSession: SessionFactory = (opts) => new Session(opts)
