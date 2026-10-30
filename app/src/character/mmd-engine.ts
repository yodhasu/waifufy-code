// Her 3D motion, renderer-free (from ui-draft/mmd-lab/src/engine.js): a stand-in skeleton (three.js bones in three's
// right-handed axes, never drawn) that springs, emotes and the idle layer move. mmd.ts copies its rotations into the
// MMD model's bones every frame, before babylon-mmd runs her IK and physics, and writes `face` into her morphs.

import { Bone, Euler, Group, Quaternion, Vector3 } from 'three'
import type { Emotion } from '../../../link/src/protocol.ts'

/** The bones the engine drives: her upper body, arms and fingers. Her legs stay MMD's (IK keeps her feet planted). */
const WAIST_UP = /^(上半身|上半身2|首|頭|両目|[左右]目|[左右](肩|腕|腕捩|ひじ|手捩|手首)|[左右](親指|人指|中指|薬指|小指)[０-３])$/

type Rig = { bone: Record<string, Bone> }
/** A bone's rotation as [x, y, z] radians in three's axes, in the bone's parent space: x +down / forward, y turn, z tilt. */
type Turn = [number, number, number]
type Face = Record<string, number>

/** Builds three.js bones for an MMD model from `bones`: [{ name, parent (index or -1), rest: [x, y, z] }]. */
export function standIn(bones: { name: string; parent: number; rest: [number, number, number] }[]): Rig {
  const root = new Group()
  const made = bones.map((b) => Object.assign(new Bone(), { name: b.name }))
  bones.forEach((b, i) => {
    made[i]!.position.fromArray(b.rest)
    ;(b.parent >= 0 ? made[b.parent]! : root).add(made[i]!)
  })
  return { bone: Object.fromEntries(made.map((b) => [b.name, b])) }
}

// ---------------------------------------------------------------- springs

// Each waist-up bone chases its target with a critically damped spring; the chest leads, fingers come last.
function feel(name: string): [number, number] {
  if (/^上半身/.test(name)) return [5.0, 0]
  if (/首|肩$/.test(name)) return [4.6, 40]
  if (/頭|腕$/.test(name)) return [4.2, 80]
  if (/ひじ|腕捩/.test(name)) return [3.8, 140]
  if (/手首|手捩/.test(name)) return [3.4, 200]
  return [3.2, 260]
}

type Spring = { name: string; b: Bone; q: Quaternion; vel: Vector3; target: Quaternion; next: { at: number; q: Quaternion } | null; w: number; delay: number }

const err = new Quaternion(), dq = new Quaternion(), axis = new Vector3()
function stepSpring(r: Spring, dt: number) {
  err.copy(r.target).multiply(dq.copy(r.q).invert())
  if (err.w < 0) err.set(-err.x, -err.y, -err.z, -err.w)
  const angle = 2 * Math.acos(Math.min(1, err.w))
  const s = Math.sqrt(1 - err.w * err.w)
  axis.set(err.x, err.y, err.z).multiplyScalar(s > 1e-6 ? angle / s : 0)
  r.vel.addScaledVector(axis, r.w * r.w * dt).multiplyScalar(1 - 2 * r.w * dt)
  const turn = r.vel.length() * dt
  if (turn > 1e-7) r.q.premultiply(dq.setFromAxisAngle(axis.copy(r.vel).normalize(), turn)).normalize()
}

// ---------------------------------------------------------------- emotes: face + stance + an optional beat

// The app's emotions as an MMD face, a held stance (small turns of the head, neck, shoulders and upper body, over the
// relaxed arms) and an optional one-shot beat. Faces combine MMD morphs the usual way (brows + eyes + mouth, plus
// blush, sweat, tears, the anger mark), with the names Reine's model uses; a model without one simply skips it.
type Emote = { face: Face; stance: Partial<Record<string, Turn>>; beat?: keyof typeof BEATS; then?: { after: number; face: Face } }

