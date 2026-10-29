// The lab's viewer: babylon-mmd draws Reine with MMD's own shading and outlines and runs her IK, inherited (付与)
// rotations and Bullet physics. engine.js decides her pose on a stand-in skeleton; every frame, before her physics
// step, its rotations go into her bones' local rotations, which babylon-mmd reads as its animation input.

import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { Engine } from '@babylonjs/core/Engines/engine'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader'
import { Space } from '@babylonjs/core/Maths/math.axis'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Scene } from '@babylonjs/core/scene'
import { RegisterMmdOutlineRenderer } from 'babylon-mmd/esm/Loader/mmdOutlineRenderer.pure'
import { MmdStandardMaterialBuilder } from 'babylon-mmd/esm/Loader/mmdStandardMaterialBuilder'
import { RegisterPmxLoader } from 'babylon-mmd/esm/Loader/pmxLoader.pure'
import { MmdWasmInstanceTypeSPR } from 'babylon-mmd/esm/Runtime/Optimized/InstanceType/singlePhysicsRelease'
import { GetMmdWasmInstance } from 'babylon-mmd/esm/Runtime/Optimized/mmdWasmInstance'
import { MultiPhysicsRuntime } from 'babylon-mmd/esm/Runtime/Optimized/Physics/Bind/Impl/multiPhysicsRuntime'
import { MotionType } from 'babylon-mmd/esm/Runtime/Optimized/Physics/Bind/motionType'
import { PhysicsStaticPlaneShape } from 'babylon-mmd/esm/Runtime/Optimized/Physics/Bind/physicsShape'
import { RigidBody } from 'babylon-mmd/esm/Runtime/Optimized/Physics/Bind/rigidBody'
import { RigidBodyConstructionInfo } from 'babylon-mmd/esm/Runtime/Optimized/Physics/Bind/rigidBodyConstructionInfo'
import { MmdBulletPhysics } from 'babylon-mmd/esm/Runtime/Optimized/Physics/mmdBulletPhysics'
import { MmdRuntime } from 'babylon-mmd/esm/Runtime/mmdRuntime'
import { createEngine, relaxedPose, sources, standIn } from './engine.js'

RegisterPmxLoader()
RegisterMmdOutlineRenderer()

const MODEL = 'assets/reine/PavoliaReine.pmx'
const VPD_POSES = [
  { file: 'LivlierPoseRD.vpd', label: 'Livelier', hint: 'Reggie · full pose' },
  { file: 'StandDejectedTiedRD.vpd', label: 'Dejected', hint: 'Reggie · full pose' },
  { file: 'Standing 1 -Stellas Shoujo Walk.vpd', label: 'Shoujo stand', hint: 'Reggie · full pose' },
  { file: 'LeftArmRelaxedRD.vpd', label: 'Left arm relaxed', hint: 'Reggie · left arm only, layers on' },
  { file: 'RightArmRelaxedRD.vpd', label: 'Right arm relaxed', hint: 'Reggie · right arm only, layers on' },
]
// Mixamo files: `still` ones are single poses (sampled into a spring pose); the rest play as motions.
const FBX = [
  { file: 'Idle.fbx', label: 'Idle', hint: 'Mixamo · loops', loop: true, face: {} },
  { file: 'Idle (1).fbx', label: 'Idle 2', hint: 'Mixamo · loops', loop: true, face: {} },
  { file: 'Standing Greeting.fbx', label: 'Greeting', hint: 'Mixamo · once', face: { 笑い: 0.8, にこり口: 1 } },
  { file: 'Female Standing Pose(could be use as teasing).fbx', label: 'Teasing', hint: 'Mixamo · still pose', still: true, face: { にひひ: 0.8, じと目: 0.4 } },
]
const VMD = [{ file: '執事お辞儀.vmd', label: 'Butler bow', hint: 'MMD · once', face: { にこり口: 0.8, 笑い: 0.5 } }]
// The few whole-body clips worth keeping beside the emotes: VRoid's, made for anime characters. Bandai's actors
// clipped through her and moved too stiffly; Rem's emotions are the emotes now (face + stance + beat).
const REM_SET = [
  { key: 'greet', label: 'Greeting', from: 'VRoid VRMA_02', vrma: 'VRMA_02.vrma', face: { 笑い: 0.8, にこり口: 1 } },
  { key: 'peace', label: 'Peace sign', from: 'VRoid VRMA_03', vrma: 'VRMA_03.vrma', face: { 笑い: 1, にこり口: 1, 照れ: 0.4 } },
]

