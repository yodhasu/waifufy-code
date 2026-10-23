// Rem's motion vocabulary, written once for every costume.
//
// Each costume ships its own motion set under its own file prefix (AC_rem01_act_egao, AC_rem_xmas01_act_egao),
// and no two sets are identical: the childhood costume has 40 motions, the maid one 96. So motions are indexed
// by suffix (the part after `AC_<id>_`) and every pose lists candidate suffixes; the first one the costume has wins.
//
// What the files mean (checked against the curves of all nine costumes):
// - `act_*` motions drive the whole model: body, arms, head and face. `face_*` motions drive only the head
//   angles, face and hair, so a face layered on top of an act replaces the act's own expression.
// - `*_w` motions are holds: one constant frame (plus hair sway) meant to loop. The others are animated
//   one-shots of 0.7 to 3.5 seconds that end in their hold's frame.
// - `face_cheek_on` is the blush; it is driven as a parameter instead (see live2d.ts) so it can fade.
// - `add_select_L/R/C` only turn the head; they make a good idle look-around layered over any pose.
//
// This file is plain data plus a resolver with type-only imports, so `check-motions.mjs` can run it in Node.

import type { Emotion } from '../../../link/src/protocol.ts'
import type { Gesture } from '../contracts'

/**
 * One pose: `act` candidates for the body, and optionally `face` candidates layered over it. Without `face`
 * (or when none of them exists), the act's own face pairs with it: `act_egao` → `face_egao` when the costume
 * has it, otherwise the expression baked into the act.
 */
export type Pose = { act: string[]; face?: string[]; blush?: boolean }

/** A floating manga mark over her head, drawn by fx.ts. */
export type Mark = 'heart' | 'hearts' | 'anger' | 'surprise' | 'question' | 'sparkle' | 'sweat' | 'dots' | 'note'

/** One step of a sequence. With `ms` the pose is held that long; without it a one-shot plays to its end. */
export type Step = Pose & { ms?: number; fx?: Mark }

/** An emotion tag: an enter gesture, then a hold. Transient emotions (nod, sigh) have no hold of their own. */
export type Emote = { enter: Step[]; hold?: Pose }

export const EMOTES: Record<Emotion, Emote> = {
  normal: { enter: [], hold: { act: ['act_normal_w'] } },
  smile: {
    enter: [{ act: ['act_hohoemu', 'act_egao'] }],
    hold: { act: ['act_hohoemu_w', 'act_normal_w'], face: ['face_hohoemu_w'] },
  },
  // The poker-face costume never grins; she nods happily instead.
  happy: {
    enter: [{ act: ['act_egao', 'act_unazuku02'], fx: 'note' }],
    hold: { act: ['act_egao_w', 'act_hohoemu_w'] },
  },
  // An eager nod into her widest grin. Costumes without a second grin still nod first, then smile, so delighted
  // never looks like happy with a blush.
  delighted: {
    enter: [
      { act: ['act_unazuku02', 'act_unazuku'] },
      { act: ['act_egao02', 'act_egao03', 'act_egao', 'act_hohoemu'], blush: true, fx: 'sparkle' },
    ],
    hold: { act: ['act_egao02_w', 'act_egao03_w', 'act_egao_w', 'act_hohoemu_w'], blush: true },
  },
  nod: { enter: [{ act: ['act_unazuku', 'act_unazuku02'] }] },
  // Without a pondering pose (childhood) she fidgets with a focused face, which keeps her apart from worried.
  think: {
    enter: [{ act: ['act_kangaeru', 'act_nayamu'], face: ['face_kangaeru', 'face_shinken_w'] }],
    hold: { act: ['act_kangaeru_w', 'act_nayamu_w'], face: ['face_kangaeru_w', 'face_shinken_w'] },
  },
  worried: {
    enter: [{ act: ['act_nayamu'], face: ['face_komaru', 'face_nayamu'], fx: 'sweat' }],
    hold: { act: ['act_nayamu_w'], face: ['face_komaru_w', 'face_nayamu_w'] },
  },
  serious: {
    enter: [{ act: ['act_shinken', 'act_shinken02', 'act_unazuku'] }],
    hold: { act: ['act_shinken_w', 'act_shinken02_w', 'act_normal_w'], face: ['face_shinken_w', 'face_shinken02_w'] },
  },
  surprised: {
    enter: [{ act: ['act_bikkuri', 'act_odoroku'], fx: 'surprise' }],
    hold: { act: ['act_odoroku_w', 'act_bikkuri_w'] },
  },
  // Only the maid costume has an embarrassed face (face_tere_w). Elsewhere she smiles with troubled brows and a
  // blush, which reads as flustered and stays apart from both smile (same body, calm face) and worried.
  shy: {
    enter: [{ act: ['act_hohoemu', 'act_nayamu'], face: ['face_tere_w', 'face_nayamu'], blush: true, fx: 'heart' }],
    hold: { act: ['act_hohoemu_w'], face: ['face_tere_w', 'face_nayamu_w'], blush: true },
  },
  // Without a pouting pose (childhood) she is cross with troubled brows, which keeps her apart from angry.
  pout: {
    enter: [{ act: ['act_punpun', 'act_ikaru'], blush: true, fx: 'anger' }],
    hold: { act: ['act_punpun_w', 'act_ikaru_w'], face: ['face_punpun_w', 'face_nayamu_w'], blush: true },
  },
  sad: {
    enter: [{ act: ['act_kurushimu', 'act_nayamu', 'act_tameiki'], face: ['face_kanashimu_w', 'face_uru_w'] }],
    hold: { act: ['act_kurushimu_w', 'act_nayamu_w'], face: ['face_kanashimu_w', 'face_uru_w'] },
  },
  angry: {
    enter: [{ act: ['act_ikaru', 'act_gekido', 'act_punpun'], fx: 'anger' }],
    hold: { act: ['act_ikaru_w', 'act_gekido_w', 'act_punpun_w'] },
  },
  sigh: { enter: [{ act: ['act_tameiki', 'act_tameiki02'], fx: 'dots' }] },
  // Watery eyes come with flushed cheeks (act_uru_w itself raises the cheek).
  teary: {
    enter: [{ act: ['act_uru', 'act_tameiki02', 'act_nayamu'], face: ['face_uru', 'face_kanashimu_w'], blush: true }],
    hold: { act: ['act_uru_w', 'act_nayamu_w'], face: ['face_uru_w', 'face_kanashimu_w'], blush: true },
  },
}

