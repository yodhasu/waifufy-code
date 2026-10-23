import type { Emotion, MotionSettings } from '../../../link/src/protocol.ts'
import type { Gesture } from '../contracts'
import {
  EMOTES, GESTURES, IDLE_HOLDS, IDLE_SMILE, LOOK_AROUND, PRIORITY, WORK_POSES, type Mark, type Pose, type Step, type Tier,
} from './motions.ts'

// What she does and when: emotion enters and holds, one-shot gestures with the overlay's priority, dedupe and
// queue, reactions to taps and pats, the working pose while busy, and idle life. It drives an Actor, which is
// either the Live2D model or the placeholder sprite, so both behave the same way.

/** Points in the character box's own pixels (the 864×900 box, before placement transforms). */
export type Geometry = {
  /** Where she looks from; also the center of the headpat zone, `r` its radius. */
  head: { x: number; y: number; r: number }
  face: { x: number; y: number; r: number }
  body: { x: number; y: number; rx: number; ry: number }
}

export type Actor = {
  readonly kind: 'live2d' | 'placeholder'
  /**
   * Starts a pose: holds loop, one-shots play once. Resolves with the one-shot's length in ms (0 for a hold),
   * or -1 when the costume has none of the candidates.
   */
  pose(p: Pose): Promise<number>
  /** A stable key for what a pose resolves to, to tell whether two poses look the same; undefined if none. */
  resolve(p: Pose): string | undefined
  /** Plays a one-shot layered over the current pose (head turns). Resolves with its length in ms, or -1. */
  addon(candidates: string[]): Promise<number>
  setBlush(on: boolean): void
  setTalking(on: boolean): void
  /** Turns her toward a point: x right, y up, each in [-1, 1]. */
  focus(x: number, y: number): void
  geometry(): Geometry
  setZoom(zoom: number): void
  destroy(): void
}

export type DirectorHost = {
  motion(): MotionSettings
  /** The emotion she shows changed (data-emotion). */
  onEmotion(e: Emotion): void
  /** A gesture or reaction started (data-gesture). */
  onGesture(name: string): void
  fx(mark: Mark): void
}

export type Director = ReturnType<typeof createDirector>

/** An emotion's enter gesture can be cut short by anything; idle variations by anything at all. */
const ENTER_PRIORITY = -1
const IDLE_PRIORITY = -2
const DEDUPE_MS = 2000
const MAX_QUEUE = 3
const IDLE_MS: [number, number] = [8000, 20000]
/** How long after her last line (or emotion) she settles into the working pose while busy. */
const WORK_SETTLE_MS = 2500
/** When busy starts, she turns to her work a moment later rather than snapping. */
const WORK_START_MS = 600
const WORK_SWITCH_MS: [number, number] = [12000, 25000]
/** Emotions calm enough for her resting idle variations. */
const RESTING: Emotion[] = ['normal', 'smile']

const rand = ([lo, hi]: [number, number]) => lo + Math.random() * (hi - lo)
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)]!

