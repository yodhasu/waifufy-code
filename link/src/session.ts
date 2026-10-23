import { randomUUID } from 'node:crypto'
import {
  query,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { persona } from './persona.ts'
import { EMOTIONS, type Emotion, type PermissionModeName, type ServerMsg, type Stats } from './protocol.ts'
import { rememberSession } from './store.ts'

type Emit = (m: ServerMsg) => void

/** The user's messages, fed to query() one at a time as they are typed. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = []
  private wake?: () => void
  private closed = false

  push(text: string) {
    this.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, origin: { kind: 'human' } })
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

/**
 * Splits streamed text into text and emotion tags. A `[` holds the stream back until its `]`
 * (or until it can no longer be a tag), so a tag split across deltas is still caught.
 */
class TagParser {
  private buf = ''
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

  flush() {
    this.drain(true)
    if (this.buf) this.onText(this.buf)
    this.buf = ''
  }

  private drain(isFinal: boolean) {
    const longest = Math.max(...EMOTIONS.map((e) => e.length)) + 2
    while (this.buf) {
      const open = this.buf.indexOf('[')
      if (open === -1) return this.take(this.buf.length)
      if (open > 0) this.take(open)
      const close = this.buf.indexOf(']')
      if (close === -1) {
        if (!isFinal && this.buf.length < longest) return
        this.take(1)
        continue
      }
      const word = this.buf.slice(1, close)
      if ((EMOTIONS as readonly string[]).includes(word)) {
        this.onFace(word as Emotion)
        this.buf = this.buf.slice(close + 1).replace(/^ /, '')
      } else {
        this.take(close + 1)
      }
    }
  }

  private take(n: number) {
    this.onText(this.buf.slice(0, n))
    this.buf = this.buf.slice(n)
  }
}

const DESTRUCTIVE = /git\s+reset\s+--hard|git\s+push\s+.*(--force|-f\b)|git\s+clean\s+-\w*f|git\s+branch\s+-D|rm\s+-\w*r\w*f|Remove-Item\b.*-Recurse/i

function str(v: unknown) {
  return typeof v === 'string' ? v : ''
}

/** A one-line description of a tool call for the actions log and permission prompts. */
export function describeTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return str(input.command)
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return str(input.file_path) || str(input.notebook_path)
    case 'Grep':
    case 'Glob':
      return str(input.pattern)
    case 'WebFetch':
      return str(input.url)
    case 'WebSearch':
      return str(input.query)
    case 'Skill':
      return str(input.skill) || str(input.command)
    case 'Agent':
    case 'Task':
      return str(input.description) || str(input.subagent_type)
    case 'TodoWrite':
      return `${Array.isArray(input.todos) ? input.todos.length : 0} quests`
  }
  const first = Object.values(input).find((v) => typeof v === 'string')
  return typeof first === 'string' ? first : ''
}

/** `mcp__claude_ai_Slack__slack_send_message` → `claude_ai_Slack · slack_send_message`. */
export function toolLabel(name: string) {
  return name.startsWith('mcp__') ? name.slice(5).split('__').join(' · ') : name
}

type Pending = { input: Record<string, unknown>; suggestions?: PermissionUpdate[]; resolve: (r: PermissionResult) => void }

export class Session {
  readonly cwd: string
  readonly stats: Stats = { costUsd: 0, turns: 0, apiMs: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, limits: {} }
  private emit: Emit
  private q: Query
  private inbox = new Inbox()
  private pending = new Map<string, Pending>()
  /** Input of the last answered request, which AskUserQuestion's answers are merged into. */
  private lastInput: Record<string, unknown> = {}
  /** Content block types of the message being streamed, by index. */
  private blocks = new Map<number, string>()
  private tags: TagParser
  private turnStart = 0

