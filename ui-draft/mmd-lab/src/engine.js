// Her motion, renderer-free: a stand-in skeleton (three.js bones, in three's right-handed axes, never drawn) that
// springs, poses, motions and the idle layer move. main.js copies its rotations into the real MMD model each frame.
// Sources: VPD poses, a VMD motion, Mixamo FBX, Bandai BVH and VRoid VRMA, the last three retargeted live.

import * as THREE from 'three'
import { BVHLoader } from 'three/addons/loaders/BVHLoader.js'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js'

export const WAIST_UP = /^(上半身|上半身2|首|頭|両目|[左右]目|[左右](肩|腕|腕捩|ひじ|手捩|手首)|[左右](親指|人指|中指|薬指|小指)[０-３])$/
const url = (path) => path.split('/').map(encodeURIComponent).join('/')

// ---------------------------------------------------------------- the stand-in skeleton

/**
 * Builds three.js bones for an MMD model from `bones`: [{ name, parent (index or -1), rest: [x, y, z] }], rest
 * positions relative to the parent in three's axes. Returns name → bone, and each bone's rest world position.
 */
export function standIn(bones) {
  const root = new THREE.Group()
  const made = bones.map((b) => Object.assign(new THREE.Bone(), { name: b.name }))
  bones.forEach((b, i) => {
    made[i].position.fromArray(b.rest)
    ;(b.parent >= 0 ? made[b.parent] : root).add(made[i])
  })
  root.updateMatrixWorld(true)
  const bone = {}, restPos = {}
  for (const b of made) (bone[b.name] = b), (restPos[b.name] = b.getWorldPosition(new THREE.Vector3()))
  return { root, bone, restPos }
}

// ---------------------------------------------------------------- springs (poses)

// Each waist-up bone chases its target with a critically damped spring; the chest leads, fingers come last.
function feel(name) {
  if (/^上半身/.test(name)) return [5.0, 0]
  if (/首|肩$/.test(name)) return [4.6, 40]
  if (/頭|腕$/.test(name)) return [4.2, 80]
  if (/ひじ|腕捩/.test(name)) return [3.8, 140]
  if (/手首|手捩/.test(name)) return [3.4, 200]
  return [3.2, 260]
}
const err = new THREE.Quaternion(), dq = new THREE.Quaternion(), axis = new THREE.Vector3()
function stepSpring(r, dt) {
  err.copy(r.target).multiply(dq.copy(r.q).invert())
  if (err.w < 0) err.set(-err.x, -err.y, -err.z, -err.w)
  const angle = 2 * Math.acos(Math.min(1, err.w))
  const s = Math.sqrt(1 - err.w * err.w)
  axis.set(err.x, err.y, err.z).multiplyScalar(s > 1e-6 ? angle / s : 0)
  r.vel.addScaledVector(axis, r.w * r.w * dt).multiplyScalar(1 - 2 * r.w * dt)
  const turn = r.vel.length() * dt
  if (turn > 1e-7) r.q.premultiply(dq.setFromAxisAngle(axis.copy(r.vel).normalize(), turn)).normalize()
}

// ---------------------------------------------------------------- retargeting

// Mixamo → MMD: each target bone takes its source bone's change in direction since the bind pose, measured from
// the hips (so her legs stay put), and an alignment for the different rest poses (Mixamo's arms are straight out,
// hers rest ~29° down): target world = (source now · source bind⁻¹) · A, A turning her rest direction onto theirs.
const SIDE = { L: ['左', 'Left'], R: ['右', 'Right'] }
const RETARGET = [
  ['上半身', 'Spine1', '上半身2', 'Spine2'],
  ['上半身2', 'Spine2', '首', 'Neck'],
  ['首', 'Neck', '頭', 'Head'],
  ['頭', 'Head', null, 'HeadTop_End'],
]
for (const [j, e] of Object.values(SIDE)) {
  RETARGET.push([`${j}肩`, `${e}Shoulder`, `${j}腕`, `${e}Arm`], [`${j}腕`, `${e}Arm`, `${j}ひじ`, `${e}ForeArm`], [`${j}ひじ`, `${e}ForeArm`, `${j}手首`, `${e}Hand`], [`${j}手首`, `${e}Hand`, `${j}中指１`, `${e}HandMiddle1`])
  const fingers = [['親指', 'Thumb', ['０', '１', '２'], [1, 2, 3]], ['人指', 'Index', ['１', '２', '３'], [1, 2, 3]], ['中指', 'Middle', ['１', '２', '３'], [1, 2, 3]], ['薬指', 'Ring', ['１', '２', '３'], [1, 2, 3]], ['小指', 'Pinky', ['１', '２', '３'], [1, 2, 3]]]
  for (const [jf, ef, jn, en] of fingers) for (let k = 0; k < 3; k++) RETARGET.push([`${j}${jf}${jn[k]}`, `${e}Hand${ef}${en[k]}`, k < 2 ? `${j}${jf}${jn[k + 1]}` : null, `${e}Hand${ef}${en[k] + 1}`])
}
const SOURCE_NAMES = [...new Set(RETARGET.map((x) => x[1]).concat('Hips'))]

