// Her emotions (v0.7): five intensities that events push and time pulls back to a resting baseline, a mood
// worked out from them in code, and affection deciding how hard things land. The model only appraises what a
// message meant to her (the <feel> line); it never sets how she feels. Nothing here is shown: the mood leaks
// out through her tone (a note to the model), her resting face and her voice speed.

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AFFECTION_LEVELS } from '../affection.ts'
import type { Emotion } from '../protocol.ts'
import { DATA_DIR } from '../settings.ts'

/** joy, sadness, anger, surprise, fear: each 0 – 1, independent (they don't sum to anything). */
export type Feelings = [number, number, number, number, number]
export const FEELINGS = ['joy', 'sadness', 'anger', 'surprise', 'fear'] as const
const [JOY, SAD, ANGER, SURPRISE, FEAR] = [0, 1, 2, 3, 4]

/** How a personality feels: where she rests, how hard each emotion lands, how long it lasts. */
export type Traits = {
  baseline: Feelings
  sensitivity: Feelings
  /** Minutes for an emotion to fall halfway back to baseline. */
  halfLifeMin: Feelings
  /** 0 – 1: how much she resists change. */
  inertia: number
  /** 0 – 1: how much she hides what she feels (a tsundere's front). */
  mask: number
  /** 0 – 1: how much she misses them while they're away. */
  clingy: number
}

const T = (baseline: Feelings, sensitivity: Feelings, halfLifeMin: Feelings, inertia: number, mask: number, clingy: number): Traits => ({
  baseline, sensitivity, halfLifeMin, inertia, mask, clingy,
})
const LIVES: Feelings = [90, 120, 60, 8, 45]

/** By the app's personality presets (app/src/screens/personas.ts); 'custom' and unknown ids rest like 'devoted'. */
const TRAITS: Record<string, Traits> = {
  devoted: T([0.35, 0.05, 0.02, 0.05, 0.05], [1.1, 1.1, 0.6, 1, 1], LIVES, 0.3, 0.1, 0.6),
  tsundere: T([0.25, 0.05, 0.12, 0.05, 0.05], [1, 0.9, 1.4, 1.1, 0.8], [90, 120, 120, 8, 40], 0.35, 0.75, 0.4),
  kuudere: T([0.2, 0.05, 0.03, 0.02, 0.03], [0.7, 0.8, 0.7, 0.6, 0.7], [120, 150, 90, 6, 45], 0.65, 0.6, 0.3),
  dandere: T([0.2, 0.08, 0.02, 0.08, 0.15], [1.1, 1, 0.6, 1.2, 1.4], [90, 120, 60, 10, 60], 0.4, 0.5, 0.5),
  genki: T([0.5, 0.03, 0.03, 0.1, 0.03], [1.3, 0.9, 0.8, 1.3, 0.8], [75, 60, 40, 8, 30], 0.15, 0.05, 0.5),
  oneesan: T([0.35, 0.03, 0.02, 0.03, 0.02], [1, 0.8, 0.6, 0.7, 0.6], [90, 90, 60, 6, 30], 0.5, 0.25, 0.3),
  'yandere-lite': T([0.35, 0.08, 0.05, 0.05, 0.12], [1.2, 1.4, 1.1, 1, 1.3], [90, 180, 90, 8, 90], 0.3, 0.3, 0.95),
  ojousama: T([0.3, 0.03, 0.08, 0.05, 0.03], [1, 0.9, 1.2, 0.9, 0.7], [90, 90, 90, 8, 40], 0.4, 0.55, 0.4),
  chuunibyou: T([0.4, 0.05, 0.05, 0.12, 0.05], [1.2, 1, 1, 1.3, 0.9], [75, 90, 60, 10, 40], 0.25, 0.35, 0.4),
  deadpan: T([0.2, 0.03, 0.03, 0.02, 0.02], [0.6, 0.7, 0.7, 0.5, 0.6], [120, 120, 90, 5, 40], 0.7, 0.8, 0.2),
  sensei: T([0.3, 0.03, 0.03, 0.03, 0.03], [0.9, 0.8, 0.7, 0.8, 0.6], [90, 90, 60, 6, 30], 0.55, 0.2, 0.3),
}

