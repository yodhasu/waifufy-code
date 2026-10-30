// Work and casual mode on one session (v0.7). The work session (Claude Code, or the E2E mock) runs as always;
// this wrapper sits in front of it, keeps the history both modes share, routes messages to the casual engine
// while in casual mode, and refuses to switch, in character, while work is still running.

import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import { AFFECTION_TAGS, type Mood as Closeness } from '../affection.ts'
import type { ChatMode, CtlOp, Image, PermissionModeName, SessionEvent, Settings } from '../protocol.ts'
import { slugify } from '../research.ts'
import { loadContext } from '../saves.ts'
import type { SessionApi, SessionFactory, SessionOptions } from '../session-api.ts'
import { addressOf, defaultSettings } from '../settings.ts'
import { voiceActive } from '../tts.ts'
import { casualBlock } from './block.ts'
import { CasualEngine } from './engine.ts'
import { mockCasual } from './providers.ts'
import { feel, loadHeart, moodGuide, restingFace, reunion, saveHeart, settle, traitsFor, voiceSpeed, type Heart, type Traits } from './heart.ts'
import { Initiative } from './initiative.ts'
import { scheduleLearning } from './learn.ts'
import { openMemory, type Memory } from './memory.ts'
import type { PoolEntry } from './prompt.ts'

/** A character's files (heart, memory) are keyed by her name. */
/** Where her memory and mood live: the active card's id. Before cards (and the first card keeps it), the slug of her name. */
export const characterSlug = (s: Settings) => s.card || slugify(s.waifu.name.trim() || defaultSettings().waifu.name) || 'character'

/** The running session's heart, for the voice speed (server.ts). */
let active: HeartBox | undefined
export const moodVoiceSpeed = () => (active ? voiceSpeed(active.state) : 1)

/** Her emotions for one character, saved after every change. */
export class HeartBox {
  readonly traits: Traits
  state: Heart
  private slug: string

  constructor(s: Settings) {
    this.slug = characterSlug(s)
    this.traits = traitsFor(s.waifu.personalityPreset)
    this.state = loadHeart(this.slug, this.traits)
  }

  private save() {
    void saveHeart(this.slug, this.state).catch((e) => console.warn(`[heart] save: ${e}`))
  }

  /** A message from them: time has passed, and maybe they've been away. */
  arrive(level: number) {
    this.state = reunion(settle(this.state, this.traits, level), this.traits, level)
    this.save()
  }

  feel(stimulus: number[], confidence: number, level: number) {
    this.state = feel(this.state, this.traits, stimulus, confidence, level)
    this.save()
  }

  face() {
    return restingFace(this.state, this.traits)
  }

  guide(work = false) {
    return moodGuide(settle(this.state, this.traits, 0), this.traits, work)
  }
}

/** Strikes within this window count together; the third and later cost a little affection. */
const STRIKE_WINDOW_MS = 10 * 60_000
const STRIKES_BEFORE_COST = 2

type Line = { text: string; ja: string }
const BLOCKED: Line[] = [
  { text: "[worried] Ah, wait, {you}. I'm still in the middle of the work. [smile] Let me finish it first, and then we can talk properly, okay?", ja: 'あっ、待ってください。まだお仕事の途中なんです。終わったら、ゆっくりお話ししましょうね。' },
  { text: "[pout] {you}… I said I'm not done yet. Just a little longer, please.", ja: 'もう…まだ終わっていないって言いましたよ。もう少しだけ待ってください。' },
  { text: "[angry] {you}! The work isn't finished yet! [pout] Pressing that again won't make it go any faster, you know.", ja: 'もう！まだ終わってません！何度押しても、早くはなりませんよ。' },
]
const TO_CASUAL: Line = { text: "[smile] Work's all done? [happy] Then let's just talk for a while, {you}.", ja: 'お仕事、終わりましたか？じゃあ、少しお話ししましょう。' }
const TO_WORK: Line = { text: '[nod] Back to work, then. [serious] Tell me what you need, {you}.', ja: 'はい、お仕事に戻りましょう。何をすればいいですか？' }
const TO_WORK_COMPACT: Line = { text: '[nod] Back to work, then. [think] Let me tidy up my notes first… [serious] Tell me what you need, {you}.', ja: 'はい、お仕事に戻りましょう。メモを少し整理しますね。何をすればいいですか？' }