// Each source's bone for a Mixamo name. A name a source lacks is skipped, and her bone keeps its spring pose:
// Bandai has no fingers, so her hands keep their relaxed curl.
const BANDAI = { Hips: 'Hips', Spine1: 'Spine', Spine2: 'Chest', Neck: 'Neck', Head: 'Head' }
const bandaiName = (n) => BANDAI[n] ?? n.replace(/^(Left|Right)(Shoulder|Arm|ForeArm|Hand)$/, (_, s, p) => `${{ Shoulder: 'Shoulder', Arm: 'UpperArm', ForeArm: 'LowerArm', Hand: 'Hand' }[p]}_${s[0]}`)
const VRM_FINGER = { Thumb: ['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal'], Index: ['IndexProximal', 'IndexIntermediate', 'IndexDistal'], Middle: ['MiddleProximal', 'MiddleIntermediate', 'MiddleDistal'], Ring: ['RingProximal', 'RingIntermediate', 'RingDistal'], Pinky: ['LittleProximal', 'LittleIntermediate', 'LittleDistal'] }
function vrmName(n) {
  const base = { Hips: 'hips', Spine1: 'spine', Spine2: 'chest', Neck: 'neck', Head: 'head' }[n]
  if (base) return base
  const m = /^(Left|Right)(?:(Shoulder|Arm|ForeArm|Hand)|Hand(Thumb|Index|Middle|Ring|Pinky)(\d))$/.exec(n)
  if (!m) return undefined
  const side = m[1].toLowerCase()
  if (m[2]) return side + { Shoulder: 'Shoulder', Arm: 'UpperArm', ForeArm: 'LowerArm', Hand: 'Hand' }[m[2]]
  const f = VRM_FINGER[m[3]][Number(m[4]) - 1]
  return f && side + f
}

/**
 * `src`: Mixamo name → the source's node; `root`: what the clip animates. Returns t → her bone name → local rotation.
 * The reference ("bind") is the skeleton's rest pose, a standing T-pose for Mixamo and VRM. `fromFirstFrame` uses the
 * clip's first frame instead: a Bandai BVH rests lying down (spine along +X) and stands only through a constant ~90°
 * on its hips in every frame, which taking out the hips' movement would also take out.
 */
