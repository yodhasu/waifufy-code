// Her own turns (v0.7.2): in casual mode she picks, from her traits and how she feels, when she might say something
// on her own, then decides as herself whether to speak, look something up first, or stay quiet. She holds off while
// you type, treats a draft left for TYPING_AWAY_MS (or a personality-dependent silence) as you being away, and lets
// her personality and your Boundaries decide what she does about it. MAX_PER_HOUR only stops a runaway loop.

import type { Traits } from './heart.ts'

/** Typing this long without sending: they've gone away and left a draft. */
export const TYPING_AWAY_MS = 20 * 60_000
/** While they type, her moment is checked again this often. */
const HOLD_CHECK_MS = 15_000
/** When typing stops without a message: a natural pause before she goes on. */
const AFTER_TYPING_MS = [3_000, 8_000] as const
/** Not a personality cap: a broken loop can't go past this. */
export const MAX_PER_HOUR = 30
const MIN_DELAY_MS = 60_000
const MAX_DELAY_MS = 6 * 3_600_000

export type Clock = { now(): number; set(fn: () => void, ms: number): unknown; clear(h: unknown): void }
const realClock: Clock = {
  now: () => Date.now(),
  set: (fn, ms) => {
    const h = setTimeout(fn, ms)
    h.unref?.()
    return h
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

/** What the moment looks like when it comes: written into her note. */
export type Moment = { sinceLastMs?: number; away: boolean; unanswered: number }
export type Spoke = 'said' | 'quiet' | 'dropped'

/**
 * How long until she might speak. Feelings are [joy, sadness, anger, surprise, fear]; level is affection (0 – 5).
 * Sooner when she's clingy, close to them or missing them; later when she's annoyed or hides what she feels; and
 * each unanswered message stretches the next gap, hardly at all for a clingy heart and a lot for a calm one.
 */
export function nextDelayMs(t: Traits, feelings: number[], level: number, unanswered: number, rnd: () => number = Math.random): number {
  const base = 90 * Math.pow(1 - t.clingy, 1.5) + 3
  const close = Math.min(1.3, Math.max(0.6, 1.3 - 0.12 * level))
  const missing = 1 - 0.4 * Math.max(0, Math.min(1, feelings[1] ?? 0))
  const annoyed = 1 + Math.max(0, Math.min(1, feelings[2] ?? 0))
  const proud = 1 + 0.5 * t.mask
  const backOff = 1 + unanswered * (1 - t.clingy) * 1.5
  const spread = 0.6 + 0.8 * rnd()
  const ms = base * close * missing * annoyed * proud * backOff * spread * 60_000
  return Math.round(Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, ms)))
}

/** A silence this long (no message, no typing) means they're away: a clingy heart notices sooner. */
export function awayAfterMs(t: Traits): number {
  return Math.round((45 - 35 * t.clingy) * 60_000)
}

export type InitiativeOptions = {
  traits(): Traits
  feelings(): number[]
  level(): number
  /** Casual mode, the setting on, no work running, the session open. */
  allowed(): boolean
  /** When the earliest client still typing started, or undefined when nobody types. */
  typingSince(): number | undefined
  /** Their last message, or undefined before the first. */
  lastHeardAt(): number | undefined
  speak(m: Moment): Promise<Spoke>
  clock?: Clock
  rnd?: () => number
  /** Tests run her clock faster (WC_INITIATIVE_SCALE). */
  scale?: number
}

export class Initiative {
  private o: InitiativeOptions
  private clock: Clock
  private timer?: unknown
  private unanswered = 0
  private spoken: number[] = []
  private speaking = false
  /** Her moment came while they typed: she waits for them. */
  private holding = false

  constructor(o: InitiativeOptions) {
    this.o = o
    this.clock = o.clock ?? realClock
  }

  /** After an exchange (or her own message): picks the next moment. */
  arm() {
    const ms = nextDelayMs(this.o.traits(), this.o.feelings(), this.o.level(), this.unanswered, this.o.rnd)
    this.at(ms)
  }

  /** They wrote: nothing she sent is unanswered any more. The moment is picked again after her reply. */
  heard() {
    this.unanswered = 0
    this.stop()
  }

  /** Typing stopped without a message: if she was holding, she goes on after a short pause. */
  typingStopped() {
    if (!this.holding) return
    const [lo, hi] = AFTER_TYPING_MS
    this.at(lo + (hi - lo) * (this.o.rnd ?? Math.random)())
  }

  stop() {
    if (this.timer !== undefined) this.clock.clear(this.timer)
    this.timer = undefined
    this.holding = false
  }

  get pending() {
    return this.timer !== undefined
  }

  private at(ms: number) {
    this.stop()
    this.timer = this.clock.set(() => void this.fire(), Math.max(1, ms * (this.o.scale ?? 1)))
  }

  private async fire() {
    this.timer = undefined
    this.holding = false
    if (this.speaking || !this.o.allowed()) return
    const now = this.clock.now()
    const since = this.o.typingSince()
    const typedAway = since !== undefined && now - since >= TYPING_AWAY_MS
    if (since !== undefined && !typedAway) {
      this.holding = true
      this.timer = this.clock.set(() => void this.fire(), HOLD_CHECK_MS * (this.o.scale ?? 1))
      return
    }
    this.spoken = this.spoken.filter((t) => now - t < 3_600_000)
    if (this.spoken.length >= MAX_PER_HOUR) return this.at(this.spoken[0] + 3_600_000 - now)
    const heard = this.o.lastHeardAt()
    const sinceLastMs = heard === undefined ? undefined : now - heard
    const away = typedAway || (sinceLastMs !== undefined && sinceLastMs >= awayAfterMs(this.o.traits()))
    this.speaking = true
    let r: Spoke = 'dropped'
    try {
      this.spoken.push(now)
      r = await this.o.speak({ sinceLastMs, away, unanswered: this.unanswered })
    } catch (e) {
      console.warn(`[initiative] ${e instanceof Error ? e.message : e}`)
    } finally {
      this.speaking = false
    }
    if (r === 'said') this.unanswered++
    // Quiet or dropped: she thinks about it again later. Said: the next gap stretches with what's unanswered.
    // (This replaces the moment her reply's idle() picked before `unanswered` counted it.)
    if (this.o.allowed()) this.arm()
  }
}
