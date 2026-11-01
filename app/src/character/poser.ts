// The studio's posing, renderer-free, on the engine's stand-in rig (three's axes): an arm reaching for a point (two-bone
// IK, the elbow keeping its side), kept out of her own body by the model's rigid bodies, joint limits, hand shapes and
// mirroring. Everything takes and gives a JointPose, the card's form.

import { Bone, Euler, Quaternion, Vector3 } from 'three'
import type { JointPose, JointTurn } from '../../../link/src/protocol.ts'
import { poseOf, posed } from './mmd-engine.ts'

type Bones = Record<string, Bone>
export type Side = '左' | '右'

/** A rigid body of the model as PMX has it: MMD's axes, at her bind pose. */
export type RigidBodyInfo = { bone: string; shapeType: number; size: [number, number, number]; position: [number, number, number]; rotation: [number, number, number] }

/** A body shape that follows a bone: in the bone's own frame, three's axes. */
type Collider = { bone: Bone; offset: Vector3; rot: Quaternion; type: number; size: Vector3 }

/** Her body, which an arm can't go through: the upper body, the chest, the neck and head (a hand can rest on them). */
const BODY = /^(上半身[23]?|下半身|首|頭)$|胸/
/** How far a wrist (the hand round it) and an elbow keep off her body, in MMD units (8 cm each). */
const HAND_GAP = 0.45
const ARM_GAP = 0.3
/** An arm never quite straightens: the elbow keeps its side. */
const REACH = 0.995
/** How far the arm may swing round to get its elbow or forearm out of her body, and in what steps (radians). */
const SWING_MAX = Math.PI / 2
const SWING_STEP = Math.PI / 36

// ---------------------------------------------------------------- the rig in a pose

/** Puts the stand-in in `pose` (every joint of it; the rest at bind), its world matrices updated. */
export function apply(bone: Bones, pose: JointPose) {
  const q = posed(pose)
  for (const [n, b] of Object.entries(bone)) b.quaternion.copy(q.get(n) ?? IDENTITY)
  for (const b of Object.values(bone)) if (!(b.parent instanceof Bone)) b.updateMatrixWorld(true)
}
const IDENTITY = new Quaternion()

const world = (b: Bone, v = new Vector3()) => v.setFromMatrixPosition(b.matrixWorld)
const worldQ = (b: Bone, q = new Quaternion()) => b.getWorldQuaternion(q)

/** Turns `b` by `r`, a rotation in world space (its children follow). */
function rotateWorld(b: Bone, r: Quaternion) {
  const parent = b.parent ? worldQ(b.parent as Bone) : new Quaternion()
  // local' = parent⁻¹ · r · parent · local
  b.quaternion.premultiply(parent.clone().invert().multiply(r).multiply(parent))
  b.updateMatrixWorld(true)
}

// ---------------------------------------------------------------- her body

/** Her body shapes from the model's rigid bodies (the ones on her torso and head), on the stand-in's bones. */
export function bodyOf(bone: Bones, bodies: RigidBodyInfo[]): Collider[] {
  apply(bone, {})
  const out: Collider[] = []
  for (const r of bodies) {
    const b = bone[r.bone]
    if (!b || !BODY.test(r.bone)) continue
    // MMD's left-handed axes to three's: z flips, and so do the x and y turns.
    const pos = new Vector3(r.position[0], r.position[1], -r.position[2])
    const rot = new Quaternion().setFromEuler(new Euler(-r.rotation[0], -r.rotation[1], r.rotation[2], 'XYZ'))
    const inv = worldQ(b).invert()
    out.push({ bone: b, offset: pos.sub(world(b)).applyQuaternion(inv), rot: inv.multiply(rot), type: r.shapeType, size: new Vector3(...r.size) })
  }
  return out
}

/** How far `p` is inside her body (≤ 0: outside, with `gap` to spare), and the way out: the deepest shape's. */
function inside(colliders: Collider[], p: Vector3, gap: number) {
  let depth = 0
  let out: Vector3 | undefined
  for (const c of colliders) {
    const center = c.offset.clone().applyMatrix4(c.bone.matrixWorld)
    const rot = worldQ(c.bone).multiply(c.rot)
    const local = p.clone().sub(center).applyQuaternion(rot.clone().invert())
    let d = 0
    let dir = new Vector3()
    if (c.type === 1) {
      // A box: out through the nearest face.
      const pen = [0, 1, 2].map((i) => c.size.getComponent(i) + gap - Math.abs(local.getComponent(i)))
      if (pen.every((x) => x > 0)) {
        const i = pen.indexOf(Math.min(...pen))
        d = pen[i]!
        dir.setComponent(i, Math.sign(local.getComponent(i)) || 1)
      }
    } else {
      // A sphere, or a capsule (its axis along y): out from the nearest point of its core.
      const half = c.type === 2 ? c.size.y / 2 : 0
      const core = new Vector3(0, Math.max(-half, Math.min(half, local.y)), 0)
      const away = local.clone().sub(core)
      const len = away.length()
      d = c.size.x + gap - len
      dir = len > 1e-6 ? away.divideScalar(len) : new Vector3(0, 0, 1)
    }
    if (d > depth) (depth = d), (out = dir.applyQuaternion(rot))
  }
  return { depth, out }
}