export const EMOTES: Record<Emotion, Emote> = {
  normal: { face: { にこり: 0.3, にこり口: 0.35, 口角上げ: 0.2 }, stance: {} },
  smile: { face: { にこり: 0.6, 笑い: 0.35, 下まつ毛上げ: 0.3, にこり口: 0.8, 口角上げ: 0.3 }, stance: { 頭: [0, 0, 0.05] } },
  happy: { face: { にこり: 0.8, 笑い: 0.8, 笑い口: 0.7, 口角上げ: 0.4, ハイライト拡大: 0.3, 照れ: 0.25 }, stance: { 頭: [-0.04, 0, 0.08] }, beat: 'bob' },
  delighted: { face: { にこり: 1, 笑い: 1, 大笑い: 0.8, 口角上げ: 0.5, 照れ: 0.5 }, stance: { 頭: [-0.06, 0, 0.12], 左肩: [0, 0, 0.05], 右肩: [0, 0, -0.05] }, beat: 'bounce' },
  nod: { face: { にこり: 0.5, 笑い: 0.3, にこり口: 0.6 }, stance: {}, beat: 'nod' },
  // Mulling it over: head down and a little turned, brows knitted (puzzled), eyes lowered, a lopsided "hmm".
  think: { face: { 真面目: 0.5, 困る: 0.5, 寄せ: 0.4, 瞳_下: 0.3, 結ぶ: 0.6, 口角下げ: 0.2, 左口角上げ: 0.35 }, stance: { 頭: [0.16, -0.08, 0.06], 首: [0.05, -0.03, 0] } },
  worried: { face: { 困る２: 0.9, 寄せ: 0.4, 目尻_下げ: 0.4, '▲': 0.45, 口角下げ: 0.4, 汗: 0.7 }, stance: { 頭: [0.08, 0, -0.06], 上半身: [0.03, 0, 0], 左肩: [0, 0, 0.05], 右肩: [0, 0, -0.05] } },
  serious: { face: { 真面目２: 0.8, 寄せ: 0.3, キリッ: 0.6, 結ぶ: 0.7 }, stance: { 頭: [0.04, 0, 0], 上半身2: [-0.02, 0, 0] }, beat: 'nodOnce' },
  // Shock: both shoulders up and held there, the head pulled back.
  surprised: { face: { 上: 0.9, びっくり: 0.9, 瞳小: 0.5, お: 0.8 }, stance: { 頭: [-0.06, 0, 0], 左肩: [0, 0, 0.16], 右肩: [0, 0, -0.16] }, beat: 'startle' },
  shy: { face: { 照れ: 1, 困る: 0.6, はぅ: 0.5, 瞳_下: 0.35, '▲': 0.4 }, stance: { 頭: [0.15, 0.08, 0.12], 首: [0.04, 0, 0], 左肩: [0, 0, 0.06], 右肩: [0, 0, -0.06] } },
  // "Hmph": she turns away ~60°, spread down the body like a real turn, chin up, eyes glancing back at you; once the
  // turn settles she shuts her eyes on you (`then`).
  pout: {
    face: { 怒り: 0.4, じと目: 0.35, 瞳_右: 0.55, ムッ: 1, 左頬ふくらまし: 0.8, 右頬ふくらまし: 0.8, 照れ: 0.4 },
    then: { after: 0.6, face: { 怒り: 0.45, まばたき: 1, ムッ: 1, 左頬ふくらまし: 0.8, 右頬ふくらまし: 0.8, 照れ: 0.45 } },
    stance: { 頭: [-0.12, 0.55, 0.08], 首: [-0.03, 0.25, 0], 上半身2: [0, 0.14, 0], 上半身: [0, 0.08, 0], 左肩: [0, 0, 0.06] },
    beat: 'hmph',
  },
  sad: { face: { 困る２: 1, 目尻_下げ: 0.5, なごみ: 0.35, 瞳_下: 0.4, 口角下げ: 0.7, ハイライト消: 0.2 }, stance: { 頭: [0.2, 0, 0.05], 上半身: [0.05, 0, 0], 上半身2: [0.04, 0, 0], 左肩: [0, 0, -0.05], 右肩: [0, 0, 0.05] } },
  angry: { face: { 怒り２: 1, 寄せ: 0.6, キリッ: 0.5, 瞳小: 0.3, くいしばる: 0.6, ムカッ: 1 }, stance: { 頭: [0.06, 0, 0], 上半身: [0.05, 0, 0], 左肩: [0, 0, 0.08], 右肩: [0, 0, -0.08] }, beat: 'shake' },
  sigh: { face: { 困る: 0.5, なごみ_2: 0.7, '▲': 0.3, 口角下げ: 0.3 }, stance: { 頭: [0.08, 0, 0] }, beat: 'sigh' },
  teary: { face: { 困る２: 1, 目尻_下げ: 0.5, ハイライト拡大: 0.6, 涙: 1, '▲_2': 0.5, 照れ: 0.5 }, stance: { 頭: [0.14, 0, 0.1], 上半身: [0.03, 0, 0], 左肩: [0, 0, 0.04], 右肩: [0, 0, -0.04] } },
}