export function createDirector(host: DirectorHost) {
  let actor: Actor | undefined
  let emotion: Emotion = 'normal'
  /** nod / sigh while it plays; they return to `emotion` afterwards. */
  let transient: Emotion | undefined
  let talking = false
  let busy = false
  /** Busy and settled between lines: the working pose shows. */
  let working = false
  let workIndex = 0
  let playing: { kind: string; priority: number } | undefined
  /** Bumped by every new sequence, so a pending step of an older one never fires. */
  let gen = 0
  const queue: Gesture[] = []
  const lastPlayed = new Map<Gesture, number>()
  let idleTimer: number | undefined
  let settleTimer: number | undefined
  let switchTimer: number | undefined

  const lipSync = () => talking && host.motion().lipSync

  function holdPose(): Pose {
    if (working) return WORK_POSES[workIndex % WORK_POSES.length]!
    return EMOTES[emotion].hold ?? EMOTES.normal.hold!
  }

  function applyHold() {
    if (!actor) return
    const p = holdPose()
    actor.setBlush(!!p.blush)
    void actor.pose(p)
  }

  /** Stops whatever sequence is pending and returns to the hold. */
  function settle() {
    gen++
    playing = undefined
    if (transient) (transient = undefined), host.onEmotion(emotion)
    applyHold()
  }

  async function run(kind: string, priority: number, steps: Step[]) {
    const my = ++gen
    playing = { kind, priority }
    for (const step of steps) {
      if (!actor) break
      actor.setBlush(!!step.blush)
      const ms = await actor.pose(step)
      if (my !== gen) return
      if (ms < 0) continue
      if (step.fx) host.fx(step.fx)
      await sleep(step.ms ?? ms)
      if (my !== gen) return
    }
    playing = undefined
    if (transient) (transient = undefined), host.onEmotion(emotion)
    const next = queue.shift()
    next ? play(next) : applyHold()
  }

  function play(g: Gesture) {
    lastPlayed.set(g, Date.now())
    host.onGesture(g)
    void run(g, PRIORITY[g], GESTURES[g])
  }

  // ---------------------------------------------------------------- working pose (R35)

  function scheduleWork(delay: number) {
    clearTimeout(settleTimer)
    settleTimer = window.setTimeout(() => {
      if (!busy || talking || working) return
      working = true
      if (!playing || playing.priority < 0) settle()
      scheduleSwitch()
    }, delay)
  }

  function scheduleSwitch() {
    clearTimeout(switchTimer)
    switchTimer = window.setTimeout(() => {
      if (!busy || !working) return
      workIndex++
      if (!playing) applyHold()
      scheduleSwitch()
    }, rand(WORK_SWITCH_MS))
  }

  function stopWorking() {
    clearTimeout(settleTimer)
    clearTimeout(switchTimer)
    if (!working) return false
    working = false
    return true
  }

  // ---------------------------------------------------------------- idle life (R31)

  function scheduleIdle() {
    clearTimeout(idleTimer)
    idleTimer = window.setTimeout(idleTick, rand(IDLE_MS))
  }

  function idleTick() {
    scheduleIdle()
    if (!actor || !host.motion().idle || talking || busy || playing) return
    const a = actor
    const moves: (() => void)[] = [() => void a.addon(pick(LOOK_AROUND))]
    if (RESTING.includes(emotion)) {
      moves.push(() => void run('idle', IDLE_PRIORITY, IDLE_SMILE))
      // Only the variations this costume has, and that differ from what she already holds.
      const current = a.resolve(holdPose())
      for (const v of IDLE_HOLDS) {
        const key = a.resolve(v.pose)
        if (key !== undefined && key !== current) moves.push(() => void run('idle', IDLE_PRIORITY, [{ ...v.pose, ms: rand(v.ms) }]))
      }
    }
    pick(moves)()
  }
  scheduleIdle()

  return {
    /** Swaps the actor (a new costume, or the placeholder) and puts it in the current state at once. */
    setActor(a: Actor | undefined) {
      actor = a
      if (!a) return
      a.setTalking(lipSync())
      queue.length = 0
      settle()
    },

    emote(e: Emotion) {
      const em = EMOTES[e]
      if (!em) return
      // Before a model or the placeholder is up, remember it; setActor applies it.
      if (!actor) return void (em.hold && ((emotion = e), host.onEmotion(e)))
      if (busy) (stopWorking(), scheduleWork(WORK_SETTLE_MS))
      if (!em.hold) {
        // A one-shot emotion (nod, sigh) plays again every time, but never over a reaction.
        if (playing && playing.priority >= 0) return
        transient = e
        host.onEmotion(e)
        return void run('enter', ENTER_PRIORITY, em.enter)
      }
      const changed = e !== emotion || transient !== undefined
      emotion = e
      transient = undefined
      host.onEmotion(e)
      // A reaction finishes first and then returns to the new hold.
      if (playing && playing.priority >= 0) return
      if (!changed && playing) return
      if (!em.enter.length || !changed) return settle()
      void run('enter', ENTER_PRIORITY, em.enter)
    },

    gesture(g: Gesture) {
      if (!actor || !host.motion().gestures || !GESTURES[g]) return
      if (Date.now() - (lastPlayed.get(g) ?? 0) < DEDUPE_MS) return
      // A destructive command usually asks for permission next; her warning already covers that.
      if (g === 'confirm' && playing?.kind === 'danger') return
      if (!playing || playing.priority < 0 || PRIORITY[g] > playing.priority) return play(g)
      if (!queue.includes(g) && queue.length < MAX_QUEUE) queue.push(g)
    },

    /** A tap or headpat tier. Plays unless a gesture outranks it; a newer tap replaces an older one. */
    react(kind: 'tap' | 'pat', tier: Tier) {
      if (!actor) return false
      if (playing && playing.priority > PRIORITY[kind]) return false
      queue.length = 0
      host.onGesture(tier.name)
      void run(kind, PRIORITY[kind], tier.steps)
      return true
    },

    /** True while a gesture or reaction (not an emotion's enter or an idle variation) is playing. */
    reacting: () => playing !== undefined && playing.priority >= 0,

    setTalking(on: boolean) {
      if (on === talking) return
      talking = on
      actor?.setTalking(lipSync())
      if (on) {
        if (stopWorking() && (!playing || playing.priority < 0)) settle()
        else if (playing?.priority === IDLE_PRIORITY) settle()
      } else if (busy) {
        scheduleWork(WORK_SETTLE_MS)
      }
    },

    /** Re-applies settings that change how the actor is driven (lip sync on/off). */
    refresh() {
      actor?.setTalking(lipSync())
    },

    busy: () => busy,

    setBusy(on: boolean) {
      if (on === busy) return
      busy = on
      if (on) {
        workIndex = 0
        if (playing?.priority === IDLE_PRIORITY) settle()
        if (!talking) scheduleWork(WORK_START_MS)
      } else if (stopWorking() && !playing) {
        applyHold()
      }
    },
  }
}