function retargetSampler(rig, root, clip, src, { fromFirstFrame = false } = {}) {
  const { bone, restPos } = rig
  const hips = src.Hips
  const mixer = new THREE.AnimationMixer(root)
  const action = mixer.clipAction(clip)
  if (fromFirstFrame) (action.play(), mixer.setTime(0))
  // Only the hips' own movement is taken out (her legs don't follow): world · (hips at bind · hips now⁻¹). Measuring
  // in the hips' axes instead would bake the hips bone's rest tilt into her spine as a big lean.
  root.updateMatrixWorld(true)
  const hipsBind = hips.getWorldQuaternion(new THREE.Quaternion())
  // Sources face different ways: a turn about "up" that puts their left side where hers is.
  const side = (l, r) => l.clone().sub(r).setY(0).normalize()
  const at = (o) => o.getWorldPosition(new THREE.Vector3())
  const face = src.LeftArm && src.RightArm
    ? new THREE.Quaternion().setFromUnitVectors(side(at(src.LeftArm), at(src.RightArm)), side(restPos['左腕'], restPos['右腕']))
    : new THREE.Quaternion()
  const relQ = (b, out) => out.copy(face).multiply(hipsBind).multiply(hips.getWorldQuaternion(new THREE.Quaternion()).invert()).multiply(b.getWorldQuaternion(new THREE.Quaternion()))
  const relDir = (from, to) => at(to).sub(at(from)).normalize().applyQuaternion(face)
  const maps = RETARGET.filter(([t, s]) => bone[t] && src[s]).map(([t, s, tChild, sChild]) => {
    const bind = relQ(src[s], new THREE.Quaternion())
    let A = new THREE.Quaternion()
    const sTo = src[sChild]
    if (sTo && tChild && restPos[tChild]) A = new THREE.Quaternion().setFromUnitVectors(restPos[tChild].clone().sub(restPos[t]).normalize(), relDir(src[s], sTo))
    return { t, b: bone[t], s: src[s], bindInv: bind.clone().invert(), A }
  })
  action.play()
  const out = new Map(maps.map((m) => [m.t, new THREE.Quaternion()]))
  const now = new THREE.Quaternion()
  return (t) => {
    mixer.setTime(t)
    root.updateMatrixWorld(true)
    // Wanted world rotations (her frame = the hips frame: nothing below 上半身 moves), parents first.
    const worlds = new Map()
    for (const m of maps) worlds.set(m.t, relQ(m.s, now).clone().multiply(m.bindInv).multiply(m.A))
    // A bone's world rotation: wanted if mapped, else its parent's world times its own local (twist bones: rest).
    const worldOf = (b) => worlds.get(b.name) ?? (b.parent?.isBone ? worldOf(b.parent).clone().multiply(b.quaternion) : b.quaternion.clone())
    for (const m of maps) out.get(m.t).copy(worldOf(m.b.parent).invert().multiply(worlds.get(m.t)))
    return out
  }
}

// VMD (MMD motion): values are local rotations from the rest pose, sampled straight off the clip's tracks.
function vmdSampler(rig, clip) {
  const tracks = clip.tracks
    .map((t) => ({ name: /^\.bones\[(.+)\]\.quaternion$/.exec(t.name)?.[1], t }))
    .filter((x) => x.name && WAIST_UP.test(x.name) && rig.bone[x.name])
    .map((x) => ({ name: x.name, interp: x.t.createInterpolant(new Float32Array(4)) }))
  const out = new Map(tracks.map((x) => [x.name, new THREE.Quaternion()]))
  return (t) => {
    for (const x of tracks) out.get(x.name).fromArray(x.interp.evaluate(t))
    return out
  }
}

// ---------------------------------------------------------------- loading sources

/** One loader per source kind. Each resolves to { pose: Map } (a still) or { sample, duration } (a motion). */
export function sources(rig) {
  const mmd = new MMDLoader()
  const fbx = new FBXLoader()
  const bvh = new BVHLoader()
  const gltf = new GLTFLoader()
  // three's VMD builder only reads bone names and rest positions, and morph names: the stand-in is enough.
  const fakeMesh = { skeleton: { bones: Object.values(rig.bone), getBoneByName: (n) => rig.bone[n] }, morphTargetDictionary: {} }
  return {
    vpd: (path) => new Promise((ok, fail) => mmd.loadVPD(url(path), false, (vpd) => {
      const pose = new Map()
      for (const b of vpd.bones) if (WAIST_UP.test(b.name) && rig.bone[b.name]) pose.set(b.name, new THREE.Quaternion(...b.quaternion))
      ok({ pose, partial: !pose.has('上半身') })
    }, undefined, fail)),
    vmd: (path) => new Promise((ok, fail) => mmd.loadAnimation(url(path), fakeMesh, (clip) => ok({ sample: vmdSampler(rig, clip), duration: clip.duration }), undefined, fail)),
    fbx: (path) => fbx.loadAsync(url(path)).then((group) => {
      const clip = group.animations[0]
      // three's FBXLoader drops the colon: "mixamorig:LeftArm" arrives as "mixamorigLeftArm".
      const src = {}
      group.traverse((o) => o.isBone && (src[o.name.replace(/^mixamorig\d*:?/, '')] = o))
      return { sample: retargetSampler(rig, group, clip, src), duration: clip.duration }
    }),
    bvh: (path) => bvh.loadAsync(url(path)).then((res) => {
      const root = new THREE.Group()
      root.add(res.skeleton.bones[0])
      const byName = Object.fromEntries(res.skeleton.bones.map((b) => [b.name, b]))
      const src = {}
      for (const n of SOURCE_NAMES) if (byName[bandaiName(n)]) src[n] = byName[bandaiName(n)]
      return { sample: retargetSampler(rig, root, res.clip, src, { fromFirstFrame: true }), duration: res.clip.duration }
    }),
    vrma: (path) => gltf.loadAsync(url(path)).then(async (g) => {
      const human = g.parser.json.extensions?.VRMC_vrm_animation?.humanoid?.humanBones ?? {}
      const src = {}
      for (const n of SOURCE_NAMES) {
        const v = vrmName(n)
        if (v && human[v]) src[n] = await g.parser.getDependency('node', human[v].node)
      }
      return { sample: retargetSampler(rig, g.scene, g.animations[0], src), duration: g.animations[0].duration }
    }),
  }
}