const status = document.getElementById('status')
const state = (window.__state = { loaded: false, assets: false })

// ---------------------------------------------------------------- scene
const canvas = document.getElementById('canvas')
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true, antialias: true }, true)
const scene = new Scene(engine)
scene.clearColor = new Color4(0.043, 0.051, 0.086, 1)
scene.ambientColor = new Color3(0.5, 0.5, 0.5)
// MMD models face -Z, so the camera starts on that side (alpha -90°).
const camera = new ArcRotateCamera('camera', -Math.PI / 2, Math.PI / 2.05, 26, new Vector3(0, 15.2, 0), scene)
camera.fov = 0.52
camera.minZ = 0.5
camera.wheelPrecision = 20
camera.attachControl(canvas, true)
const VIEWS = { waist: [-Math.PI / 2, 26, 15.2], full: [-Math.PI / 2, 46, 10], side: [0, 26, 15.2], face: [-Math.PI / 2, 10, 18.6] }
const look = (k) => {
  const [alpha, radius, y] = VIEWS[k]
  camera.alpha = alpha
  camera.beta = Math.PI / 2.05
  camera.radius = radius
  camera.target.set(0, y, 0)
}
// The lighting babylon-mmd's examples use: a soft fill from above, and a key light that casts her self-shadows.
const fill = new HemisphericLight('fill', new Vector3(0, 1, 0), scene)
fill.intensity = 0.3
fill.specular.set(0, 0, 0)
fill.groundColor.set(1, 1, 1)
const key = new DirectionalLight('key', new Vector3(0.5, -1, 1), scene)
key.intensity = 0.7
key.autoCalcShadowZBounds = true
const shadows = new ShadowGenerator(1024, key, true)
shadows.transparencyShadow = true
shadows.usePercentageCloserFiltering = true
shadows.forceBackFacesOnly = true
shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM
shadows.frustumEdgeFalloff = 0.1
addEventListener('resize', () => engine.resize())

// ---------------------------------------------------------------- her, physics, and the bridge to the engine
const wasm = await GetMmdWasmInstance(new MmdWasmInstanceTypeSPR())
const physics = new MultiPhysicsRuntime(wasm)
physics.setGravity(new Vector3(0, -98, 0)) // MMD's scale: ten times Earth's
physics.register(scene)
const mmdRuntime = new MmdRuntime(scene, new MmdBulletPhysics(physics))
mmdRuntime.register(scene)
const floor = new RigidBodyConstructionInfo(physics.wasmInstance)
floor.motionType = MotionType.Static
floor.shape = new PhysicsStaticPlaneShape(physics, new Vector3(0, 1, 0), 0)
physics.addRigidBodyToGlobal(new RigidBody(physics, floor))

const container = await LoadAssetContainerAsync(MODEL, scene, {
  pluginOptions: { mmdmodel: { materialBuilder: new MmdStandardMaterialBuilder(), loggingEnabled: false } },
  onProgress: (e) => e.lengthComputable && (status.textContent = `Loading model… ${Math.round((e.loaded / e.total) * 100)}%`),
})
container.addAllToScene()
const modelMesh = container.rootNodes[0]
for (const m of modelMesh.metadata.meshes) m.receiveShadows = true
shadows.addShadowCaster(modelMesh)
const model = mmdRuntime.createMmdModel(modelMesh)
window.__model = model
// Her necklace's small dangling trinkets (acce_small_*) never settle: measured holding still, they kept moving up to
// 6× more per frame than anything else near the neck, bumping her collar and neck colliders. They follow their bones
// instead (state 0: the body is moved by its bone, not simulated); at their size nobody misses the swing. The
// necklace they hang from (neck_acce_1) has to follow too: under a simulated parent, babylon-mmd keeps a turned-off
// body dynamic and only pushes it toward its bone, so it still collides and buzzes.
const STILL = /^acce_small_|^neck_acce_/
for (const b of model.runtimeBones) if (STILL.test(b.name)) for (const i of b.rigidBodyIndices) model.rigidBodyStates[i] = 0