// Beats: one-shot movements on top of the stance. A duration in seconds and bone → turn at time u (0 – 1).
const bump = (u: number, a: number, b: number) => (u <= a || u >= b ? 0 : Math.sin((Math.PI * (u - a)) / (b - a)))
const BEATS = {
  nod: { d: 1.1, f: (u: number) => ({ 頭: [0.2 * (bump(u, 0, 0.45) + 0.7 * bump(u, 0.45, 0.9)), 0, 0], 首: [0.06 * (bump(u, 0, 0.45) + 0.7 * bump(u, 0.45, 0.9)), 0, 0] }) },
  nodOnce: { d: 0.7, f: (u: number) => ({ 頭: [0.12 * bump(u, 0, 1), 0, 0] }) },
  bob: { d: 1.2, f: (u: number) => ({ 頭: [0, 0, 0.06 * Math.sin(2 * Math.PI * u) * (1 - u)], 上半身2: [-0.03 * bump(u, 0, 0.5), 0, 0] }) },
  bounce: {
    d: 1.0,
    f: (u: number) => {
      const b = bump(u, 0, 0.35) + 0.6 * bump(u, 0.35, 0.7)
      return { 上半身: [-0.04 * b, 0, 0], 左肩: [0, 0, 0.08 * b], 右肩: [0, 0, -0.08 * b], 頭: [-0.05 * b, 0, 0] }
    },
  },
  startle: {
    d: 0.9,
    f: (u: number) => {
      const k = u < 0.15 ? u / 0.15 : Math.max(0, 1 - (u - 0.15) / 0.85)
      return { 頭: [-0.12 * k, 0, 0], 上半身2: [-0.06 * k, 0, 0], 左肩: [0, 0, 0.2 * k], 右肩: [0, 0, -0.2 * k] }
    },
  },
  // Only the turn: it overshoots a little and settles. The chin-up is the stance.
  hmph: { d: 0.8, f: (u: number) => ({ 頭: [0, 0.12 * bump(u, 0, 0.6) - 0.03 * bump(u, 0.6, 1), 0], 上半身2: [0, 0.05 * bump(u, 0, 0.7), 0] }) },
  shake: { d: 0.8, f: (u: number) => ({ 頭: [0, 0.1 * Math.sin(3 * 2 * Math.PI * u) * (1 - u), 0] }) },
  sigh: {
    d: 2.4,
    f: (u: number) => {
      const inhale = bump(u, 0, 0.4), slump = bump(u, 0.35, 1)
      return { 上半身2: [-0.05 * inhale + 0.07 * slump, 0, 0], 頭: [0.12 * slump, 0, 0], 左肩: [0, 0, 0.06 * inhale - 0.05 * slump], 右肩: [0, 0, -0.06 * inhale + 0.05 * slump] }
    },
  },
} satisfies Record<string, { d: number; f: (u: number) => Record<string, number[]> }>

const euler = new Euler()
const turnQ = new Quaternion()

/** Her base pose: arms down at her sides, mirrored left to right. */
function relaxedPose() {
  const mirror = ([x, y, z]: Turn): Turn => [x, -y, -z]
  const L: Record<string, Turn> = { 左腕: [0, -0.12, -0.8], 左ひじ: [0, -0.28, 0], 左手首: [0, 0, 0.05] }
  const pose = new Map<string, Quaternion>()
  for (const [n, v] of Object.entries(L)) {
    const order = /腕$/.test(n) ? 'XYZ' : 'YXZ'
    pose.set(n, new Quaternion().setFromEuler(new Euler(v[0], v[1], v[2], order)))
    const m = mirror(v)
    pose.set(n.replace('左', '右'), new Quaternion().setFromEuler(new Euler(m[0], m[1], m[2], order)))
  }
  return pose
}

/** One breath, in seconds: a quicker inhale than exhale, as at rest. */
const BREATH_S = 4.4
/** 0 (breathed out) – 1 (breathed in), rising for the first 40% of the cycle and easing out after. */
function breath(t: number) {
  const u = (t / BREATH_S) % 1
  return u < 0.4 ? 0.5 - 0.5 * Math.cos((Math.PI * u) / 0.4) : 0.5 + 0.5 * Math.cos((Math.PI * (u - 0.4)) / 0.6)
}