// ---------------------------------------------------------------- the engine

const euler = new THREE.Euler(), idleQ = new THREE.Quaternion(), mq = new THREE.Quaternion(), beatQ = new THREE.Quaternion()
// Always on top: breathing, a slow sway, small head movements.
function idle(name, t) {
  const tau = Math.PI * 2
  // A slow weight shift at the hips (leg IK keeps her feet planted, so the knees give a little); the upper body
  // leans back the other way so her head stays level. It is what sets the skirt and hair swinging.
  const hip = 0.022 * Math.sin((tau * t) / 6.7)
  const v = name === '下半身' ? [0, 0.01 * Math.sin((tau * t) / 8.3), hip]
    : name === '上半身2' ? [0.018 * Math.sin((tau * t) / 4.2), 0, 0]
    : name === '上半身' ? [0, 0.012 * Math.sin((tau * t) / 9.1), 0.01 * Math.sin((tau * t) / 7.3) - 0.8 * hip]
      : name === '頭' ? [0.012 * Math.sin((tau * t) / 6.1), 0.025 * Math.sin((tau * t) / 9.7), 0.01 * Math.sin((tau * t) / 11.3)]
        : null
  return v ? idleQ.setFromEuler(euler.set(v[0], v[1], v[2])) : null
}

/**
 * The engine on a stand-in rig: poses (springs), motions (blended over them), the idle layer, blinking and the face.
 * `update(dt)` moves the stand-in; read `controlled` (bones it drives) and `face` (morph name → weight) after it.
 */