/** While the agent works she alternates between these holds between lines (R35). */
export const WORK_POSES: Pose[] = [
  { act: ['act_kangaeru_w', 'act_nayamu_w'] },
  { act: ['act_shinken_w', 'act_shinken02_w', 'act_normal_w'], face: ['face_shinken_w', 'face_shinken02_w'] },
]

// ---------------------------------------------------------------- one-shot reactions

/** Higher wins: a confirmation interrupts a success, never the reverse. Taps and pats are the lowest. */
export const PRIORITY: Record<Gesture | 'pat' | 'tap', number> = {
  pat: 0, tap: 0, greet: 1, costume: 1, success: 1, push: 1, fail: 2, interrupt: 2, confirm: 3, danger: 4,
}

export const GESTURES: Record<Gesture, Step[]> = {
  // A permission prompt or question: she stops to think it over.
  confirm: [
    { act: ['act_kangaeru', 'act_nayamu'], fx: 'question' },
    { act: ['act_kangaeru_w', 'act_nayamu_w'], ms: 900 },
  ],
  // A destructive command: a start, then a serious look.
  danger: [
    { act: ['act_bikkuri', 'act_odoroku'], fx: 'surprise' },
    { act: ['act_bikkuri_w', 'act_odoroku_w'], ms: 700 },
    { act: ['act_shinken', 'act_shinken02', 'act_unazuku'], fx: 'sweat' },
    { act: ['act_shinken_w', 'act_shinken02_w', 'act_normal_w'], face: ['face_shinken_w', 'face_shinken02_w'], ms: 1200 },
  ],
  // git push went through: a firm nod, then delight.
  push: [
    { act: ['act_unazuku02', 'act_unazuku'] },
    { act: ['act_egao02', 'act_egao03', 'act_egao', 'act_hohoemu'], blush: true, fx: 'sparkle' },
    { act: ['act_egao02_w', 'act_egao03_w', 'act_egao_w', 'act_hohoemu_w'], blush: true, ms: 1000 },
  ],
  success: [
    { act: ['act_egao', 'act_unazuku02'], fx: 'sparkle' },
    { act: ['act_egao_w', 'act_hohoemu_w'], ms: 1400 },
  ],
  fail: [
    { act: ['act_kurushimu', 'act_uru', 'act_nayamu'], fx: 'sweat' },
    { act: ['act_kurushimu_w', 'act_uru_w', 'act_nayamu_w'], face: ['face_kanashimu_w', 'face_uru_w'], ms: 1600 },
  ],
  // Stopped mid-sentence: "eh?", then an understanding nod.
  interrupt: [
    { act: ['act_odoroku', 'act_bikkuri'], fx: 'surprise' },
    { act: ['act_odoroku_w', 'act_bikkuri_w'], ms: 500 },
    { act: ['act_unazuku', 'act_unazuku02'] },
  ],
  greet: [
    { act: ['act_unazuku', 'act_unazuku02'] },
    { act: ['act_hohoemu', 'act_egao'], fx: 'heart' },
  ],
  // "Does it suit me?"
  costume: [
    { act: ['act_egao02', 'act_egao03', 'act_egao', 'act_hohoemu'], blush: true, fx: 'sparkle' },
    { act: ['act_egao02_w', 'act_egao03_w', 'act_egao_w', 'act_hohoemu_w'], face: ['face_tere_w'], blush: true, ms: 900 },
    { act: ['act_hohoemu', 'act_egao'], blush: true },
  ],
}