export const traitsFor = (preset: string): Traits => TRAITS[preset] ?? TRAITS.devoted

export type Heart = { feelings: Feelings; at: number; lastSeen: number }

export type Mood = 'calm' | 'content' | 'cheerful' | 'excited' | 'wistful' | 'down' | 'distressed' | 'anxious' | 'sulky' | 'irritated' | 'resentful'

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : 0))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const closeness = (level: number) => clamp(level / AFFECTION_LEVELS)

/** Her baseline at this affection: closer means happier at rest and a little less touchy. */
function baseline(t: Traits, level: number): Feelings {
  const c = closeness(level)
  const b = [...t.baseline] as Feelings
  b[JOY] = clamp(b[JOY] + 0.15 * c)
  b[ANGER] = clamp(b[ANGER] * lerp(1.3, 0.7, c))
  return b
}

/** Lets time pass: every emotion falls back towards baseline, negative ones faster when she's close to them. */
export function settle(h: Heart, t: Traits, level: number, now = Date.now()): Heart {
  const minutes = Math.max(0, (now - h.at) / 60_000)
  if (!minutes) return h
  const base = baseline(t, level)
  const c = closeness(level)
  const feelings = h.feelings.map((v, i) => {
    const negative = i === SAD || i === ANGER || i === FEAR
    const life = t.halfLifeMin[i] * (negative ? lerp(1.5, 0.6, c) : 1)
    return base[i] + (v - base[i]) * 0.5 ** (minutes / life)
  }) as Feelings
  return { ...h, feelings, at: now }
}

/**
 * One event: `stimulus` is the model's appraisal (-1 – 1 per emotion), scaled by how sure it was, her
 * sensitivities, her inertia and affection. Low affection makes unkindness land harder and kindness softer.
 * Pushes saturate (an emotion near 1 barely moves up), so one message can't swing her to an extreme.
 */
export function feel(h: Heart, t: Traits, stimulus: number[], confidence: number, level: number, now = Date.now()): Heart {
  const settled = settle(h, t, level, now)
  const c = closeness(level)
  const conf = clamp(confidence)
  const feelings = settled.feelings.map((v, i) => {
    let s = clamp(stimulus[i] ?? 0, -1, 1) * conf * t.sensitivity[i] * (1 - t.inertia * 0.5)
    if (s > 0 && (i === SAD || i === ANGER || i === FEAR)) s *= lerp(1.4, 0.6, c)
    if (s > 0 && i === JOY) s *= lerp(0.8, 1.2, c)
    return clamp(v + (s > 0 ? s * (1 - v) : s * v))
  }) as Feelings
  return { ...settled, feelings, at: now }
}

/** Coming back after a while: a clingy heart is a little sad and glad at once; a cool one barely notices. */
export function reunion(h: Heart, t: Traits, level: number, now = Date.now()): Heart {
  const hours = (now - h.lastSeen) / 3_600_000
  if (!h.lastSeen || hours < 6) return { ...h, lastSeen: now }
  const away = clamp(hours / 72)
  const c = closeness(level)
  return { ...feel(h, t, [0.3 + 0.4 * c, t.clingy * away * 0.6, 0, 0.3, 0], 1, level, now), lastSeen: now }
}

/** The mood her feelings add up to, checked from the strongest states down. */
export function moodOf(f: Feelings): Mood {
  const [j, s, a, u, fe] = f
  if (a > 0.55 && s > 0.35) return 'resentful'
  if (a > 0.5) return 'irritated'
  if (s > 0.5 && fe > 0.4) return 'distressed'
  if (s > 0.5) return 'down'
  if (fe > 0.5) return 'anxious'
  if (j > 0.6 && u > 0.35) return 'excited'
  if (j > 0.6) return 'cheerful'
  if (a > 0.3) return 'sulky'
  if (s > 0.3 && j < 0.35) return 'wistful'
  if (j > 0.4) return 'content'
  return 'calm'
}

const NEGATIVE = new Set<Mood>(['wistful', 'down', 'distressed', 'anxious', 'sulky', 'irritated', 'resentful'])