// Her bones in three's axes (MMD is left-handed: three's loader flips z), for the engine's stand-in.
const runtimeBones = model.runtimeBones
const index = new Map(runtimeBones.map((b, i) => [b, i]))
const rig = standIn(runtimeBones.map((b) => {
  const m = b.linkedBone.getRestMatrix().m
  return { name: b.name, parent: b.parentBone ? index.get(b.parentBone) : -1, rest: [m[12], m[13], -m[14]] }
}))
const byName = new Map(runtimeBones.map((b) => [b.name, b]))

const UI = { sections: [], items: [] } // items: [section, id, label, hint, run]
const eng = (window.__eng = createEngine(rig, { onChange: (id) => mark(id) }))
eng.poses.relaxed = { pose: relaxedPose(), face: {} }
UI.items.push(['Base', 'relaxed', 'Relaxed', 'arms down, at ease', () => (eng.stop(), eng.pose('relaxed'))])
eng.pose('relaxed', true)
// Rem's Live2D emotions as face + stance + beat (engine.js EMOTES). Think's arms come from a pose (see below).
const EMOTE_HINTS = {
  normal: 'at rest', smile: 'small smile, slight tilt', happy: 'smile, a little bob', delighted: 'big smile, bounce', nod: 'double nod',
  think: 'head down, puzzled, hand to chin', worried: 'troubled, shoulders up', serious: 'firm, one nod', surprised: 'startle back', shy: 'blush, head down and tilted',
  pout: 'puffed cheeks, turns away', sad: 'head down, slumped', angry: 'anger mark, head shake', sigh: 'breath in, slump', teary: 'tears, head down',
}
for (const [name, hint] of Object.entries(EMOTE_HINTS)) UI.items.push(["Rem's emotes", `emote:${name}`, name, hint, () => eng.emote(name)])

// three's axes back to MMD's: a rotation (x, y, z, w) becomes (-x, -y, z, w), as three's loader converts them.
const bq = new Quaternion()
const writes = eng.controlled.map((b) => ({ b, lb: byName.get(b.name)?.linkedBone })).filter((x) => x.lb)
const morphs = new Map()
const morphIndices = (name) => {
  if (!morphs.has(name)) morphs.set(name, model.morph.getMorphIndices(name) ?? [])
  return morphs.get(name)
}

// The face as the model has it now (read back from babylon-mmd, not what the engine asked for), a few times a second.
const faceLine = document.getElementById('face')
let faceShown = 0
const showFace = () => {
  const on = Object.keys(eng.face)
    .filter((n) => n !== 'まばたき' && morphIndices(n).length)
    .map((n) => [n, model.morph.getMorphWeight(n)])
    .filter(([, w]) => w > 0.05)
    .map(([n, w]) => `${n} ${w.toFixed(2)}`)
  faceLine.textContent = `face: ${on.join(' · ') || 'neutral'}`
}

let warmed = false
engine.runRenderLoop(() => {
  const dt = Math.min(engine.getDeltaTime() / 1000, 0.1)
  eng.update(dt)
  for (const { b, lb } of writes) lb.setRotationQuaternion(bq.set(-b.quaternion.x, -b.quaternion.y, b.quaternion.z, b.quaternion.w), Space.LOCAL)
  for (const [name, w] of Object.entries(eng.face)) for (const i of morphIndices(name)) model.morph.setMorphWeightFromIndex(i, w)
  if ((faceShown += dt) > 0.25) (faceShown = 0), showFace()
  scene.render()
  // Physics starts from her first real pose, not from the T-pose she loads in.
  if (!warmed) (warmed = true), model.initializePhysics()
})
state.loaded = true
status.textContent = 'Model ready · loading poses and motions…'