// ---------------------------------------------------------------- an arm reaching

const chain = (bone: Bones, side: Side) => {
  const a = bone[`${side}腕`], b = bone[`${side}ひじ`], c = bone[`${side}手首`]
  return a && b && c ? { a, b, c } : undefined
}

/** Swings the arm about its shoulder–wrist line by `angle`, so the elbow moves and the wrist stays. */
function swing(a: Bone, c: Bone, angle: number) {
  const axis = world(c).sub(world(a)).normalize()
  rotateWorld(a, new Quaternion().setFromAxisAngle(axis, angle))
}

/**
 * Her arm reaching for `target` (world space, three's axes): the classic two-bone solve, which keeps the elbow on the
 * side it bends to now. `pole`: a point the elbow should point toward (dragging the elbow). Then her body pushes the
 * wrist out, and the arm swings round until the elbow and forearm are out too. Returns the arm's joints as turns.
 */
export function reach(bone: Bones, colliders: Collider[], pose: JointPose, side: Side, target: Vector3, pole?: Vector3): JointPose {
  apply(bone, pose)
  const arm = chain(bone, side)
  if (!arm) return {}
  const { a, b, c } = arm
  const t = target.clone()
  const hit = inside(colliders, t, HAND_GAP)
  if (hit.out) t.addScaledVector(hit.out, hit.depth)

  for (let pass = 0; pass < 2; pass++) {
    const A = world(a), B = world(b), C = world(c)
    const lab = B.distanceTo(A), lcb = C.distanceTo(B)
    const lat = Math.max(Math.abs(lab - lcb) + 1e-3, Math.min((lab + lcb) * REACH, t.distanceTo(A)))
    const angle = (u: Vector3, v: Vector3) => u.angleTo(v)
    const acos = (x: number) => Math.acos(Math.max(-1, Math.min(1, x)))
    // Bend the elbow so shoulder–wrist is as long as shoulder–target, in the plane the arm bends in now.
    let axis = C.clone().sub(A).cross(B.clone().sub(A))
    if (axis.lengthSq() < 1e-10) axis = C.clone().sub(A).cross(new Vector3(0, 0, 1))
    axis.normalize()
    const shoulder0 = angle(C.clone().sub(A), B.clone().sub(A)), elbow0 = angle(A.clone().sub(B), C.clone().sub(B))
    const shoulder1 = acos((lcb * lcb - lab * lab - lat * lat) / (-2 * lab * lat)), elbow1 = acos((lat * lat - lab * lab - lcb * lcb) / (-2 * lab * lcb))
    rotateWorld(a, new Quaternion().setFromAxisAngle(axis, shoulder1 - shoulder0))
    rotateWorld(b, new Quaternion().setFromAxisAngle(axis, elbow1 - elbow0))
    // Then turn the whole arm at the shoulder onto the target.
    const toWrist = world(c).sub(A).normalize(), toTarget = t.clone().sub(A).normalize()
    rotateWorld(a, new Quaternion().setFromUnitVectors(toWrist, toTarget))
    if (pole) {
      // The elbow toward the pole: the swing about the shoulder–wrist line that brings it closest.
      const n = world(c).sub(A).normalize()
      const flat = (v: Vector3) => v.clone().sub(A).projectOnPlane(n)
      const e = flat(world(b)), p = flat(pole)
      if (e.lengthSq() > 1e-8 && p.lengthSq() > 1e-8) swing(a, c, Math.sign(n.dot(e.clone().cross(p))) * e.angleTo(p))
    }
  }

  // Elbow or forearm in her body: swing round, whichever way gets out sooner.
  const stuck = () => {
    const B = world(b), C = world(c)
    return inside(colliders, B, ARM_GAP).depth + inside(colliders, B.clone().lerp(C, 0.5), ARM_GAP).depth + inside(colliders, world(a).lerp(B, 0.6), ARM_GAP).depth
  }
  if (stuck() > 0) {
    const start = a.quaternion.clone()
    let best = { angle: 0, depth: stuck() }
    for (const dir of [1, -1]) {
      for (let s = SWING_STEP; s <= SWING_MAX; s += SWING_STEP) {
        a.quaternion.copy(start)
        a.updateMatrixWorld(true)
        swing(a, c, dir * s)
        const d = stuck()
        if (d < best.depth - 1e-6) best = { angle: dir * s, depth: d }
        if (d <= 0) break
      }
    }
    a.quaternion.copy(start)
    a.updateMatrixWorld(true)
    if (best.angle) swing(a, c, best.angle)
  }
  return pick(bone, [`${side}腕`, `${side}ひじ`])
}

