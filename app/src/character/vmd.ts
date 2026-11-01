// VMD, MMD's motion file, as far as her poses need it: bone keys (name, frame, rotation) read and written. Blender's
// MMD Tools reads and writes it, so it is how a pose goes to Blender and comes back. Positions, morphs, the camera and
// the rest are skipped on reading and left empty on writing. Little-endian; names are Shift-JIS, NUL-padded.

const MAGIC = 'Vocaloid Motion Data 0002'
const HEADER = 30
const MODEL_NAME = 20
const BONE_NAME = 15
const BONE_KEY = 111
/** At 30 frames a second, as MMD plays them. */
export const VMD_FPS = 30
/** A larger file isn't a pose or a short motion: refused before it is parsed. */
export const VMD_MAX_BYTES = 8 * 1024 * 1024

/** One bone key: a local rotation (x, y, z, w) in MMD's axes, relative to the model's bind pose. */
export type VmdKey = { name: string; frame: number; rotation: [number, number, number, number] }

/** Straight-line interpolation (control points 20 and 107 of 127), physics on: what MMD Tools writes by default. */
const LINEAR = [
  20, 20, 0, 0, 20, 20, 20, 20, 107, 107, 107, 107, 107, 107, 107, 107,
  20, 20, 20, 20, 20, 20, 20, 107, 107, 107, 107, 107, 107, 107, 107, 0,
  20, 20, 20, 20, 20, 20, 107, 107, 107, 107, 107, 107, 107, 107, 0, 0,
  20, 20, 20, 20, 20, 107, 107, 107, 107, 107, 107, 107, 107, 0, 0, 0,
]

let sjis: TextDecoder | undefined
const decoder = () => (sjis ??= new TextDecoder('shift_jis'))

function readName(bytes: Uint8Array) {
  const end = bytes.indexOf(0)
  return decoder().decode(end < 0 ? bytes : bytes.subarray(0, end))
}

/** Reads a VMD's bone keys. Throws on anything that isn't one. */
export function readVmd(buf: ArrayBuffer | Uint8Array): VmdKey[] {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  if (bytes.length > VMD_MAX_BYTES) throw new Error('too large for a motion')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < HEADER + MODEL_NAME + 4 || new TextDecoder('ascii').decode(bytes.subarray(0, MAGIC.length)) !== MAGIC) throw new Error('not a VMD motion')
  let at = HEADER + MODEL_NAME
  const count = view.getUint32(at, true)
  at += 4
  if (count * BONE_KEY > bytes.length - at) throw new Error('VMD cut short')
  const keys: VmdKey[] = []
  for (let i = 0; i < count; i++, at += BONE_KEY) {
    const r = at + BONE_NAME + 4 + 12
    keys.push({
      name: readName(bytes.subarray(at, at + BONE_NAME)),
      frame: view.getUint32(at + BONE_NAME, true),
      rotation: [view.getFloat32(r, true), view.getFloat32(r + 4, true), view.getFloat32(r + 8, true), view.getFloat32(r + 12, true)],
    })
  }
  return keys
}

// ---------------------------------------------------------------- writing

/** Character → its Shift-JIS bytes, built once by decoding every two-byte code (no encoder ships in the browser). */
let table: Map<string, number[]> | undefined
function sjisTable() {
  if (table) return table
  table = new Map()
  const dec = new TextDecoder('shift_jis', { fatal: true })
  const pair = new Uint8Array(2)
  for (let lead = 0x81; lead <= 0xfc; lead++) {
    if (lead > 0x9f && lead < 0xe0) continue
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail === 0x7f) continue
      pair[0] = lead
      pair[1] = trail
      try {
        const c = dec.decode(pair)
        if (c.length === 1 && !table.has(c)) table.set(c, [lead, trail])
      } catch {}
    }
  }
  for (let b = 0xa1; b <= 0xdf; b++) table.set(dec.decode(new Uint8Array([b])), [b])
  return table
}

/** `text` in Shift-JIS, cut to `max` bytes without splitting a character; a character it lacks becomes '?'. */
export function encodeSjis(text: string, max: number) {
  const out: number[] = []
  for (const c of text) {
    const code = c.charCodeAt(0)
    const b = code < 0x80 ? [code] : (sjisTable().get(c) ?? [0x3f])
    if (out.length + b.length > max) break
    out.push(...b)
  }
  return out
}

/** A VMD with `keys` on `model` (the name MMD shows; any model plays it). */
export function writeVmd(model: string, keys: VmdKey[]) {
  const bytes = new Uint8Array(HEADER + MODEL_NAME + 4 + keys.length * BONE_KEY + 5 * 4)
  const view = new DataView(bytes.buffer)
  bytes.set(new TextEncoder().encode(MAGIC))
  bytes.set(encodeSjis(model, MODEL_NAME), HEADER)
  let at = HEADER + MODEL_NAME
  view.setUint32(at, keys.length, true)
  at += 4
  for (const k of keys) {
    bytes.set(encodeSjis(k.name, BONE_NAME), at)
    view.setUint32(at + BONE_NAME, k.frame, true)
    const r = at + BONE_NAME + 4 + 12
    k.rotation.forEach((v, i) => view.setFloat32(r + i * 4, v, true))
    bytes.set(LINEAR, r + 16)
    at += BONE_KEY
  }
  // Morph, camera, light, self-shadow and IK keys: none (each a zero count, as MMD Tools writes them).
  return bytes
}