/** Fewer lines than this in context aren't worth a compaction. */
const COMPACT_MIN = 6
/** What /compact is told when work resumes after casual chat: the old lines stay searchable (search_history). */
const COMPACT_FOCUS = 'Back to work after a casual chat. Keep what matters for the work: the current task, its state, decisions and open items. Casual chat can be one line. Every earlier line stays searchable with the search_history tool.'

class ModalSession implements SessionApi {
  readonly epoch: number
  readonly cwd: string
  private opts: SessionOptions
  private inner: SessionApi
  private mode: ChatMode = 'work'
  private heart: HeartBox
  private memory: Memory
  private pool: PoolEntry[] = []
  private engine: CasualEngine
  private seeded: Promise<void>
  private compacted = false
  private workText = ''
  private workBusy = false
  private bgBusy = false
  private agents = new Map<string, boolean>()
  private strikes: number[] = []
  private closed = false
  private idleTimer?: ReturnType<typeof setTimeout>
  private initiative: Initiative
  /** Clients whose composer has a draft, and since when. */
  private typists = new Map<string, number>()

  constructor(factory: SessionFactory, opts: SessionOptions) {
    this.opts = opts
    this.epoch = opts.epoch
    this.cwd = opts.cwd
    this.heart = active = new HeartBox(opts.settings)
    this.memory = openMemory(characterSlug(opts.settings))
    this.inner = factory({ ...opts, emit: (e) => this.fromWork(e) })
    this.engine = new CasualEngine({
      settings: () => this.opts.settings,
      emit: (e) => this.opts.emit(e),
      cwd: opts.cwd,
      claudePath: opts.claudePath,
      pool: this.pool,
      heart: this.heart,
      memory: this.memory,
      permit: (name, input, o) => this.inner.permit(name, input, o),
      persist: (you, her) => this.inner.appendContext(casualBlock(you, her)),
      sid: () => this.inner.sessionId(),
      idle: () => {
        this.armLearning()
        if (this.mayInitiate()) this.initiative.arm()
      },
    })
    // A resumed save brings its context (both modes) into the pool before anything new is said.
    this.initiative = new Initiative({
      traits: () => this.heart.traits,
      feelings: () => this.heart.state.feelings,
      level: () => this.engine.level(),
      allowed: () => this.mayInitiate(),
      typingSince: () => (this.typists.size ? Math.min(...this.typists.values()) : undefined),
      lastHeardAt: () => this.engine.lastHeardAt(),
      speak: (m) => this.engine.initiate(m, () => this.typists.size > 0),
      scale: Number(process.env.WC_INITIATIVE_SCALE) || undefined,
    })
    this.seeded = opts.resume ? this.reload(opts.resume, opts.resumeAt) : Promise.resolve()
    this.armLearning(30_000)
  }

  /**
   * The pool becomes the session's context as the work session has it: the last compaction's summary and what
   * came after. Both modes run on one history; only the loop that answers differs.
   */
  private reload(id: string, upTo?: string) {
    return loadContext(id, this.cwd, upTo).then(
      (h) => {
        const at = Date.now()
        const now: PoolEntry[] = h.flatMap((x): PoolEntry[] =>
          x.who === 'tool' ? [{ mode: 'work', who: 'tool', text: `${x.name} ${x.detail}`.trim(), at }]
            : x.who === 'system' ? []
              : [{ mode: x.mode === 'casual' ? 'casual' : 'work', who: x.who, text: x.text, at }],
        )
        // Nothing read (no transcript yet, or it couldn't be read) keeps what she has rather than forgetting it all.
        if (now.length) this.pool.splice(0, this.pool.length, ...now)
      },
      () => {},
    )
  }