/** A reaction tier: `from` is the running count (taps or pats) that reaches it. */
export type Tier = { from: number; name: string; steps: Step[] }

/** Clicking her face: surprised, startled, then pouting, then properly angry (R34). */
export const FACE_TAPS: Tier[] = [
  { from: 1, name: 'tap-surprised', steps: [
    { act: ['act_odoroku', 'act_bikkuri'], fx: 'surprise' },
    { act: ['act_odoroku_w', 'act_bikkuri_w'], ms: 700 },
  ] },
  // Costumes without a jump (act_bikkuri) look flustered after the start instead.
  { from: 2, name: 'tap-startled', steps: [
    { act: ['act_bikkuri', 'act_odoroku'], fx: 'surprise' },
    { act: ['act_bikkuri_w', 'act_odoroku_w'], face: ['face_bikkuri_w', 'face_komaru_w', 'face_nayamu_w'], ms: 600 },
  ] },
  { from: 3, name: 'tap-pout', steps: [
    { act: ['act_punpun', 'act_ikaru'], blush: true, fx: 'anger' },
    { act: ['act_punpun_w', 'act_ikaru_w'], face: ['face_punpun_w', 'face_nayamu_w'], blush: true, ms: 1400 },
  ] },
  { from: 6, name: 'tap-angry', steps: [
    { act: ['act_ikaru', 'act_gekido', 'act_punpun'], face: ['face_ikaru02', 'face_ikaru'], fx: 'anger' },
    { act: ['act_ikaru_w', 'act_gekido_w', 'act_punpun_w'], ms: 1600 },
  ] },
]

/** Clicking her body: shy, flustered, then sulking. */
export const BODY_TAPS: Tier[] = [
  { from: 1, name: 'tap-shy', steps: [
    { act: ['act_hohoemu', 'act_nayamu'], face: ['face_tere_w', 'face_nayamu'], blush: true, fx: 'heart' },
    { act: ['act_hohoemu_w', 'act_nayamu_w'], face: ['face_tere_w', 'face_nayamu_w'], blush: true, ms: 1400 },
  ] },
  { from: 3, name: 'tap-flustered', steps: [
    { act: ['act_bikkuri', 'act_odoroku'], blush: true, fx: 'surprise' },
    { act: ['act_odoroku_w', 'act_bikkuri_w'], face: ['face_tere_w'], blush: true, ms: 700 },
    { act: ['act_punpun', 'act_ikaru'], blush: true, fx: 'anger' },
  ] },
  { from: 5, name: 'tap-sulk', steps: [
    { act: ['act_suneru', 'act_punpun', 'act_nayamu'], face: ['face_suneru', 'face_nayamu'], blush: true, fx: 'dots' },
    { act: ['act_suneru_w', 'act_punpun_w', 'act_nayamu_w'], face: ['face_suneru_w', 'face_nayamu_w'], blush: true, ms: 1800 },
  ] },
]

/**
 * Headpat tiers, ported from waifufy's headpat config without voices: happy, shy with a blush, a pout that
 * means "stop slacking off", then sulking. `PAT_BUSY` plays instead while she is working (R33).
 */
