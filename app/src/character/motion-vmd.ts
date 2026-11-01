// A card's motion as a VMD and back, for Blender: her keys and held pose become bone keys on a 30 fps timeline (the
// held pose a moment after the last key, as she plays it), and a VMD's bone keys are sampled back at every frame that
// has one. Only the joints the engine drives come back; Blender's other tracks (センター, the IK targets) are dropped.

import { Quaternion } from 'three'
import { MAX_KEY_T, MAX_KEYS } from '../../../link/src/motions.ts'
import type { CustomMotion, JointPose } from '../../../link/src/protocol.ts'
import { JOINTS, KEY_SETTLE_S, poseOf, posed } from './mmd-engine.ts'
import { VMD_FPS, readVmd, writeVmd, type VmdKey } from './vmd.ts'

// three's axes and MMD's: a rotation (x, y, z, w) is (-x, -y, z, w) in the other, either way.
const flip = (q: { x: number; y: number; z: number; w: number }) => [-q.x, -q.y, q.z, q.w] as [number, number, number, number]

/** `m` as a VMD for a model named `model`. */
export function motionToVmd(m: CustomMotion, model: string) {
  const steps: { t: number; pose: JointPose }[] = [
    ...m.keys.map((k) => ({ t: k.t, pose: { ...m.pose, ...k.pose } })),
    { t: m.keys.length ? m.keys.at(-1)!.t + KEY_SETTLE_S : 0, pose: m.pose },
  ]
  const keys: VmdKey[] = []
  for (const s of steps) {
    const frame = Math.round(s.t * VMD_FPS)
    for (const [name, q] of posed(s.pose)) keys.push({ name, frame, rotation: flip(q) })
  }
  return writeVmd(model, keys)
}

/** A VMD's motion: its last frame is the pose she holds, the frames before it the keys on the way in. */
export function motionFromVmd(buf: ArrayBuffer | Uint8Array): CustomMotion {
  const tracks = new Map<string, { frame: number; q: Quaternion }[]>()
  for (const k of readVmd(buf)) {
    if (!JOINTS.test(k.name)) continue
    const [x, y, z, w] = flip({ x: k.rotation[0], y: k.rotation[1], z: k.rotation[2], w: k.rotation[3] })
    let list = tracks.get(k.name)
    if (!list) tracks.set(k.name, (list = []))
    list.push({ frame: k.frame, q: new Quaternion(x, y, z, w).normalize() })
  }
  for (const list of tracks.values()) list.sort((a, b) => a.frame - b.frame)
  let frames = [...new Set([...tracks.values()].flatMap((l) => l.map((k) => k.frame)))].sort((a, b) => a - b)
  if (!frames.length) return { pose: {}, keys: [] }
  frames = frames.filter((f) => f / VMD_FPS <= MAX_KEY_T + KEY_SETTLE_S)
  const last = frames.pop()!
  // Too many keys for a card: an even pick of them, the first always kept.
  if (frames.length > MAX_KEYS) frames = Array.from({ length: MAX_KEYS }, (_, i) => frames[Math.floor((i * frames.length) / MAX_KEYS)]!)
  const at = (frame: number) => {
    const out = new Map<string, Quaternion>()
    for (const [name, list] of tracks) {
      const i = list.findIndex((k) => k.frame >= frame)
      const a = list[Math.max(0, (i < 0 ? list.length : i) - 1)]!, b = list[i < 0 ? list.length - 1 : i]!
      out.set(name, b.frame === a.frame || b.frame <= frame ? b.q.clone() : a.q.clone().slerp(b.q, (frame - a.frame) / (b.frame - a.frame)))
    }
    return out
  }
  const pose = poseOf(at(last))
  const keys = frames.map((f) => {
    // A key keeps only what differs from the held pose: the rest of her stays as she holds it.
    const p = poseOf(at(f))
    for (const n of new Set([...Object.keys(p), ...Object.keys(pose)])) {
      const v = p[n] ?? [0, 0, 0], h = pose[n] ?? [0, 0, 0]
      if (v.every((x, i) => x === h[i])) delete p[n]
      else p[n] = v
    }
    return { t: Math.round((f / VMD_FPS) * 100) / 100, pose: p }
  })
  return { pose, keys }
}
