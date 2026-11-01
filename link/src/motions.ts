import { EMOTIONS, type CustomMotion, type JointPose, type Motions } from './protocol.ts'

// A card's custom motions come from imported files too: anything that isn't one is dropped, numbers are clamped.
// Turns keep a tenth of a degree (a hand placed by dragging moves visibly at a whole degree's shoulder turn), times a
// hundredth of a second (Blender's keys are 1/30 s apart).

// Room for a motion made in Blender: its keys come over as they are (a pose made in the studio has a few).
export const MAX_KEYS = 30
/** The latest a key can be, in seconds from the start of the emotion. */
export const MAX_KEY_T = 10
const MAX_JOINTS = 120
const JOINT_RE = /^[^\s<>"'&]{1,32}$/

const deg = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-180, Math.min(180, Math.round(v * 10) / 10)) : 0)

function cleanPose(raw: unknown): JointPose {
  const out: JointPose = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [name, v] of Object.entries(raw).slice(0, MAX_JOINTS)) {
    if (JOINT_RE.test(name) && Array.isArray(v) && v.length === 3) out[name] = [deg(v[0]), deg(v[1]), deg(v[2])]
  }
  return out
}

export function cleanMotions(raw: unknown): Motions {
  const out: Motions = {}
  if (!raw || typeof raw !== 'object') return out
  for (const e of EMOTIONS) {
    const m = (raw as Record<string, unknown>)[e] as Partial<CustomMotion> | undefined
    if (!m || typeof m !== 'object') continue
    const keys = (Array.isArray(m.keys) ? m.keys : [])
      .filter((k) => k && typeof k === 'object' && typeof k.t === 'number' && Number.isFinite(k.t))
      .slice(0, MAX_KEYS)
      .map((k) => ({ t: Math.max(0, Math.min(MAX_KEY_T, Math.round(k.t * 100) / 100)), pose: cleanPose(k.pose) }))
      .sort((a, b) => a.t - b.t)
    out[e] = { pose: cleanPose(m.pose), keys }
  }
  return out
}
