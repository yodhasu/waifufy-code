// One casual turn: the prompt from her shared history and memories, a reply streamed through the same tag parser
// as work mode (faces, voice lines, affection), her hidden appraisal fed to her heart, and the exchange written
// back to the work transcript, her journal and the history both modes share.

import { query, type CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import { AFFECTION_TAGS, type Mood as Closeness } from '../affection.ts'
import type { Image, SessionEvent, Settings } from '../protocol.ts'
import { searchHistory, SEARCH_HISTORY_DESCRIPTION } from '../history-search.ts'
import { addressOf, defaultSettings } from '../settings.ts'
import { TagParser } from '../session.ts'
import { childEnv } from '../shell.ts'
import { clip, describeTool, toolLabel, toolOutput } from '../tools.ts'
import type { HeartBox } from './modes.ts'
import type { Memory } from './memory.ts'
import { casualSystem, contextNote, historyMessages, REPLY_MAX_TOKENS, type PoolEntry } from './prompt.ts'
import { claudeProvider, mockCasual, pickProvider, type Provider, type ToolSpec, type Usage } from './providers.ts'

/** Her appraisal of the user's message: joy, sadness, anger, surprise, fear (-1 – 1), confidence, a work request. */
export type Appraisal = { feel: number[]; confidence: number; work: boolean }

/** Past this much text, an unclosed `<feel` is not one. */
const FEEL_HOLD = 160
/** Her toolkit's report, at most. */
const TOOLKIT_REPORT_MAX = 2500
const TOOLKIT_MAX_TURNS = 10
/** The toolkit looks things up; it never edits files from a casual chat (that is work mode's job). */
const TOOLKIT_NO_EDITS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
/** Looking things up needs no prompt in a casual chat; anything else still asks, as in work mode. */
const TOOLKIT_READ_ONLY = ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep']

/**
 * Takes the <feel …/> appraisal out of her reply, wherever it comes (models put it first, but after a tool
 * call it can turn up mid-reply), keeps the first one, and passes the rest on. A `<` holds the stream back
 * until it can no longer be the start of one. Also drops the [work] history label if she echoes it.
 */
export class FeelParser {
  private buf = ''
  private started = false
  appraisal?: Appraisal
  private onText: (s: string) => void
  constructor(onText: (s: string) => void) {
    this.onText = onText
  }

  feed(s: string) {
    this.buf += s
    this.drain(false)
  }

  flush() {
    this.drain(true)
  }

  private emit(s: string) {
    // Nothing before her first word: the line break after the appraisal, or a [work] label she copied.
    const t = (this.started ? s : s.replace(/^\s+/, '')).replace(/\[work\][ \t]*/gi, '')
    if (!t) return
    this.started = true
    this.onText(t)
  }

  private drain(final: boolean) {
    for (;;) {
      const lt = this.buf.indexOf('<')
      // A "[work" still arriving is held too, so the label never shows in pieces.
      const label = this.buf.search(/\[w(o(r(k\]?)?)?)?$/i)
      if (lt === -1) {
        if (label !== -1 && !final) {
          this.emit(this.buf.slice(0, label))
          this.buf = this.buf.slice(label)
        } else {
          this.emit(this.buf)
          this.buf = ''
        }
        return
      }
      this.emit(this.buf.slice(0, lt))
      this.buf = this.buf.slice(lt)
      const head = this.buf.slice(0, 5).toLowerCase()
      if (!final && this.buf.length < 5 && '<feel'.startsWith(head)) return
      if (head === '<feel') {
        const close = this.buf.indexOf('>')
        if (close === -1) {
          if (!final && this.buf.length < FEEL_HOLD) return
          this.emit(this.buf)
          this.buf = ''
          return
        }
        this.appraisal ??= parseFeel(this.buf.slice(5, close))
        this.buf = this.buf.slice(close + 1).replace(/^[ \t]*\r?\n?/, '')
        continue
      }
      this.emit('<')
      this.buf = this.buf.slice(1)
    }
  }
}

export function parseFeel(attrs: string): Appraisal {
  // Full names (the prompt's) or their first letters; c and w are the short forms of sure and work.
  const v = (...keys: string[]) => {
    for (const k of keys) {
      const m = new RegExp(`\\b${k}\\s*=\\s*"?(-?[\\d.]+)`).exec(attrs)
      if (!m) continue
      const n = Number(m[1])
      return Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0
    }
    return 0
  }
  return {
    feel: [v('joy', 'j'), v('sadness', 's'), v('anger', 'a'), v('surprise', 'u'), v('fear', 'f')],
    confidence: Math.max(0, v('sure', 'c')),
    work: v('work', 'w') >= 0.5,
  }
}

export type EngineOptions = {
  settings(): Settings
  emit(e: SessionEvent): void
  cwd: string
  claudePath?: string
  pool: PoolEntry[]
  heart: HeartBox
  memory: Memory
  permit: CanUseTool
  /** Writes the exchange into the work transcript (shared history). */
  persist(you: string, her: string): void
  sid(): string | undefined
  /** After each reply: when she's been quiet this long, she reflects (learn.ts). */
  idle(): void
}

export class CasualEngine {
  private o: EngineOptions
  private abort?: AbortController
  private queue: { text: string; images: Image[]; mood?: Closeness }[] = []
  private lastUserAt?: number
  private toolSeq = 0
  readonly usage: Usage = { input: 0, cached: 0, output: 0, calls: 0 }

  constructor(o: EngineOptions) {
    this.o = o
  }

  busy() {
    return !!this.abort
  }

  say(text: string, images: Image[] = [], mood?: Closeness) {
    if (!text.trim() && !images.length) return
    if (this.abort) return void this.queue.push({ text, images, mood })
    void this.run(text, images, mood)
  }

  interrupt() {
    this.queue = []
    this.abort?.abort()
  }

  private provider(s: Settings): Provider {
    return pickProvider(s.casual, { claudePath: this.o.claudePath, you: addressOf(s), name: this.name(s) })
  }

  private name(s: Settings) {
    return s.waifu.name.trim() || defaultSettings().waifu.name
  }

  private async run(text: string, images: Image[], mood?: Closeness) {
    const s = this.o.settings()
    const abort = (this.abort = new AbortController())
    const began = Date.now()
    const level = mood?.level ?? 0
    const { heart, memory, pool, emit } = this.o
    emit({ t: 'state', state: 'running' })
    emit({ t: 'progress', outputTokens: 0, phase: 'thinking' })

    heart.arrive(level)
    emit({ t: 'face', emotion: heart.face() })

    const lastHer = [...pool].reverse().find((e) => e.who === 'char')?.text ?? ''
    const memories = memory.recall(`${text} ${lastHer.slice(0, 200)}`)
    const tools = this.tools(s)
    const system = casualSystem(s, memory.tune(), memory.notes(), tools.length > 0)
    const history = historyMessages(pool, s.casual.shareWork)
    const note = contextNote({
      now: new Date(),
      sinceLastMs: this.lastUserAt ? Date.now() - this.lastUserAt : undefined,
      level,
      change: mood?.change,
      feeling: heart.guide(),
      memories,
      work: !s.casual.shareWork && pool.some((e) => e.mode === 'work') ? 'you two did some work together earlier in this session.' : undefined,
      restAfterMs: mood?.restAfterMs,
    })
    const latest = { role: 'user' as const, content: note + text, images }
    const messages = history.at(-1)?.role === 'user' ? [...history.slice(0, -1), { ...latest, content: `${history.at(-1)!.content}\n${latest.content}` }] : [...history, latest]

    let raw = ''
    let felt = false
    const tags = new TagParser(
      (delta) => emit({ t: 'text', delta }),
      (emotion) => emit({ t: 'face', emotion }),
      (tag) => {
        if (felt) return
        felt = true
        emit({ t: 'affection', delta: AFFECTION_TAGS[tag] })
      },
      (line) => emit({ t: 'voice', text: line }),
    )
    const feel = new FeelParser((d) => {
      raw += d
      tags.feed(d)
    })
    let streamed = 0
    const onText = (d: string) => {
      streamed += d.length
      emit({ t: 'progress', outputTokens: Math.round(streamed / 4), phase: 'writing' })
      feel.feed(d)
    }

    let error: string | undefined
    let provider = this.provider(s)
    try {
      const req = { system, messages, tools, maxTokens: REPLY_MAX_TOKENS, signal: abort.signal, onText }
      let used: Usage
      try {
        used = await provider.chat(req)
      } catch (e) {
        // The chosen API failed before she said anything: Claude answers instead, as with no key at all.
        if (abort.signal.aborted || streamed > 0 || provider.label.startsWith('Claude') || mockCasual()) throw e
        console.warn(`[casual] ${provider.label} failed, Claude answers instead: ${e instanceof Error ? e.message : e}`)
        provider = claudeProvider(s.casual, { claudePath: this.o.claudePath, you: addressOf(s), name: this.name(s) })
        used = await provider.chat(req)
      }
      for (const k of ['input', 'cached', 'output', 'calls'] as const) this.usage[k] += used[k]
      console.log(`[casual] ${provider.label}: in ${used.input} (cached ${used.cached}), out ${used.output}, ${used.calls} call(s); session ${this.usage.input}/${this.usage.cached}/${this.usage.output}; felt ${feel.appraisal ? JSON.stringify(feel.appraisal) : 'nothing'}`)
    } catch (e) {
      if (!abort.signal.aborted) error = e instanceof Error ? e.message : String(e)
    }
    feel.flush()
    tags.flush()
    emit({ t: 'text_end' })
    const interrupted = abort.signal.aborted
    if (error) emit({ t: 'error', kind: 'api', message: `She couldn't answer in casual mode: ${error}` })
    emit({ t: 'turn_end', ok: !error, interrupted, seconds: Math.round((Date.now() - began) / 1000) })
    emit({ t: 'state', state: 'idle' })
    this.abort = undefined

    const her = raw.trim()
    if (her || !error) {
      const now = Date.now()
      const shown = stripForPool(her)
      pool.push({ mode: 'casual', who: 'user', text, at: now })
      if (shown) pool.push({ mode: 'casual', who: 'char', text: shown, at: now })
      this.o.persist(text, her)
      void memory.journal({ at: now, sid: this.o.sid(), you: text, her: shown }).catch((e) => console.warn(`[casual] journal: ${e}`))
      this.lastUserAt = now
    }
    const a = feel.appraisal
    if (a) {
      heart.feel(a.feel, a.confidence, level)
      if (a.work && !interrupted) emit({ t: 'offer_mode', mode: 'work', text })
    }
    this.o.idle()
    const next = this.queue.shift()
    if (next) void this.run(next.text, next.images, next.mood)
  }

  // ---------------------------------------------------------------- her tools

  private tools(s: Settings): ToolSpec[] {
    const memory = this.o.memory
    return [
      {
        name: 'use_tools',
        description: 'Your toolkit (Claude Code with the user\'s tools and connected apps): web search, reading pages, Slack and other connected services, files. Returns a short factual report.',
        params: { request: 'Exactly what to find out or do, with any names, links or details needed.' },
        run: (args, signal) => this.toolkit(s, args.request ?? '', signal),
      },
      {
        name: 'remember',
        description: 'Save a fact about the user for later (one short sentence, in third person).',
        params: { fact: 'The fact, e.g. "Their sister Mia visits in December."' },
        run: async (args) => ((await memory.addFacts([args.fact ?? ''])) ? 'Saved.' : 'You already knew that.'),
      },
      {
        name: 'recall',
        description: 'Look up your older memories about the user or past chats.',
        params: { query: 'Words to look for.' },
        run: async (args) => memory.recall(args.query ?? '', 1500, 8, 4).join('\n') || 'Nothing comes to mind.',
      },
      {
        name: 'search_history',
        description: SEARCH_HISTORY_DESCRIPTION,
        params: { query: 'Words to look for: names, topics, phrases.' },
        run: (args) => searchHistory(this.o.sid(), this.o.cwd, args.query ?? '', { you: addressOf(s), name: this.name(s) }),
      },
    ]
  }

  /** A one-off Claude Code run with the user's own settings, tools and MCP servers, answering in plain words. */
  private async toolkit(s: Settings, request: string, signal: AbortSignal): Promise<string> {
    const id = `casual-${++this.toolSeq}`
    const { emit, cwd } = this.o
    emit({ t: 'tool', id, name: 'Toolkit', detail: clip(request, 200), input: '', sub: false })
    if (mockCasual()) {
      emit({ t: 'tool_done', id, ok: true, output: 'mock' })
      return `(mock toolkit) Done: ${request}`
    }
    const abort = new AbortController()
    const stop = () => abort.abort()
    signal.addEventListener('abort', stop, { once: true })
    const calls = new Map<string, string>()
    let report = ''
    let ok = true
    const q = query({
      prompt: request,
      options: {
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: `\nYou are a background helper for a casual chat: someone asked for the request below. Look it up with your tools and change nothing (no edits, no commits, no messages sent), then reply with a short plain report (facts, names, numbers, links), under 200 words, no persona.`,
        },
        settingSources: s.claude.settingSources,
        cwd,
        model: s.casual.toolModel.trim() || 'haiku',
        maxTurns: TOOLKIT_MAX_TURNS,
        disallowedTools: TOOLKIT_NO_EDITS,
        allowedTools: TOOLKIT_READ_ONLY,
        persistSession: false,
        canUseTool: this.o.permit,
        abortController: abort,
        pathToClaudeCodeExecutable: this.o.claudePath,
        env: childEnv(),
      },
    })
    try {
      for await (const m of q) {
        if (m.type === 'assistant') {
          for (const b of m.message.content) {
            if (b.type !== 'tool_use') continue
            const sub = `${id}-${b.id}`
            calls.set(b.id, sub)
            const input = (b.input ?? {}) as Record<string, unknown>
            emit({ t: 'tool', id: sub, name: toolLabel(b.name), detail: describeTool(b.name, input, cwd), input: '', sub: true })
          }
        } else if (m.type === 'user' && Array.isArray(m.message.content)) {
          for (const b of m.message.content) {
            if (b.type !== 'tool_result' || !calls.has(b.tool_use_id)) continue
            emit({ t: 'tool_done', id: calls.get(b.tool_use_id)!, ok: !b.is_error, output: clip(toolOutput(b.content), 2000) })
          }
        } else if (m.type === 'result') {
          report = m.subtype === 'success' ? m.result : `The toolkit stopped early (${m.subtype}).`
          ok = m.subtype === 'success' && !m.is_error
        }
      }
    } catch (e) {
      ok = false
      report = `The toolkit failed: ${e instanceof Error ? e.message : e}`
    } finally {
      signal.removeEventListener('abort', stop)
      q.close()
    }
    emit({ t: 'tool_done', id, ok, output: clip(report, 2000) })
    return clip(report || 'The toolkit found nothing.', TOOLKIT_REPORT_MAX)
  }
}

/** Her line as the backlog keeps it: no tags, no voice lines. */
export function stripForPool(text: string) {
  let out = ''
  const p = new TagParser((d) => (out += d), () => {}, () => {}, () => {}, () => {})
  p.feed(text)
  p.flush()
  return out.trim()
}