export function createEngine(rig, { onChange } = {}) {
  const { bone } = rig
  // Waist up, plus the lower body for the idle weight shift (nothing poses it, so it springs to rest).
  const rigs = Object.keys(bone).filter((n) => WAIST_UP.test(n) || n === '下半身').map((n) => {
    const [w, delay] = feel(n)
    return { name: n, b: bone[n], q: new THREE.Quaternion(), vel: new THREE.Vector3(), target: new THREE.Quaternion(), next: null, w, delay }
  })
  const poses = {}, motions = {}
  let current = null, motion = null, faceTarget = {}, faceLater = null
  const face = {}
  // Eyelids closed by the face (まばたき in a face), apart from blinking: the more closed of the two shows.
  let t = 0, nextBlink = 2, blinkT = -1, lids = 0

  function pose(id, instant = false) {
    const p = poses[id]
    const now = performance.now()
    for (const r of rigs) {
      const q = p.pose.get(r.name)
      if (!q && p.partial) continue
      const target = q ?? new THREE.Quaternion()
      if (instant) (r.q.copy(target), r.target.copy(target), r.vel.set(0, 0, 0), (r.next = null))
      else r.next = { at: now + r.delay, q: target.clone() }
    }
    if (!p.partial) (faceTarget = p.face ?? {}), (current = id), (faceLater = null)
    onChange?.(id)
  }
  function play(id) {
    const m = motions[id]
    motion = { id, ...m, t: 0, w: motion ? motion.w : 0, out: false }
    if (m.face) (faceTarget = m.face), (faceLater = null)
    onChange?.(id)
  }
  function stop() {
    if (motion) motion.out = true
  }
  /** An emote: its stance over the relaxed arms (or its arm pose, e.g. `think`, once registered), its face, its beat. */
  let beat = null
  function emote(name) {
    const e = EMOTES[name]
    const base = (e.arms && poses[e.arms]?.pose) || poses.relaxed?.pose || new Map()
    const target = new Map(base)
    for (const [n, v] of Object.entries(e.stance)) {
      const q = target.get(n)?.clone() ?? new THREE.Quaternion()
      target.set(n, q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(v[0], v[1], v[2], 'YXZ'))))
    }
    const id = `emote:${name}`
    poses[id] = { pose: target, face: e.face }
    stop()
    pose(id)
    beat = e.beat ? { ...BEATS[e.beat], t: 0 } : null
    faceLater = e.then ? { at: t + e.then.after, face: e.then.face } : null
  }
  function blink(dt) {
    if (blinkT < 0 && t > nextBlink) blinkT = 0
    if (blinkT < 0) return 0
    blinkT += dt
    const v = blinkT < 0.07 ? blinkT / 0.07 : blinkT < 0.16 ? 1 - (blinkT - 0.07) / 0.09 : 0
    if (blinkT >= 0.16) (blinkT = -1), (nextBlink = t + 2 + Math.random() * 4)
    return v
  }

  function update(dt) {
    t += dt
    const now = performance.now()
    for (const r of rigs) {
      if (r.next && now >= r.next.at) (r.target.copy(r.next.q), (r.next = null))
      for (let k = 0, n = Math.max(4, Math.ceil(dt / 0.008)); k < n; k++) stepSpring(r, dt / n)
      r.b.quaternion.copy(r.q)
    }
    if (motion) {
      motion.t += dt
      if (!motion.loop && motion.t >= motion.duration - 0.35) motion.out = true
      motion.w += ((motion.out ? 0 : 1) - motion.w) * Math.min(1, dt * 5)
      const frame = motion.sample(motion.loop ? motion.t % motion.duration : Math.min(motion.t, motion.duration))
      for (const [name, q] of frame) bone[name]?.quaternion.slerp(mq.copy(q), motion.w)
      if (motion.out && motion.w < 0.01) {
        motion = null
        faceTarget = poses[current]?.face ?? {}
        onChange?.(current)
      }
    }
    if (beat) {
      beat.t += dt
      const u = beat.t / beat.d
      if (u >= 1) beat = null
      else for (const [n, v] of Object.entries(beat.f(u))) bone[n]?.quaternion.multiply(beatQ.setFromEuler(euler.set(v[0], v[1], v[2], 'YXZ')))
    }
    for (const name of ['下半身', '上半身', '上半身2', '頭']) {
      const q = idle(name, t)
      if (q && bone[name]) bone[name].quaternion.multiply(q)
    }
    if (faceLater && t >= faceLater.at) (faceTarget = faceLater.face), (faceLater = null)
    const ease = Math.min(1, dt * 6)
    for (const n of new Set([...Object.keys(faceTarget), ...Object.keys(face)])) {
      if (n !== 'まばたき') face[n] = (face[n] ?? 0) + ((faceTarget[n] ?? 0) - (face[n] ?? 0)) * ease
    }
    lids += ((faceTarget['まばたき'] ?? 0) - lids) * ease
    face['まばたき'] = Math.max(lids, blink(dt))
  }

  return { rigs, controlled: rigs.map((r) => r.b), poses, motions, face, pose, play, stop, emote, update, get current() { return motion?.id ?? current } }
}

// ---------------------------------------------------------------- emotes: face + stance + an optional beat