  /** Events of the work session: watched for what's still running and for the shared history, then passed on. */
  private fromWork(e: SessionEvent) {
    switch (e.t) {
      case 'state':
        this.workBusy = e.state !== 'idle'
        break
      case 'turn_end': {
        this.workBusy = false
        this.endWorkText()
        const id = this.compacted ? this.inner.sessionId() : undefined
        if (id) {
          this.compacted = false
          this.seeded = this.seeded.then(() => this.reload(id))
        }
        break
      }
      case 'text':
        this.workText += e.delta
        break
      case 'text_end':
        this.endWorkText()
        break
      case 'tool':
        if (!e.sub) this.pool.push({ mode: 'work', who: 'tool', text: `${e.name} ${e.detail}`.trim(), at: Date.now() })
        break
      case 'bg_tasks':
        this.bgBusy = e.tasks.some((t) => t.status === 'running' || t.status === 'pending')
        break
      case 'agent':
        if (e.status === 'running') this.agents.set(e.id, true)
        else this.agents.delete(e.id)
        break
      case 'notice':
        // The work session compacted: casual follows from the same summary once the turn is written out.
        if (e.kind === 'compact') this.compacted = true
        break
      case 'affection':
        // Praise at work warms her heart too; unkindness stings.
        this.heart.feel(e.delta > 0 ? [0.35, -0.1, -0.1, 0.05, 0] : [-0.2, 0.3, 0.35, 0.1, 0.05], 0.9, 0)
        break
    }
    this.opts.emit(e)
  }

  private endWorkText() {
    const text = this.workText.trim()
    this.workText = ''
    if (text) this.pool.push({ mode: 'work', who: 'char', text, at: Date.now() })
  }

  private busyAtWork() {
    return this.workBusy || this.bgBusy || this.agents.size > 0
  }

  /** A prebuilt line, played like one of hers: face, voice, text. No model is asked. */
  private line(l: Line) {
    const s = this.opts.settings
    // Its own event, so a line said while a work reply streams never lands in the middle of it.
    const ja = s.voice.language === 'ja' && voiceActive(s.voice)
    this.opts.emit({ t: 'aside', text: l.text.replaceAll('{you}', addressOf(s)), ...(ja ? { voice: l.ja } : {}) })
  }

  async setChatMode(mode: ChatMode, compact = false) {
    if (mode === this.mode) return this.opts.emit({ t: 'chat_mode', mode })
    if (mode === 'casual' && this.busyAtWork()) {
      const now = Date.now()
      this.strikes = [...this.strikes.filter((t) => now - t < STRIKE_WINDOW_MS), now]
      const n = this.strikes.length
      this.line(BLOCKED[Math.min(n, BLOCKED.length) - 1])
      if (n > STRIKES_BEFORE_COST) {
        this.opts.emit({ t: 'affection', delta: AFFECTION_TAGS['affection-'] })
        this.heart.feel([-0.1, 0.05, 0.3, 0, 0], 1, 0)
      }
      return this.opts.emit({ t: 'chat_mode', mode: this.mode })
    }
    if (mode === 'work' && this.engine.busy()) this.engine.interrupt()
    await this.seeded
    this.mode = mode
    this.strikes = []
    if (this.mayInitiate()) this.initiative.arm()
    else this.initiative.stop()
    this.opts.emit({ t: 'chat_mode', mode })
    // Work after a casual break is usually a new task or an update on one: it can start from a summary.
    const tidy = mode === 'work' && compact && this.pool.length >= COMPACT_MIN
    this.line(mode === 'casual' ? TO_CASUAL : tidy ? TO_WORK_COMPACT : TO_WORK)
    if (tidy) this.inner.say(`/compact ${COMPACT_FOCUS}`)
  }