export const PAT_TIERS: Tier[] = [
  { from: 1, name: 'pat-happy', steps: [
    { act: ['act_hohoemu', 'act_egao'], face: ['face_egao04', 'face_egao', 'face_hohoemu'], blush: true, fx: 'hearts' },
    { act: ['act_hohoemu_w', 'act_egao_w'], face: ['face_egao04_w', 'face_egao_w', 'face_hohoemu_w'], blush: true, ms: 1200 },
  ] },
  { from: 2, name: 'pat-shy', steps: [
    { act: ['act_hohoemu', 'act_nayamu'], face: ['face_tere_w', 'face_nayamu'], blush: true, fx: 'hearts' },
    { act: ['act_hohoemu_w', 'act_nayamu_w'], face: ['face_tere_w', 'face_nayamu_w'], blush: true, ms: 1200 },
  ] },
  { from: 4, name: 'pat-pout', steps: [
    { act: ['act_punpun', 'act_ikaru'], blush: true, fx: 'anger' },
    { act: ['act_punpun_w', 'act_ikaru_w'], face: ['face_punpun_w', 'face_nayamu_w'], blush: true, ms: 1400 },
  ] },
  { from: 7, name: 'pat-sulk', steps: [
    { act: ['act_suneru', 'act_punpun', 'act_nayamu'], face: ['face_suneru', 'face_nayamu'], blush: true, fx: 'dots' },
    { act: ['act_suneru_w', 'act_punpun_w', 'act_nayamu_w'], face: ['face_suneru_w', 'face_nayamu_w'], blush: true, ms: 1800 },
  ] },
]

export const PAT_BUSY: Tier = { from: 0, name: 'pat-busy', steps: [
  { act: ['act_ikaru', 'act_gekido', 'act_punpun'], face: ['face_ikaru02', 'face_ikaru', 'face_punpun'], fx: 'anger' },
  { act: ['act_ikaru_w', 'act_gekido_w', 'act_punpun_w'], ms: 1400 },
] }

// ---------------------------------------------------------------- idle life (R31)

/** A held variation of her resting pose. It only plays while she rests in `normal` or `smile`. */
export type IdleVariant = { name: string; pose: Pose; ms: [number, number] }

export const IDLE_HOLDS: IdleVariant[] = [
  { name: 'idle-normal02', pose: { act: ['act_normal02_w'], face: ['face_normal02_w'] }, ms: [5000, 8000] },
  { name: 'idle-normal03', pose: { act: ['act_normal03_w', 'act_normal_w'], face: ['face_normal03_w'] }, ms: [2600, 4000] },
  { name: 'idle-smile', pose: { act: ['act_hohoemu_w'], face: ['face_hohoemu_w'] }, ms: [4000, 7000] },
]
/** A small one-shot smile that returns to whatever she holds. */
export const IDLE_SMILE: Step[] = [{ act: ['act_hohoemu'] }]
/** Head turns layered over any pose. */
export const LOOK_AROUND = [['add_select_L'], ['add_select_R']]

// ---------------------------------------------------------------- resolver

export type MotionRef = { group: string; index: number; suffix: string }
export type MotionIndex = Map<string, MotionRef>

/** The `AC_<id>_` prefix of a motion file name, taken from the first act/face/add motion. */
const PREFIX = /^(.*?_)(?:act|face|add)_/

/** Indexes a model3.json's motions by suffix. Names that don't follow the prefix scheme keep their full name. */
export function indexMotions(motions: Record<string, { File: string }[]>): MotionIndex {
  const entries = Object.entries(motions).flatMap(([group, list]) =>
    list.map((m, index) => ({ group, index, name: m.File.split('/').pop()!.replace(/\.motion3\.json$/i, '') })),
  )
  const prefix = entries.map((e) => PREFIX.exec(e.name)?.[1]).find(Boolean) ?? ''
  const index: MotionIndex = new Map()
  for (const e of entries) {
    const suffix = prefix && e.name.startsWith(prefix) ? e.name.slice(prefix.length) : e.name
    if (!index.has(suffix)) index.set(suffix, { group: e.group, index: e.index, suffix })
  }
  return index
}

export const first = (index: MotionIndex, candidates: string[] | undefined) =>
  candidates?.map((c) => index.get(c)).find((m) => m !== undefined)

/** Holds loop; one-shots and add-ons play once. */
export const isHold = (suffix: string) => suffix.endsWith('_w')

/** The act and face a pose resolves to on one costume; undefined when none of its act candidates exists. */
export function resolvePose(index: MotionIndex, p: Pose): { act: MotionRef; face?: MotionRef } | undefined {
  const act = first(index, p.act)
  if (!act) return undefined
  const face = first(index, p.face) ?? index.get(act.suffix.replace(/^act_/, 'face_'))
  return { act, face }
}