const GUIDE: Record<Mood, string> = {
  calm: 'Even and relaxed.',
  content: 'Quietly happy and at ease: warm, unhurried.',
  cheerful: 'In a good mood: bright, playful, quick to smile and joke.',
  excited: 'Excited and a bit restless: lively, eager, exclamations come easily.',
  wistful: 'A little low and thoughtful: softer, quieter, easily touched by kindness.',
  down: 'Feeling down: shorter, quieter replies, less playful; kindness lifts you, coldness hurts more.',
  distressed: 'Upset and unsettled: you want reassurance, you take things to heart, and you may say so.',
  anxious: 'Uneasy: you hesitate, double-check, and read neutral words as maybe bad.',
  sulky: 'A bit sulky: curt, a pout in your words; you warm up again if they make it right.',
  irritated: 'Irritated: short, blunt, little patience for teasing; you might snap a little.',
  resentful: 'Hurt and annoyed: cool and distant, you hold a grudge until they make amends.',
}

/** The hidden note for the model: tone only. `work`: a shorter version that never touches the work itself. */
export function moodGuide(h: Heart, t: Traits, work = false): string {
  const mood = moodOf(h.feelings)
  const hidden = t.mask > 0.5
    ? NEGATIVE.has(mood)
      ? ' You hide it behind your usual front, but it leaks through small things.'
      : mood === 'calm' ? '' : ' You would never admit it openly; it shows in small slips.'
    : ''
  if (work) return mood === 'calm' || mood === 'content' ? '' : `Your mood: ${mood}. ${GUIDE[mood]}${hidden} It colors only your tone; the work stays exactly as careful and complete.`
  return `${GUIDE[mood]}${hidden}`
}

/** The face she rests on in this mood, before any tag in the reply. A masked heart shows less. */
export function restingFace(h: Heart, t: Traits): Emotion {
  const mood = moodOf(h.feelings)
  if (t.mask > 0.6) return NEGATIVE.has(mood) ? (mood === 'down' || mood === 'distressed' ? 'sigh' : 'pout') : mood === 'calm' ? 'normal' : 'shy'
  const faces: Record<Mood, Emotion> = {
    calm: 'normal', content: 'smile', cheerful: 'happy', excited: 'delighted', wistful: 'sigh', down: 'sad',
    distressed: 'teary', anxious: 'worried', sulky: 'pout', irritated: 'pout', resentful: 'angry',
  }
  return faces[mood]
}

/** Her voice runs a little slower when she's low, a little quicker when she's up. */
export function voiceSpeed(h: Heart): number {
  const mood = moodOf(h.feelings)
  if (mood === 'down' || mood === 'distressed' || mood === 'wistful') return 0.94
  if (mood === 'excited' || mood === 'cheerful') return 1.05
  if (mood === 'irritated') return 1.03
  return 1
}

// ---------------------------------------------------------------- persistence (one heart per character)

const DIR = join(DATA_DIR, 'heart')
const fileOf = (slug: string) => join(DIR, `${slug || 'character'}.json`)

export function loadHeart(slug: string, t: Traits): Heart {
  try {
    if (existsSync(fileOf(slug))) {
      const j = JSON.parse(readFileSync(fileOf(slug), 'utf8')) as Partial<Heart>
      if (Array.isArray(j.feelings) && j.feelings.length === 5 && typeof j.at === 'number') {
        return { feelings: j.feelings.map((v) => clamp(Number(v))) as Feelings, at: j.at, lastSeen: Number(j.lastSeen) || j.at }
      }
    }
  } catch (e) {
    console.warn(`[heart] ${slug}: ${e instanceof Error ? e.message : e}`)
  }
  return { feelings: [...t.baseline] as Feelings, at: Date.now(), lastSeen: 0 }
}

let writes: Promise<unknown> = Promise.resolve()

/** Saves run one after another: two quick changes never race on the same file. */
export function saveHeart(slug: string, h: Heart) {
  const run = writes.then(async () => {
    await mkdir(DIR, { recursive: true })
    const tmp = `${fileOf(slug)}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(h))
    await rename(tmp, fileOf(slug))
  })
  writes = run.catch(() => {})
  return run
}