// Rem's Live2D emotions (app/src/character/motions.ts), as an MMD face, a held stance (small turns of the head,
// neck, shoulders and upper body, on top of the relaxed arms) and an optional one-shot beat. Angles are radians in
// three's axes, the bone's parent space: x +down / forward, y turn, z tilt; 左肩 z + raises (右肩 mirrors).
const S = (o) => o // stance: bone → [x, y, z]
// Faces combine Reine's morphs the way MMD faces are built: brows + eyes + mouth, plus an extra (blush, sweat,
// tears, the anger mark). Morph names are the model's own (PMX); other models may name a few differently.
export const EMOTES = {
  normal: { face: { にこり: 0.3, にこり口: 0.35, 口角上げ: 0.2 }, stance: S({}) },
  smile: { face: { にこり: 0.6, 笑い: 0.35, 下まつ毛上げ: 0.3, にこり口: 0.8, 口角上げ: 0.3 }, stance: S({ 頭: [0, 0, 0.05] }) },
  happy: { face: { にこり: 0.8, 笑い: 0.8, 笑い口: 0.7, 口角上げ: 0.4, ハイライト拡大: 0.3, 照れ: 0.25 }, stance: S({ 頭: [-0.04, 0, 0.08] }), beat: 'bob' },
  delighted: { face: { にこり: 1, 笑い: 1, 大笑い: 0.8, 口角上げ: 0.5, 照れ: 0.5 }, stance: S({ 頭: [-0.06, 0, 0.12], 左肩: [0, 0, 0.05], 右肩: [0, 0, -0.05] }), beat: 'bounce' },
  nod: { face: { にこり: 0.5, 笑い: 0.3, にこり口: 0.6 }, stance: S({}), beat: 'nod' },
  // Mulling it over: head down and a little turned, serious brows knitted with troubled ones (puzzled), eyes lowered,
  // one mouth corner up: a lopsided "hmm".
  think: { face: { 真面目: 0.5, 困る: 0.5, 寄せ: 0.4, 瞳_下: 0.3, 結ぶ: 0.6, 口角下げ: 0.2, 左口角上げ: 0.35 }, stance: S({ 頭: [0.16, -0.08, 0.06], 首: [0.05, -0.03, 0] }), arms: 'think' },
  worried: { face: { 困る２: 0.9, 寄せ: 0.4, 目尻_下げ: 0.4, '▲': 0.45, 口角下げ: 0.4, 汗: 0.7 }, stance: S({ 頭: [0.08, 0, -0.06], 上半身: [0.03, 0, 0], 左肩: [0, 0, 0.05], 右肩: [0, 0, -0.05] }) },
  serious: { face: { 真面目２: 0.8, 寄せ: 0.3, キリッ: 0.6, 結ぶ: 0.7 }, stance: S({ 頭: [0.04, 0, 0], 上半身2: [-0.02, 0, 0] }), beat: 'nodOnce' },
  // Shock: both shoulders up and held there, the head pulled back.
  surprised: { face: { 上: 0.9, びっくり: 0.9, 瞳小: 0.5, お: 0.8 }, stance: S({ 頭: [-0.06, 0, 0], 左肩: [0, 0, 0.16], 右肩: [0, 0, -0.16] }), beat: 'startle' },
  shy: { face: { 照れ: 1, 困る: 0.6, はぅ: 0.5, 瞳_下: 0.35, '▲': 0.4 }, stance: S({ 頭: [0.15, 0.08, 0.12], 首: [0.04, 0, 0], 左肩: [0, 0, 0.06], 右肩: [0, 0, -0.06] }) },
  // "Hmph": she turns away ~60°, spread down the body like a real turn (head ~32°, neck ~14°, chest ~8°, waist ~5°),
  // chin up, the far shoulder hunched, and her eyes glancing back at you.
  // Once the turn settles she shuts her eyes on you (`then`: a second face after a delay).
  pout: {
    face: { 怒り: 0.4, じと目: 0.35, 瞳_右: 0.55, ムッ: 1, 左頬ふくらまし: 0.8, 右頬ふくらまし: 0.8, 照れ: 0.4 },
    then: { after: 0.6, face: { 怒り: 0.45, まばたき: 1, ムッ: 1, 左頬ふくらまし: 0.8, 右頬ふくらまし: 0.8, 照れ: 0.45 } },
    stance: S({ 頭: [-0.12, 0.55, 0.08], 首: [-0.03, 0.25, 0], 上半身2: [0, 0.14, 0], 上半身: [0, 0.08, 0], 左肩: [0, 0, 0.06] }),
    beat: 'hmph',
  },
  sad: { face: { 困る２: 1, 目尻_下げ: 0.5, なごみ: 0.35, 瞳_下: 0.4, 口角下げ: 0.7, ハイライト消: 0.2 }, stance: S({ 頭: [0.2, 0, 0.05], 上半身: [0.05, 0, 0], 上半身2: [0.04, 0, 0], 左肩: [0, 0, -0.05], 右肩: [0, 0, 0.05] }) },
  angry: { face: { 怒り２: 1, 寄せ: 0.6, キリッ: 0.5, 瞳小: 0.3, くいしばる: 0.6, ムカッ: 1 }, stance: S({ 頭: [0.06, 0, 0], 上半身: [0.05, 0, 0], 左肩: [0, 0, 0.08], 右肩: [0, 0, -0.08] }), beat: 'shake' },
  sigh: { face: { 困る: 0.5, なごみ_2: 0.7, '▲': 0.3, 口角下げ: 0.3 }, stance: S({ 頭: [0.08, 0, 0] }), beat: 'sigh' },
  teary: { face: { 困る２: 1, 目尻_下げ: 0.5, ハイライト拡大: 0.6, 涙: 1, '▲_2': 0.5, 照れ: 0.5 }, stance: S({ 頭: [0.14, 0, 0.1], 上半身: [0.03, 0, 0], 左肩: [0, 0, 0.04], 右肩: [0, 0, -0.04] }) },
}