/** Always on top: breathing, a slow sway, small head movements. */
function idle(name: string, t: number): Turn | null {
  const tau = Math.PI * 2
  const b = breath(t)
  // A slow weight shift at the hips (leg IK keeps her feet planted); the upper body leans back the other way so her
  // head stays level. It is what sets the skirt and hair swinging.
  const hip = 0.022 * Math.sin((tau * t) / 6.7)
  if (name === '下半身') return [0, 0.01 * Math.sin((tau * t) / 8.3), hip]
  // Breathing in, the chest rises and opens back a little and the shoulders lift; the neck keeps her head level.
  if (name === '上半身2') return [-0.028 * b, 0, 0]
  if (name === '首') return [0.02 * b, 0, 0]
  if (name === '左肩') return [0, 0, 0.022 * b]
  if (name === '右肩') return [0, 0, -0.022 * b]
  if (name === '上半身') return [0, 0.012 * Math.sin((tau * t) / 9.1), 0.01 * Math.sin((tau * t) / 7.3) - 0.8 * hip]
  if (name === '頭') return [0.012 * Math.sin((tau * t) / 6.1), 0.025 * Math.sin((tau * t) / 9.7), 0.01 * Math.sin((tau * t) / 11.3)]
  return null
}

const IDLE_BONES = ['下半身', '上半身', '上半身2', '首', '左肩', '右肩', '頭']

/**
 * A head turn carried down her body, so she moves from the waist up rather than from the neck: the neck, chest and
 * waist each take a share of it (on top of what a stance gives them itself).
 */
const CARRY: [string, number][] = [['首', 0.3], ['上半身2', 0.22], ['上半身', 0.12]]
function carried(turns: Record<string, number[]>): Record<string, number[]> {
  const head = turns['頭']
  if (!head) return turns
  const out: Record<string, number[]> = { ...turns }
  for (const [bone, k] of CARRY) {
    const own = out[bone] ?? [0, 0, 0]
    // Nods stay mostly in the neck; turns and tilts spread further.
    out[bone] = [own[0]! + head[0]! * k * 0.5, own[1]! + head[1]! * k, own[2]! + head[2]! * k]
  }
  return out
}

/**
 * How far she turns toward the cursor at full focus (radians, [pitch, turn]), from the waist up: the head most, the
 * neck, chest and waist each a little, the eyes on top. About 35° of turn in all.
 */
const LOOK = { 上半身: [0.02, 0.06], 上半身2: [0.03, 0.09], 首: [0.05, 0.12], 頭: [0.1, 0.24], 両目: [0.08, 0.16] } as const
/** While her head is stroked: a dip into the hand, and a small sway from side to side. */
const PAT_DIP = 0.12
const PAT_SWAY = 0.05

/**
 * The engine on a stand-in rig. `update(dt)` moves the stand-in; read `controlled` (the bones it drives) and `face`
 * (morph name → weight) after it.
 */