// ---------------------------------------------------------------- poses and motions
const load = sources(rig)
const at = (dir, file) => `assets/${dir}/${file}`
async function add(section, id, label, hint, job, opts = {}) {
  try {
    const r = await job
    if (r.pose) {
      eng.poses[id] = { pose: opts.still ? r.pose : r.pose, partial: r.partial, face: opts.face ?? {} }
      UI.items.push([section, id, label, hint, () => (eng.stop(), eng.pose(id))])
    } else if (opts.still) {
      eng.poses[id] = { pose: new Map([...r.sample(Math.min(0.5, r.duration / 2))].map(([n, q]) => [n, q.clone()])), face: opts.face ?? {} }
      UI.items.push([section, id, label, hint, () => (eng.stop(), eng.pose(id))])
    } else {
      eng.motions[id] = { sample: r.sample, duration: r.duration, loop: !!opts.loop, face: opts.face }
      UI.items.push([section, id, label, `${hint} · ${r.duration.toFixed(1)} s`, () => eng.play(id)])
    }
  } catch (e) {
    console.warn(label, e)
  }
}
const jobs = [
  ...VPD_POSES.map((p) => add('Poses (VPD)', `vpd:${p.file}`, p.label, p.hint, load.vpd(at('poses', p.file)))),
  ...VMD.map((v) => add('Motions', `vmd:${v.file}`, v.label, v.hint, load.vmd(at('motions', v.file)), { face: v.face })),
  ...FBX.map((f) => add(f.still ? 'Poses (Mixamo)' : 'Motions', `fbx:${f.file}`, f.label, f.hint, load.fbx(at('motions', f.file)), f)),
  ...REM_SET.map((r) => add('VRoid clips', `rem:${r.key}`, r.label, r.from,
    r.vpd ? load.vpd(at('poses', r.vpd)) : r.bvh ? load.bvh(at('motions/bandai', r.bvh)) : load.vrma(at('motions/vrma/VRMA_MotionPack/vrma', r.vrma)), { face: r.face })),
]
buildBar()
buildList()
await Promise.all(jobs)
// Think's arms until a Blender-made pose replaces it: Reggie's hand-to-chin stand.
eng.poses.think = eng.poses['vpd:Standing 1 -Stellas Shoujo Walk.vpd']
buildList()
state.assets = true
status.textContent = `${UI.items.length} poses and motions · drag to orbit`

// ---------------------------------------------------------------- UI
function mark(id) {
  document.querySelectorAll('.item').forEach((b) => b.classList.toggle('on', b.dataset.id === id))
}
function buildList() {
  const order = ['Base', "Rem's emotes", 'VRoid clips', 'Poses (VPD)', 'Poses (Mixamo)', 'Motions']
  const el = document.getElementById('list')
  el.innerHTML = order.filter((s) => UI.items.some((x) => x[0] === s))
    .map((s) => `<h2>${s}</h2>` + UI.items.filter((x) => x[0] === s).map(([, id, label, hint]) => `<button class="item" data-id="${id}"><b>${label}</b><small>${hint}</small></button>`).join(''))
    .join('')
  el.onclick = (e) => {
    const b = e.target.closest('.item')
    if (b) UI.items.find((x) => x[1] === b.dataset.id)[4]()
  }
  mark(eng.current)
}
function buildBar() {
  const bar = document.getElementById('bar')
  bar.innerHTML = ''
  const button = (label, fn) => {
    const b = document.createElement('button')
    b.textContent = label
    b.onclick = fn
    bar.append(b)
  }
  for (const k of Object.keys(VIEWS)) button(`view: ${k}`, () => look(k))
  button('stop motion', () => eng.stop())
}