// Beats: one-shot movements added on top of the stance. Each is a duration and bone → [x, y, z] at time u (0 – 1).
const bump = (u, a, b) => (u <= a || u >= b ? 0 : Math.sin((Math.PI * (u - a)) / (b - a)))
const BEATS = {
  nod: { d: 1.1, f: (u) => ({ 頭: [0.2 * (bump(u, 0, 0.45) + 0.7 * bump(u, 0.45, 0.9)), 0, 0], 首: [0.06 * (bump(u, 0, 0.45) + 0.7 * bump(u, 0.45, 0.9)), 0, 0] }) },
  nodOnce: { d: 0.7, f: (u) => ({ 頭: [0.12 * bump(u, 0, 1), 0, 0] }) },
  bob: { d: 1.2, f: (u) => ({ 頭: [0, 0, 0.06 * Math.sin(2 * Math.PI * u) * (1 - u)], 上半身2: [-0.03 * bump(u, 0, 0.5), 0, 0] }) },
  bounce: {
    d: 1.0,
    f: (u) => {
      const b = bump(u, 0, 0.35) + 0.6 * bump(u, 0.35, 0.7)
      return { 上半身: [-0.04 * b, 0, 0], 左肩: [0, 0, 0.08 * b], 右肩: [0, 0, -0.08 * b], 頭: [-0.05 * b, 0, 0] }
    },
  },
  startle: {
    d: 0.9,
    f: (u) => {
      const k = u < 0.15 ? u / 0.15 : Math.max(0, 1 - (u - 0.15) / 0.85)
      return { 頭: [-0.12 * k, 0, 0], 上半身2: [-0.06 * k, 0, 0], 左肩: [0, 0, 0.2 * k], 右肩: [0, 0, -0.2 * k] }
    },
  },
  // Only the turn: it overshoots a little and settles. No pitch here, which read as a nod; the chin-up is the stance.
  hmph: { d: 0.8, f: (u) => ({ 頭: [0, 0.12 * bump(u, 0, 0.6) - 0.03 * bump(u, 0.6, 1), 0], 上半身2: [0, 0.05 * bump(u, 0, 0.7), 0] }) },
  shake: { d: 0.8, f: (u) => ({ 頭: [0, 0.1 * Math.sin(3 * 2 * Math.PI * u) * (1 - u), 0] }) },
  sigh: {
    d: 2.4,
    f: (u) => {
      const inhale = bump(u, 0, 0.4), slump = bump(u, 0.35, 1)
      return { 上半身2: [-0.05 * inhale + 0.07 * slump, 0, 0], 頭: [0.12 * slump, 0, 0], 左肩: [0, 0, 0.06 * inhale - 0.05 * slump], 右肩: [0, 0, -0.06 * inhale + 0.05 * slump] }
    },
  },
}

/** Her base pose: arms down at her sides (three's axes, the bone's parent space), mirrored left to right. */
export function relaxedPose() {
  const mirror = ([x, y, z]) => [x, -y, -z]
  const L = { 左腕: [0, -0.12, -0.8], 左ひじ: [0, -0.28, 0], 左手首: [0, 0, 0.05] }
  const pose = new Map()
  for (const [n, v] of Object.entries(L)) {
    const order = /腕$/.test(n) ? 'XYZ' : 'YXZ'
    pose.set(n, new THREE.Quaternion().setFromEuler(euler.set(v[0], v[1], v[2], order)))
    const m = mirror(v)
    pose.set(n.replace('左', '右'), new THREE.Quaternion().setFromEuler(euler.set(m[0], m[1], m[2], order)))
  }
  return pose
}