export function createEngine(rig: Rig) {
  const { bone } = rig
  // Waist up, plus the lower body for the idle weight shift (nothing poses it, so it springs to rest).
  const springs: Spring[] = Object.keys(bone)
    .filter((n) => WAIST_UP.test(n) || n === '下半身')
    .map((n) => {
      const [w, delay] = feel(n)
      return { name: n, b: bone[n]!, q: new Quaternion(), vel: new Vector3(), target: new Quaternion(), next: null, w, delay }
    })
  const relaxed = relaxedPose()
  const face: Face = {}
  let faceTarget: Face = {}
  let faceLater: { at: number; face: Face } | null = null
  let beat: { d: number; f: (u: number) => Record<string, number[]>; t: number } | null = null
  // Eyelids closed by the face (まばたき in a face), apart from blinking: the more closed of the two shows.
  let t = 0, nextBlink = 2, blinkT = -1, lids = 0
  const look = { x: 0, y: 0, tx: 0, ty: 0, bx: 0, by: 0 }
  /** 0 – 1: how much her head is being stroked right now. */
  let pat = 0
  let patUntil = 0

  function setPose(target: Map<string, Quaternion>, instant: boolean) {
    const now = performance.now()
    for (const r of springs) {
      const q = target.get(r.name) ?? new Quaternion()
      if (instant) r.q.copy(q), r.target.copy(q), r.vel.set(0, 0, 0), (r.next = null)
      else r.next = { at: now + r.delay, q: q.clone() }
    }
  }

  /** An emotion: its stance over the relaxed arms, its face, and its beat. */
  function emote(name: Emotion, instant = false) {
    const e = EMOTES[name]
    const target = new Map(relaxed)
    for (const [n, v] of Object.entries(carried(e.stance as Record<string, number[]>))) {
      const q = target.get(n)?.clone() ?? new Quaternion()
      target.set(n, q.multiply(new Quaternion().setFromEuler(new Euler(v![0], v![1], v![2], 'YXZ'))))
    }
    setPose(target, instant)
    faceTarget = e.face
    beat = e.beat && !instant ? { ...BEATS[e.beat], t: 0 } : null
    faceLater = e.then ? { at: t + e.then.after, face: e.then.face } : null
  }

  function blink(dt: number) {
    if (blinkT < 0 && t > nextBlink) blinkT = 0
    if (blinkT < 0) return 0
    blinkT += dt
    const v = blinkT < 0.07 ? blinkT / 0.07 : blinkT < 0.16 ? 1 - (blinkT - 0.07) / 0.09 : 0
    if (blinkT >= 0.16) (blinkT = -1), (nextBlink = t + 2 + Math.random() * 4)
    return v
  }

  const turn = (b: Bone | undefined, v: number[]) => b?.quaternion.multiply(turnQ.setFromEuler(euler.set(v[0]!, v[1]!, v[2]!, 'YXZ')))

  function update(dt: number) {
    t += dt
    const now = performance.now()
    for (const r of springs) {
      if (r.next && now >= r.next.at) r.target.copy(r.next.q), (r.next = null)
      for (let k = 0, n = Math.max(4, Math.ceil(dt / 0.008)); k < n; k++) stepSpring(r, dt / n)
      r.b.quaternion.copy(r.q)
    }
    if (beat) {
      beat.t += dt
      const u = beat.t / beat.d
      if (u >= 1) beat = null
      else for (const [n, v] of Object.entries(carried(beat.f(u)))) turn(bone[n], v)
    }
    for (const name of IDLE_BONES) {
      const v = idle(name, t)
      if (v) turn(bone[name], v)
    }
    const k = Math.min(1, dt * 4)
    // Where to look: the cursor, on top of the camera's direction (she faces whoever is looking at her).
    const tx = Math.max(-1.6, Math.min(1.6, look.tx + look.bx))
    const ty = Math.max(-1.2, Math.min(1.2, look.ty + look.by))
    look.x += (tx - look.x) * k
    look.y += (ty - look.y) * k
    // Screen right (x > 0) is her left: in three's axes a turn about up toward +x is positive. y up lifts her chin.
    for (const [n, [pitch, yaw]] of Object.entries(LOOK)) turn(bone[n], [-look.y * pitch, look.x * yaw, 0])
    pat += ((performance.now() < patUntil ? 1 : 0) - pat) * Math.min(1, dt * 5)
    if (pat > 0.001) {
      turn(bone['頭'], [PAT_DIP * pat, 0, PAT_SWAY * pat * Math.sin(t * 5)])
      turn(bone['首'], [PAT_DIP * 0.4 * pat, 0, 0])
    }
    if (faceLater && t >= faceLater.at) (faceTarget = faceLater.face), (faceLater = null)
    const ease = Math.min(1, dt * 6)
    for (const n of new Set([...Object.keys(faceTarget), ...Object.keys(face)])) {
      if (n !== 'まばたき') face[n] = (face[n] ?? 0) + ((faceTarget[n] ?? 0) - (face[n] ?? 0)) * ease
    }
    lids += ((faceTarget['まばたき'] ?? 0) - lids) * ease
    face['まばたき'] = Math.max(lids, blink(dt))
  }

  return {
    controlled: springs.map((r) => r.b),
    face,
    emote,
    update,
    /** Turns her toward a point: x right, y up, each in [-1, 1]. */
    look(x: number, y: number) {
      look.tx = Math.max(-1, Math.min(1, x))
      look.ty = Math.max(-1, Math.min(1, y))
    },
    /** Where "straight ahead" is, in the same units: toward the camera when it has moved round her. */
    lookBase(x: number, y: number) {
      look.bx = x
      look.by = y
    },
    /** Her head is being stroked: she leans into it for a moment after each call. */
    stroked(ms: number) {
      patUntil = performance.now() + ms
    },
  }
}