/** The named joints of the stand-in as turns. */
function pick(bone: Bones, names: string[]): JointPose {
  const all = poseOf(new Map(names.filter((n) => bone[n]).map((n) => [n, bone[n]!.quaternion.clone()])))
  return Object.fromEntries(names.filter((n) => bone[n]).map((n) => [n, all[n] ?? [0, 0, 0]]))
}

// ---------------------------------------------------------------- limits

/** How far each kind of joint turns, in degrees from her relaxed pose: [bend, turn, tilt]. Arms and legs are free. */
const LIMITS: [RegExp, JointTurn][] = [
  [/^頭$/, [70, 80, 45]],
  [/^首$/, [45, 55, 35]],
  [/^上半身2?$/, [60, 50, 35]],
  [/^下半身$/, [35, 35, 25]],
  [/^[左右]肩$/, [30, 30, 40]],
  [/^[左右](手首|手捩|腕捩)$/, [85, 85, 70]],
  [/目$/, [30, 35, 10]],
  [/指/, [100, 100, 100]],
]

/** `turn` for `joint`, within how far it can go. */
export function limit(joint: string, turn: JointTurn): JointTurn {
  const lim = LIMITS.find(([re]) => re.test(joint))?.[1] ?? [180, 180, 180]
  return turn.map((v, i) => Math.round(Math.max(-lim[i]!, Math.min(lim[i]!, v)) * 10) / 10 + 0) as JointTurn
}

// ---------------------------------------------------------------- hands and mirroring

const FINGERS = ['人指', '中指', '薬指', '小指'] as const
const curl = (side: Side, deg: [number, number, number], spread = 0, thumb: [number, number, number] = [0, 0, 0]): JointPose => {
  const out: JointPose = {}
  FINGERS.forEach((f, i) => {
    deg.forEach((d, j) => (out[`${side}${f}${'１２３'[j]}`] = [0, j === 0 ? spread * (i - 1.5) : 0, -d]))
  })
  // The thumb folds in across the palm (its bend), in front of the curled fingers.
  thumb.forEach((d, j) => (out[`${side}親指${'０１２'[j]}`] = [d, 0, 0]))
  return out
}

/** Hand shapes, finger joints only: a curl of each finger's three joints (degrees), the spread, the thumb's. */
export const HANDS = {
  open: (s: Side) => curl(s, [0, 0, 0], 6),
  relaxed: (s: Side) => curl(s, [15, 25, 15], 2, [5, 10, 10]),
  fist: (s: Side) => curl(s, [80, 95, 70], 0, [20, 40, 40]),
  point: (s: Side) => ({ ...curl(s, [80, 95, 70], 0, [20, 40, 40]), ...straight(s, ['人指']) }),
  peace: (s: Side) => ({ ...curl(s, [80, 95, 70], 0, [20, 40, 40]), ...straight(s, ['人指', '中指'], 8) }),
} satisfies Record<string, (s: Side) => JointPose>
export type HandShape = keyof typeof HANDS

function straight(side: Side, fingers: string[], spread = 0): JointPose {
  const out: JointPose = {}
  fingers.forEach((f, i) => '１２３'.split('').forEach((d, j) => (out[`${side}${f}${d}`] = [0, j === 0 ? spread * (i ? 1 : -1) : 0, 0])))
  return out
}

/** `pose` with one side copied onto the other (`from` is the side kept); her middle stays. */
export function mirror(pose: JointPose, from: Side): JointPose {
  const to: Side = from === '左' ? '右' : '左'
  const out: JointPose = {}
  for (const [n, v] of Object.entries(pose)) if (!n.startsWith(to)) out[n] = v
  for (const [n, v] of Object.entries(pose)) if (n.startsWith(from)) out[to + n.slice(1)] = [...v] as JointTurn
  return out
}