  constructor(cwd: string, resume: string | undefined, userName: string, emit: Emit) {
    this.cwd = cwd
    this.emit = emit
    this.tags = new TagParser((delta) => emit({ t: 'text', delta }), (emotion) => emit({ t: 'face', emotion }))
    this.q = query({
      prompt: this.inbox,
      options: {
        cwd,
        resume,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: persona(userName) },
        // The same CLAUDE.md, skills, MCP servers, hooks and permission rules as the terminal.
        settingSources: ['user', 'project', 'local'],
        includePartialMessages: true,
        canUseTool: (name, input, opts) => this.ask(name, input, opts.suggestions, opts.signal),
      },
    })
    void this.pump()
  }

  say(text: string) {
    this.stats.turns++
    this.turnStart = Date.now()
    this.inbox.push(text)
  }

  async interrupt() {
    for (const [id, p] of this.pending) {
      this.emit({ t: 'ask_cancel', id })
      p.resolve({ behavior: 'deny', message: 'The user interrupted.', interrupt: true })
    }
    this.pending.clear()
    await this.q.interrupt().catch(() => {})
  }

  close() {
    this.inbox.close()
    this.q.close()
  }

  async setMode(mode: PermissionModeName) {
    await this.q.setPermissionMode(mode)
    this.stats.mode = mode
    this.emit({ t: 'stats', stats: this.stats })
  }

  async setModel(model: string) {
    await this.q.setModel(model)
    this.stats.model = model
    this.emit({ t: 'stats', stats: this.stats })
  }

  answerPermission(id: string, decision: 'allow' | 'always' | 'deny', message?: string) {
    const p = this.take(id)
    if (!p) return
    if (decision === 'deny') return p.resolve({ behavior: 'deny', message: message || 'The user declined.' })
    p.resolve({
      behavior: 'allow',
      updatedInput: p.input,
      ...(decision === 'always' && p.suggestions ? { updatedPermissions: p.suggestions } : {}),
    })
  }

  answerQuestion(id: string, answers: Record<string, string>) {
    this.take(id)?.resolve({ behavior: 'allow', updatedInput: { ...this.lastInput, answers } })
  }

  private take(id: string) {
    const p = this.pending.get(id)
    this.pending.delete(id)
    if (p) this.lastInput = p.input
    return p
  }

  /** Every permission check, AskUserQuestion and plan approval becomes a choice menu in the app. */
  private ask(name: string, input: Record<string, unknown>, suggestions: PermissionUpdate[] | undefined, signal: AbortSignal) {
    const id = randomUUID()
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(id, { input, suggestions, resolve })
      signal.addEventListener('abort', () => {
        if (!this.pending.delete(id)) return
        this.emit({ t: 'ask_cancel', id })
        resolve({ behavior: 'deny', message: 'Cancelled.' })
      })
      if (name === 'AskUserQuestion') {
        this.emit({ t: 'ask_question', id, questions: (input.questions as never) ?? [] })
      } else if (name === 'ExitPlanMode') {
        this.emit({ t: 'ask_plan', id, plan: str(input.plan) })
      } else {
        const detail = describeTool(name, input)
        this.emit({
          t: 'ask_permission',
          id,
          tool: toolLabel(name),
          detail,
          canAlways: (suggestions?.length ?? 0) > 0,
          danger: (name === 'Bash' || name === 'PowerShell') && DESTRUCTIVE.test(detail),
        })
      }
    })
  }

  private async pump() {
    try {
      for await (const m of this.q) await this.onMessage(m)
    } catch (e) {
      this.emit({ t: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      this.emit({ t: 'ended' })
    }
  }

  private async onMessage(m: SDKMessage) {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          this.stats.model = m.model
          this.stats.mode = m.permissionMode
          await rememberSession(m.session_id, this.cwd).catch(() => {})
          const [commands, models] = await Promise.all([
            this.q.supportedCommands().catch(() => []),
            this.q.supportedModels().catch(() => []),
          ])
          const hidden = new Set(m.terminal_slash_commands ?? [])
          this.emit({
            t: 'init',
            sessionId: m.session_id,
            commands: commands
              .filter((c) => !hidden.has(c.name))
              .map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint, builtin: c.builtin === true })),
            models: models.map((x) => ({ value: x.value, displayName: x.displayName })),
          })
          // Fill the gauges before the first turn, which matters most on resume. Not awaited, so the stream keeps flowing.
          void this.refreshStats()
        } else if (m.subtype === 'session_state_changed') {
          this.emit({ t: 'state', state: m.state })
        }
        return

      case 'stream_event': {
        // Only the main agent speaks in the dialogue box; subagents show up as actions.
        if (m.parent_tool_use_id) return
        const ev = m.event
        if (ev.type === 'content_block_start') {
          this.blocks.set(ev.index, ev.content_block.type)
        } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          this.tags.feed(ev.delta.text)
        } else if (ev.type === 'content_block_stop' && this.blocks.get(ev.index) === 'text') {
          this.tags.flush()
          this.emit({ t: 'text_end' })
        }
        return
      }

      case 'assistant': {
        if (m.error) this.emit({ t: 'error', message: `Claude: ${m.error}` })
        for (const block of m.message.content) {
          if (block.type !== 'tool_use') continue
          const input = (block.input ?? {}) as Record<string, unknown>
          if (block.name === 'TodoWrite' && Array.isArray(input.todos)) this.emit({ t: 'todos', items: input.todos as never })
          this.emit({ t: 'tool', id: block.id, name: toolLabel(block.name), detail: describeTool(block.name, input), sub: m.parent_tool_use_id !== null })
        }
        return
      }

      case 'user': {
        const content = m.message.content
        if (!Array.isArray(content)) return
        for (const block of content) {
          if (block.type === 'tool_result') this.emit({ t: 'tool_done', id: block.tool_use_id, ok: block.is_error !== true })
        }
        return
      }

      case 'result': {
        // Cost and modelUsage are running totals; API time is per turn. /usage overrides both if it answers.
        this.stats.costUsd = m.total_cost_usd
        this.stats.apiMs += m.duration_api_ms
        const usage = Object.values(m.modelUsage ?? {})
        this.stats.tokensIn = usage.reduce((n, u) => n + u.inputTokens, 0)
        this.stats.tokensOut = usage.reduce((n, u) => n + u.outputTokens, 0)
        this.stats.cacheRead = usage.reduce((n, u) => n + u.cacheReadInputTokens, 0)
        this.stats.cacheWrite = usage.reduce((n, u) => n + u.cacheCreationInputTokens, 0)
        const ok = m.subtype === 'success' && !m.is_error
        this.emit({
          t: 'turn_end',
          ok,
          error: ok ? undefined : m.subtype === 'success' ? m.result : m.subtype,
          seconds: this.turnStart ? (Date.now() - this.turnStart) / 1000 : 0,
        })
        await this.refreshStats()
        return
      }

      case 'rate_limit_event': {
        const info = m.rate_limit_info
        if (info.utilization === undefined) return
        const limit = { pct: info.utilization <= 1 ? info.utilization * 100 : info.utilization, resetsAt: info.resetsAt ? info.resetsAt * (info.resetsAt < 1e12 ? 1000 : 1) : undefined }
        if (info.rateLimitType === 'five_hour') this.stats.limits.fiveHour = limit
        if (info.rateLimitType === 'seven_day') this.stats.limits.weekly = limit
        this.emit({ t: 'stats', stats: this.stats })
        return
      }
    }
  }

  /** Context use, and plan limits from the (experimental) /usage data when it answers. */
  private async refreshStats() {
    const ctx = await this.q.getContextUsage({ detail: 'summary' }).catch(() => undefined)
    if (ctx) {
      this.stats.context = {
        used: ctx.totalTokens,
        max: ctx.maxTokens,
        parts: ctx.categories.filter((c) => c.kind === 'used' && c.id).map((c) => ({ id: c.id!, tokens: c.tokens })),
      }
    }
    const usage = await this.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }).catch(() => undefined)
    if (usage?.session) {
      this.stats.costUsd = usage.session.total_cost_usd
      this.stats.apiMs = usage.session.total_api_duration_ms
    }
    const limits = usage?.rate_limits_available ? usage.rate_limits : null
    const toLimit = (w?: { utilization: number | null; resets_at: string | null } | null) =>
      w && w.utilization !== null ? { pct: w.utilization, resetsAt: w.resets_at ? Date.parse(w.resets_at) : undefined } : undefined
    if (limits) {
      this.stats.limits.fiveHour = toLimit(limits.five_hour) ?? this.stats.limits.fiveHour
      this.stats.limits.weekly = toLimit(limits.seven_day) ?? this.stats.limits.weekly
    }
    this.emit({ t: 'stats', stats: this.stats })
  }
}