  /** Her own messages: casual mode, the setting on, no work running, the session open (and in mock mode only for tests). */
  private mayInitiate() {
    if (this.closed || this.mode !== 'casual' || !this.opts.settings.casual.initiative || this.busyAtWork()) return false
    return !mockCasual() || !!process.env.WC_INITIATIVE_SCALE
  }

  /** A client's composer has a draft (on) or not (off); a closed connection is off. */
  typing(client: string, on: boolean) {
    if (on) {
      if (!this.typists.has(client)) this.typists.set(client, Date.now())
    } else if (this.typists.delete(client) && !this.typists.size) this.initiative.typingStopped()
  }

  private armLearning(ms?: number) {
    clearTimeout(this.idleTimer)
    if (this.closed) return
    const s = this.opts.settings.casual
    if (!s.learning) return
    this.idleTimer = setTimeout(() => {
      if (this.engine.busy()) return this.armLearning()
      scheduleLearning({ settings: this.opts.settings, memory: this.memory, claudePath: this.opts.claudePath, idleMs: s.idleMin * 60_000 })
    }, ms ?? Math.max(1, s.idleMin) * 60_000)
    this.idleTimer.unref?.()
  }

  // ---------------------------------------------------------------- SessionApi

  sessionId() {
    return this.inner.sessionId()
  }

  start() {
    return this.inner.start()
  }

  say(text: string, images: Image[] = [], now = false, mood?: Closeness) {
    const command = text.trim().toLowerCase()
    if (command === '/casual' || command === '/work') return void this.setChatMode(command === '/casual' ? 'casual' : 'work')
    // Slash commands stay Claude Code's in either mode (/model, /compact…).
    // After the context is (re)loaded, so a reply right after a /compact reads the summary.
    if (this.mode === 'casual' && !command.startsWith('/')) {
      this.initiative.heard()
      return void this.seeded.then(() => this.engine.say(text, images, mood))
    }
    if (text.trim() && !text.startsWith('/')) this.pool.push({ mode: 'work', who: 'user', text, at: Date.now() })
    const feelNote = this.heart.guide(true)
    this.inner.say(text, images, now, mood ? { ...mood, ...(feelNote ? { feel: feelNote } : {}) } : mood)
  }

  shell(command: string) {
    return this.inner.shell(command)
  }

  async interrupt() {
    if (this.engine.busy()) return this.engine.interrupt()
    return this.inner.interrupt()
  }

  close() {
    this.closed = true
    clearTimeout(this.idleTimer)
    this.initiative.stop()
    this.engine.interrupt()
    if (active === this.heart) active = undefined
    this.inner.close()
  }

  setMode(mode: PermissionModeName) {
    return this.inner.setMode(mode)
  }

  setModel(model: string) {
    return this.inner.setModel(model)
  }

  answerPermission(id: string, decision: 'allow' | 'always' | 'deny' | 'feedback', message?: string, option?: string) {
    this.inner.answerPermission(id, decision, message, option)
  }

  answerQuestion(id: string, answers: Record<string, string>) {
    this.inner.answerQuestion(id, answers)
  }

  control(op: CtlOp, args: unknown[]) {
    return this.inner.control(op, args)
  }

  answerElicit(id: string, action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>) {
    this.inner.answerElicit(id, action, content)
  }

  answerPlan(id: string, decision: 'auto' | 'manual' | 'keep', message?: string) {
    this.inner.answerPlan(id, decision, message)
  }

  appendContext(text: string) {
    this.inner.appendContext(text)
  }

  permit: CanUseTool = (name, input, o) => this.inner.permit(name, input, o)
}

/** The session factory with work and casual mode in front of it. */
export const withModes = (factory: SessionFactory): SessionFactory => (opts) => new ModalSession(factory, opts)
