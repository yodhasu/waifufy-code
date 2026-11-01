// A 3D card's character (from ui-draft/mmd-lab): babylon-mmd draws her .pmx with MMD's own shading and outlines and
// runs her IK, inherited rotations and Bullet physics; mmd-engine.ts decides her pose. Every frame, before her
// physics step, the engine's rotations go into her bones' local rotations, which babylon-mmd reads as its input.
// Imported on first use (index.ts), so a Live2D card never loads Babylon.

import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { Engine } from '@babylonjs/core/Engines/engine'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader'
import { Space } from '@babylonjs/core/Maths/math.axis'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import { Scene } from '@babylonjs/core/scene'
import { RegisterMmdOutlineRenderer } from 'babylon-mmd/esm/Loader/mmdOutlineRenderer.pure'
import { MmdStandardMaterialBuilder } from 'babylon-mmd/esm/Loader/mmdStandardMaterialBuilder'
import { RegisterPmxLoader } from 'babylon-mmd/esm/Loader/pmxLoader.pure'
import type { MmdMesh } from 'babylon-mmd/esm/Runtime/mmdMesh'
import { MmdWasmInstanceTypeSPR } from 'babylon-mmd/esm/Runtime/Optimized/InstanceType/singlePhysicsRelease'
import { GetMmdWasmInstance } from 'babylon-mmd/esm/Runtime/Optimized/mmdWasmInstance'
import { MultiPhysicsRuntime } from 'babylon-mmd/esm/Runtime/Optimized/Physics/Bind/Impl/multiPhysicsRuntime'
import { MotionType } from 'babylon-mmd/esm/Runtime/Optimized/Physics/Bind/motionType'
import { PhysicsStaticPlaneShape } from 'babylon-mmd/esm/Runtime/Optimized/Physics/Bind/physicsShape'
import { RigidBody } from 'babylon-mmd/esm/Runtime/Optimized/Physics/Bind/rigidBody'
import { RigidBodyConstructionInfo } from 'babylon-mmd/esm/Runtime/Optimized/Physics/Bind/rigidBodyConstructionInfo'
import { MmdBulletPhysics } from 'babylon-mmd/esm/Runtime/Optimized/Physics/mmdBulletPhysics'
import { MmdRuntime } from 'babylon-mmd/esm/Runtime/mmdRuntime'
import { Quaternion as Q3, Vector3 as V3 } from 'three'
import type { CustomMotion, Emotion, JointPose, JointTurn, Motions } from '../../../link/src/protocol.ts'
import type { Gesture } from '../contracts'
import type { Actor, Geometry } from './director.ts'
import { BOX_H, BOX_W } from './layout.ts'
import { createEngine, JOINTS, LEG, standIn, turnOf } from './mmd-engine.ts'
import { apply, bodyOf, limit, reach, type RigidBodyInfo, type Side } from './poser.ts'
import type { Rings } from './mmd-rings.ts'

RegisterPmxLoader()
RegisterMmdOutlineRenderer()

// The camera frames her in the character box: her whole body, feet at its bottom edge, like the Live2D costumes stand,
// or (a phone's chat, with the dialogue box over her legs) from the waist up. MMD units: she is about 20 tall. The
// camera faces her front (MMD models face -Z).
const FOV = 0.5
/** What a shot shows at zoom 1: from `bottom` to `top`, in MMD units up her body. */
const SHOTS = { full: { bottom: -0.74, top: 22.74 }, bust: { bottom: 10, top: 23.2 } } as const
export type Shot = keyof typeof SHOTS
/** Where her head's center is when the model has no 頭 bone to measure (MMD units). */
const HEAD_Y = 19.5
/** The frame always keeps this much above the top of her head, so zooming in on her head never cuts it off. */
const HEAD_ROOM = 0.4
/** Her head's half height (MMD units): its center is the 頭 bone plus this. */
const HEAD_HALF = 1.6
/** MMD gravity is ten times Earth's: models are measured in 8 cm units. */
const GRAVITY = -98
/** Her mouth for the typewriter flap when no voice plays: an open-close a few times a second, never wide. */
const FLAP_HZ = 7
const FLAP_OPEN = 0.55
const VOICE_GAIN = 1.4
/** A gesture or touch shows its emotion this long, then she goes back to the one she holds. */
const GESTURE_MS = 1800
const REACT_MS = 1400
/** Geometry in MMD units around her bones, for headpats, taps and eye tracking. */
const HEAD_R = 2.4
const FACE_R = 1.7
const BODY_RX = 3.4
const BODY_RY = 5.5
/** Her necklace's small trinkets (and the chain they hang from) never settle under physics: they follow their bones. */
const STILL = /^acce_small_|^neck_acce_/

// A greeting smiles rather than laughs: she is usually saying something with it.
const GESTURE_EMOTE: Record<Gesture, Emotion> = {
  confirm: 'think', danger: 'worried', push: 'happy', success: 'delighted', fail: 'sad', interrupt: 'surprised', greet: 'smile', costume: 'smile',
}
/** The Live2D touch tiers (motions.ts) as emotions: a pat starts happy and gets shy, a run of them pouty; taps surprise. */
const TIER_EMOTE: Record<string, Emotion> = {
  'pat-happy': 'happy', 'pat-shy': 'shy', 'pat-pout': 'pout', 'pat-sulk': 'sad', 'pat-busy': 'angry',
  'tap-surprised': 'surprised', 'tap-startled': 'surprised', 'tap-pout': 'pout', 'tap-angry': 'angry',
  'tap-shy': 'shy', 'tap-flustered': 'shy', 'tap-sulk': 'pout',
}
/** How long she leans into the hand after each stroke of a headpat. */
const STROKE_MS = 450
/**
 * Mouth shapes from her expression, which fight the lip sync while she talks (a laughing mouth flapping reads as a
 * laugh, whatever she says): they shrink to this while her mouth moves.
 */
const MOUTH_SHAPES = ['にこり口', '笑い口', '大笑い', 'お', '口角上げ', '口角下げ', '結ぶ', 'くいしばる', 'ムッ', '左口角上げ', 'はぅ']
const MOUTH_WHILE_TALKING = 0.3
/** Of those, the ones that open her lips: gone while lip sync moves her mouth, so each syllable starts from closed lips. */
const OPEN_MOUTH = new Set(['大笑い', '笑い口', 'お', 'はぅ', 'くいしばる', '▲', '▲_2'])
/**
 * A frame comes when at least this share of her frame time has passed. At 60 fps that is every frame of a 60 Hz screen
 * however its clock jitters, and every second frame of a 90, 120 or 144 Hz one (45, 60, 72 fps); at 30, every second
 * frame of a 60 Hz screen.
 */
const CAP_SLACK = 0.75
/** The phone's overload guard (watchLoad): a window this long getting under this share of her frame rate drops her
 * to OVERLOAD_FPS for OVERLOAD_MS. */
const LOAD_WINDOW_MS = 2000
const LOAD_KEPT = 0.85
const OVERLOAD_FPS = 30
const OVERLOAD_MS = 20_000
/** How far the camera moves round her: a right-drag turns it (radians per box pixel), up to these limits. */
const ORBIT_PER_PX = 0.006
const ORBIT_YAW_MAX = 1.2
const ORBIT_PITCH_MAX = 0.45
/** A middle-drag (or Shift + right-drag) moves the camera up and down her, in MMD units per box pixel. */
const PAN_PER_PX = 0.03
const PAN_MAX = 8

export type MmdActor = Actor & {
  readonly kind: 'mmd'
  /** The .pmx path on disk this actor was loaded from. */
  readonly file: string
  readonly canvas: HTMLCanvasElement
  emote(e: Emotion): void
  gesture(g: Gesture): void
  react(kind: 'tap' | 'pat', tier: string): void
  stroke(): void
  /** Moves the camera round her (a right-drag) or up and down her (a middle-drag), in box pixels; reset puts it back. */
  orbit(dx: number, dy: number): void
  /** The camera's turn round her (radians, 0 is her front; a right-drag lowers it); the studio's go all the way round. */
  turn(yaw: number): void
  yaw(): number
  pan(dy: number): void
  resetView(): void
  /** Her whole body, or from the waist up (a phone's chat). */
  setShot(shot: Shot): void
  setRunning(on: boolean): void
  setFps(fps: number): void
  setResolution(r: number): void
  /** Draws one frame now, so the canvas can be copied in the same task (a snapshot). */
  render(): void
  /** The card's custom motions (the motion editor's). */
  setMotions(m: Motions): void
  /** The studio: holds a pose over her emotions (undefined lets go), or plays a motion once. */
  hold(pose: JointPose | undefined): void
  play(m: CustomMotion): void
  /** The joints of this model the studio can turn, in the model's bone order. */
  joints(): string[]
  studio: MmdStudio
}

/** The studio's posing on her model, in box pixels as the stage's overlay has them. */
export type MmdStudio = {
  /** Starts posing from `pose`: she holds still in it, and `onEdit` hears each change (`done` when a drag ends). */
  begin(pose: JointPose, onEdit: (pose: JointPose, done: boolean) => void): void
  /** The pose she holds, set from outside (undo, a hand shape, a key picked). */
  set(pose: JointPose): void
  end(): void
  /** Where her handles are: the joints a drag moves. */
  handles(): { joint: string; x: number; y: number }[]
  /** A handle dragged: a hand reaches, an elbow swings its arm, the rest turn with the drag (`tilt`: Shift held). */
  drag(joint: string, x: number, y: number, phase: 'start' | 'move' | 'end', tilt: boolean): void
  /** Rotation rings on a joint, for turning it exactly; undefined takes them away. */
  rings(joint: string | undefined): void
}

/** The joints the studio shows a handle on: hands and elbows reach, the rest turn when dragged. */
const HANDLES = ['頭', '首', '上半身2', '上半身', '左肩', '右肩', '左ひじ', '右ひじ', '左手首', '右手首']
/** Where a handle shows when its own bone sits elsewhere: a shoulder's starts by the neck, so its dot is on the arm's top. */
const HANDLE_AT: Record<string, string> = { 左肩: '左腕', 右肩: '右腕' }
/** The rotation rings' size (Babylon's scale ratio: 1 is a third of the view across). */
const RINGS_SCALE = 0.4
/** Degrees a turn takes per box pixel of drag. */
const TURN_PER_PX = 0.35

/**
 * Babylon reads the pointer in screen pixels from the canvas's corner, but the stage is scaled to fit the window (and
 * her box with it): the studio's rings would be picked off by that scale. This puts the pointer back in the canvas's
 * own pixels.
 * shortcut: patches Babylon's private input manager (pinned @babylonjs/core 9.33.0); recheck on a Babylon upgrade.
 */
function fitPointer(scene: Scene, canvas: HTMLCanvasElement) {
  type Input = { _updatePointerPosition(e: PointerEvent): void; _pointerX: number; _pointerY: number; _unTranslatedPointerX: number; _unTranslatedPointerY: number }
  const input = (scene as unknown as { _inputManager?: Input })._inputManager
  if (!input?._updatePointerPosition) return
  const read = input._updatePointerPosition.bind(input)
  input._updatePointerPosition = (e) => {
    read(e)
    const r = canvas.getBoundingClientRect()
    const kx = canvas.clientWidth / (r.width || 1), ky = canvas.clientHeight / (r.height || 1)
    input._pointerX = input._unTranslatedPointerX = input._pointerX * kx
    input._pointerY = input._unTranslatedPointerY = input._pointerY * ky
  }
}

/**
 * Her physics: one Bullet world (WebAssembly) for the page, with a floor, that every 3D model shares. It is never
 * disposed: disposing a MultiPhysicsRuntime hung the page, so a model only steps it from its own scene while loaded.
 */
let shared: Promise<MultiPhysicsRuntime> | undefined
function sharedPhysics() {
  shared ??= GetMmdWasmInstance(new MmdWasmInstanceTypeSPR()).then((wasm) => {
    const physics = new MultiPhysicsRuntime(wasm)
    physics.setGravity(new Vector3(0, GRAVITY, 0))
    const floor = new RigidBodyConstructionInfo(physics.wasmInstance)
    floor.motionType = MotionType.Static
    floor.shape = new PhysicsStaticPlaneShape(physics, new Vector3(0, 1, 0), 0)
    physics.addRigidBodyToGlobal(new RigidBody(physics, floor))
    return physics
  })
  shared.catch(() => (shared = undefined))
  return shared
}

/**
 * Loads her model from `url` (the link's /mmd/ route, which serves the folder of the card's .pmx) into a new canvas
 * inserted in `box` before `before`.
 */
/** A phone draws her lighter: no self-shadows or outlines, physics steps of up to 1/60 s (a frame the phone runs late takes two even steps, not one long one: a step that changed length frame to frame shook her chest), and at most this density. */
const PHONE_MAX_RESOLUTION = 1
const PHONE_PHYSICS_STEP = 1 / 60
/** Her physics' longest step on a desktop (s). */
const PHYSICS_STEP = 1 / 120
/**
 * Each step a hair short of an even share of the frame, so float error never leaves a frame one step short (and the
 * next one over); what it leaves over adds up to one step in minutes.
 */
const STEP_SHORT = 1e-4

export type MmdOptions = {
  zoom: number
  resolution: number
  /** A phone: lighter drawing (the link already sends it smaller textures). */
  light: boolean
  /** The GPU dropped her canvas (out of memory, a driver reset); she can't be drawn until loaded again. */
  onLost(): void
}

export async function loadMmd(box: HTMLElement, before: Node, url: string, file: string, o: MmdOptions): Promise<MmdActor> {
  const cap = (r: number) => (o.light ? Math.min(r, PHONE_MAX_RESOLUTION) : r)
  const canvas = document.createElement('canvas')
  canvas.className = 'chara-mmd'
  // Whether it takes the pointer is character.css's call (her body, a phone's touches), so not set here.
  canvas.style.cssText = `position:absolute;left:0;top:0;width:${BOX_W}px;height:${BOX_H}px`
  box.insertBefore(canvas, before)
  // A phone: no MSAA (Babylon's second argument decides it, over the options) and no kept buffer, which a tiled mobile
  // GPU pays for every frame (a snapshot renders and copies in one task, so it doesn't need it).
  const engine = new Engine(canvas, !o.light, { preserveDrawingBuffer: !o.light, stencil: true, alpha: true, premultipliedAlpha: false }, false)
  engine.setHardwareScalingLevel(1 / cap(o.resolution))
  engine.onContextLostObservable.add(() => o.onLost())
  const scene = new Scene(engine)
  try {
    return await build(engine, scene, canvas, url, file, o.zoom, o.light, cap)
  } catch (e) {
    scene.dispose()
    engine.dispose()
    canvas.remove()
    throw e
  }
}

async function build(
  engine: Engine, scene: Scene, canvas: HTMLCanvasElement, url: string, file: string, zoom: number, light: boolean, cap: (r: number) => number,
): Promise<MmdActor> {
  scene.clearColor = new Color4(0, 0, 0, 0)
  scene.ambientColor = new Color3(0.5, 0.5, 0.5)
  const camera = new ArcRotateCamera('camera', -Math.PI / 2, Math.PI / 2, 46, new Vector3(0, 11, 0), scene)
  camera.fov = FOV
  camera.minZ = 0.5
  const tan = Math.tan(FOV / 2)
  /** The camera as the user moved it: a shot, a zoom, a turn round her and a height. */
  const view = { shot: 'full' as Shot, yaw: 0, pitch: 0, rise: 0, zoom, head: HEAD_Y }
  // Zoom closes in on her head: its center stays where it is on screen, and the frame keeps the top of her head in.
  const frame = (z = view.zoom) => {
    view.zoom = z
    const { bottom, top } = SHOTS[view.shot]
    const half = (top - bottom) / 2 / z
    let y = view.head + ((top + bottom) / 2 - view.head) / z
    y = Math.max(y, view.head + HEAD_HALF + HEAD_ROOM - half)
    camera.radius = half / tan
    camera.target.y = y + view.rise
    camera.alpha = -Math.PI / 2 + view.yaw
    camera.beta = Math.PI / 2 + view.pitch
  }
  frame(zoom)
  // The lighting babylon-mmd's examples use: a soft fill from above, and a key light that casts her self-shadows.
  const fill = new HemisphericLight('fill', new Vector3(0, 1, 0), scene)
  fill.intensity = 0.3
  fill.specular.set(0, 0, 0)
  fill.groundColor.set(1, 1, 1)
  const key = new DirectionalLight('key', new Vector3(0.5, -1, 1), scene)
  key.intensity = 0.7
  key.autoCalcShadowZBounds = true
  // Self-shadows cost a second render of her every frame and a shadow map: not on a phone.
  const shadows = light ? undefined : new ShadowGenerator(1024, key, true)
  if (shadows) {
    shadows.transparencyShadow = true
    shadows.usePercentageCloserFiltering = true
    shadows.forceBackFacesOnly = true
    shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM
    shadows.frustumEdgeFalloff = 0.1
  }

  const physics = await sharedPhysics()
  // Stepped by this scene, after its animations, the way MultiPhysicsRuntime.register does it; register() binds one
  // scene only, and while cards swap two scenes are briefly alive.
  // It steps by the time since her last drawn frame, not the engine's (a screen frame: with frames skipped for the cap,
  // a 144 Hz screen draws her every third). Babylon-mmd draws the last step as it is, not between steps, so a frame
  // that took two fixed steps where the others took one jumps (her chest and hair jittered): each frame is cut into
  // equal steps of at most PHYSICS_STEP instead, the same number every frame.
  const maxStep = light ? PHONE_PHYSICS_STEP : PHYSICS_STEP
  let stepMs = 0
  const stepPhysics = scene.onAfterAnimationsObservable.add(() => {
    // A frame drawn out of turn (a snapshot) moves no time on.
    if (!stepMs) return
    const n = Math.ceil(stepMs / 1000 / maxStep - STEP_SHORT)
    physics.fixedTimeStep = (stepMs / 1000 / n) * (1 - STEP_SHORT)
    physics.maxSubSteps = n + 1
    physics.afterAnimations(stepMs)
  })
  fitPointer(scene, canvas)
  const runtime = new MmdRuntime(scene, new MmdBulletPhysics(physics))
  runtime.register(scene)

  const container = await LoadAssetContainerAsync(url, scene, {
    pluginOptions: { mmdmodel: { materialBuilder: new MmdStandardMaterialBuilder(), loggingEnabled: false } },
  })
  container.addAllToScene()
  const mesh = container.rootNodes[0] as MmdMesh
  if (shadows) {
    for (const m of mesh.metadata.meshes as Mesh[]) m.receiveShadows = true
    shadows.addShadowCaster(mesh)
  }
  // MMD's ink outline draws her a second time; on a phone that is frame time she can't spare.
  if (light) for (const m of mesh.metadata.materials as readonly { renderOutline?: boolean }[]) if ('renderOutline' in m) m.renderOutline = false
  // The model's bones and rigid bodies as loaded, kept before createMmdModel, which trims them off the mesh.
  const meta = { ...(mesh.metadata as { bones: readonly { name: string }[]; rigidBodies?: readonly { boneIndex: number; physicsMode: number; shapeType: number; shapeSize: ArrayLike<number>; shapePosition: ArrayLike<number>; shapeRotation: ArrayLike<number> }[] }) }
  const model = runtime.createMmdModel(mesh)
  for (const b of model.runtimeBones) if (STILL.test(b.name)) for (const i of b.rigidBodyIndices) model.rigidBodyStates[i] = 0

  // Her bones in three's axes (MMD is left-handed: three's loader flips z), for the engine's stand-in.
  const bones = model.runtimeBones
  const index = new Map(bones.map((b, i) => [b, i]))
  const rig = standIn(bones.map((b) => {
    const m = b.linkedBone.getRestMatrix().m
    return { name: b.name, parent: b.parentBone ? index.get(b.parentBone)! : -1, rest: [m[12]!, m[13]!, -m[14]!] }
  }))
  const byName = new Map(bones.map((b) => [b.name, b]))
  // Her body for the studio's arms to keep out of: the model's rigid bodies on her torso and head.
  const v3 = (a: ArrayLike<number>): [number, number, number] => [a[0]!, a[1]!, a[2]!]
  const colliders = bodyOf(rig.bone, (meta.rigidBodies ?? []).map((r): RigidBodyInfo => ({
    bone: meta.bones[r.boneIndex]?.name ?? '', shapeType: r.shapeType, size: v3(r.shapeSize), position: v3(r.shapePosition), rotation: v3(r.shapeRotation),
  })))
  // Physics chains hanging from her lower body (下半身, where MMD models hang a skirt): the waist-up shot doesn't show
  // them (the dialogue box covers her there), so they rest while it is on. On Reine that is 80 of her 155 bodies, and
  // half her physics time on a phone.
  const dynamic = new Set((meta.rigidBodies ?? []).flatMap((r, i) => (r.physicsMode !== 0 ? [i] : [])))
  const moves = (b: (typeof bones)[number]) => b.rigidBodyIndices.some((i) => dynamic.has(i))
  const belowWaist = bones.filter((b) => {
    if (!moves(b)) return false
    let root = b
    while (root.parentBone && moves(root.parentBone)) root = root.parentBone
    return root.parentBone?.name === '下半身'
  }).flatMap((b) => b.rigidBodyIndices.filter((i) => dynamic.has(i)))
  const restBelowWaist = (on: boolean) => {
    for (const i of belowWaist) model.rigidBodyStates[i] = on ? 0 : 1
  }
  // Her head's center, for zoom to close in on (the 頭 bone sits at its base).
  const headBone = byName.get('頭')
  if (headBone) {
    const at = new Vector3()
    headBone.getWorldTranslationToRef(at)
    if (at.y > 1) (view.head = at.y + HEAD_HALF), frame()
  }
  // A posed leg can't keep its foot planted: its IK (the leg's and its toe's) is off while a motion turns it.
  const legIk = (side: string) => bones.filter((b) => b.name === `${side}足ＩＫ` || b.name === `${side}つま先ＩＫ`).map((b) => b.ikSolverIndex).filter((i) => i >= 0)
  const ik = { 左: legIk('左'), 右: legIk('右') }
  const eng = createEngine(rig, (joints) => {
    for (const side of ['左', '右'] as const) {
      const on = ![...joints].some((n) => LEG.exec(n)?.[1] === side) ? 1 : 0
      for (const i of ik[side]) model.ikSolverStates[i] = on
    }
  })
  let held: Emotion = 'normal'
  eng.emote(held, true)

  // three's axes back to MMD's: a rotation (x, y, z, w) becomes (-x, -y, z, w), as three's loader converts them.
  const bq = new Quaternion()
  const writes = eng.controlled.map((b) => ({ b, lb: byName.get(b.name)?.linkedBone })).filter((x) => x.lb)
  const morphCache = new Map<string, readonly number[]>()
  /** Weights last written, so a morph that didn't change isn't written again (each write re-uploads it). */
  const written = new Map<string, number>()
  const morphIndices = (name: string) => {
    let list = morphCache.get(name)
    if (!list) morphCache.set(name, (list = model.morph.getMorphIndices(name) ?? []))
    return list
  }

  let talking = false
  let voice: (() => number) | undefined
  /** Where "straight ahead" is for her look: toward the camera, wherever it went round her. */
  const faceCamera = () => eng.lookBase(-view.yaw / 0.6, view.pitch / 0.4)
  let blush = false
  let mouth = 0
  let back: number | undefined
  let fps = 60
  let lastFrame = 0
  let warmed = false
  let running = false
  /**
   * A phone that can't keep her frame rate (a slow one, or one hot and throttled) gets her at OVERLOAD_FPS for a while:
   * half the frames, twice the time for each one's bones and physics, and the phone cools down. Then 60 is tried again.
   */
  const load = { cap: Infinity, since: 0, frames: 0, until: 0 }

  /** Counts a drawn frame; past each window, decides the phone's cap. */
  function watchLoad(now: number) {
    if (!light) return
    if (!load.since) return void ((load.since = now), (load.frames = 0))
    load.frames++
    const span = now - load.since
    if (span < LOAD_WINDOW_MS) return
    const got = (load.frames * 1000) / span
    if (load.cap > OVERLOAD_FPS && fps > OVERLOAD_FPS && got < fps * LOAD_KEPT) (load.cap = OVERLOAD_FPS), (load.until = now + OVERLOAD_MS)
    else if (load.cap === OVERLOAD_FPS && now > load.until) load.cap = Infinity
    // The page's own animations (petals) would keep the WebView drawing 60 a second anyway: they rest too (base.css).
    canvas.closest<HTMLElement>('#stage')?.toggleAttribute('data-overload', load.cap !== Infinity)
    load.since = now
    load.frames = 0
  }

  function tick() {
    const now = performance.now()
    // A frame-rate cap: skip screen frames that come well before hers is due (a window in the back, a fast screen). Only
    // well before: a phone's frame clock jitters by a few ms, and a tight cap dropped every few frames at 60 fps there.
    if (now - lastFrame < (1000 / Math.min(fps, load.cap)) * CAP_SLACK) return
    const dt = Math.min((now - (lastFrame || now)) / 1000, 0.1)
    lastFrame = now
    watchLoad(now)
    stepMs = dt * 1000 || 1000 / fps
    eng.update(dt)
    for (const { b, lb } of writes) lb!.setRotationQuaternion(bq.set(-b.quaternion.x, -b.quaternion.y, b.quaternion.z, b.quaternion.w), Space.LOCAL)
    const open = voice ? Math.min(1, voice() * VOICE_GAIN) : talking ? FLAP_OPEN * Math.max(0, Math.sin((now / 1000) * Math.PI * 2 * FLAP_HZ)) : 0
    mouth += (open - mouth) * Math.min(1, dt * 18)
    const weights: Record<string, number> = { ...eng.face, あ: Math.max(eng.face['あ'] ?? 0, mouth) }
    if (talking || voice) for (const m of [...MOUTH_SHAPES, ...OPEN_MOUTH]) if (weights[m]) weights[m] = OPEN_MOUTH.has(m) ? 0 : weights[m]! * MOUTH_WHILE_TALKING
    if (blush) weights['照れ'] = Math.max(weights['照れ'] ?? 0, 0.6)
    for (const [name, w] of Object.entries(weights)) {
      if (Math.abs((written.get(name) ?? -1) - w) < 0.002) continue
      written.set(name, w)
      for (const i of morphIndices(name)) model.morph.setMorphWeightFromIndex(i, w)
    }
    if (ring && !ring.dragging) ring.follow()
    scene.render()
    // Physics starts from her first real pose, not from the T-pose she loads in.
    if (!warmed) (warmed = true), model.initializePhysics()
  }

  /** Shows `e` for `ms`, then the emotion she holds. */
  function flash(e: Emotion, ms: number) {
    clearTimeout(back)
    eng.emote(e)
    back = window.setTimeout(() => eng.emote(held), ms)
  }

  const world = new Vector3()
  const viewport = () => camera.viewport.toGlobal(BOX_W, BOX_H)
  /** A bone's position in box pixels, and how many box pixels one MMD unit is there. */
  function project(name: string) {
    const b = byName.get(name)
    if (!b) return undefined
    b.getWorldTranslationToRef(world)
    const p = Vector3.Project(world, Matrix.IdentityReadOnly, scene.getTransformMatrix(), viewport())
    const depth = Vector3.Distance(camera.position, world)
    return { x: p.x, y: p.y, unit: BOX_H / (2 * depth * Math.tan(FOV / 2)) }
  }

  // ---------------------------------------------------------------- the studio

  let posing: { pose: JointPose; onEdit: (pose: JointPose, done: boolean) => void } | undefined
  let dragging: { joint: string; x: number; y: number; base: JointPose; depth: Vector3 } | undefined
  let ring: Rings | undefined
  /** The joint the rings were last asked for: they load on first use, and the ask may change meanwhile. */
  let ringsFor: string | undefined

  const show = (pose: JointPose, done: boolean) => {
    if (!posing) return
    posing.pose = pose
    eng.hold(pose, true)
    posing.onEdit(pose, done)
  }

  /** The point under box pixel (x, y) on the plane facing the camera through `through`, in three's axes. */
  function pointAt(x: number, y: number, through: Vector3) {
    const view = scene.getViewMatrix(), proj = scene.getProjectionMatrix()
    const near = Vector3.Unproject(new Vector3(x, y, 0), BOX_W, BOX_H, Matrix.IdentityReadOnly, view, proj)
    const far = Vector3.Unproject(new Vector3(x, y, 1), BOX_W, BOX_H, Matrix.IdentityReadOnly, view, proj)
    const dir = far.subtract(near).normalize()
    const n = camera.getTarget().subtract(camera.position).normalize()
    const p = near.add(dir.scale(Vector3.Dot(through.subtract(near), n) / (Vector3.Dot(dir, n) || 1e-6)))
    return new V3(p.x, p.y, -p.z)
  }

  const studio: MmdStudio = {
    begin(pose, onEdit) {
      posing = { pose, onEdit }
      eng.setStill(true)
      eng.hold(pose, true)
      // The rings are picked on her canvas.
      canvas.style.pointerEvents = 'auto'
    },
    set(pose) {
      if (posing) (posing.pose = pose), eng.hold(pose, true)
    },
    end() {
      studio.rings(undefined)
      // Only the studio turns all the way round her: elsewhere the camera comes back within its usual reach.
      if (Math.abs(view.yaw) > ORBIT_YAW_MAX) (view.yaw = 0), frame(), faceCamera()
      posing = dragging = undefined
      eng.setStill(false)
      eng.hold(undefined)
      canvas.style.pointerEvents = ''
    },
    handles: () => HANDLES.flatMap((joint) => {
      const p = project(HANDLE_AT[joint] ?? joint)
      return p ? [{ joint, x: p.x, y: p.y }] : []
    }),
    drag(joint, x, y, phase, tilt) {
      if (!posing) return
      if (phase === 'start') {
        const depth = new Vector3()
        byName.get(joint)?.getWorldTranslationToRef(depth)
        dragging = { joint, x, y, base: structuredClone(posing.pose), depth }
        return
      }
      const d = dragging
      if (!d || d.joint !== joint) return
      if (phase === 'end') {
        dragging = undefined
        return show(posing.pose, true)
      }
      const hand = /^([左右])手首$/.exec(joint), elbow = /^([左右])ひじ$/.exec(joint)
      if (hand || elbow) {
        const side = (hand ?? elbow)![1] as Side
        let target = pointAt(x, y, d.depth)
        let pole: V3 | undefined
        if (elbow) {
          // The wrist stays where it is; the elbow swings toward the pointer.
          pole = target
          apply(rig.bone, posing.pose)
          target = new V3().setFromMatrixPosition(rig.bone[`${side}手首`]!.matrixWorld)
        }
        return show({ ...posing.pose, ...reach(rig.bone, colliders, posing.pose, side, target, pole) }, false)
      }
      // A turn with the drag: across turns her (screen right is her left), down bends her forward; Shift tilts instead
      // of turning. A shoulder shrugs.
      const dx = (x - d.x) * TURN_PER_PX, dy = (y - d.y) * TURN_PER_PX
      const b = d.base[joint] ?? [0, 0, 0]
      const turn: JointTurn = /肩$/.test(joint) ? [b[0], b[1], b[2] - dy] : tilt ? [b[0] + dy, b[1], b[2] + dx] : [b[0] + dy, b[1] + dx, b[2]]
      show({ ...posing.pose, [joint]: limit(joint, turn) }, false)
    },
    rings(joint) {
      ringsFor = joint
      ring?.dispose()
      ring = undefined
      const b = joint ? byName.get(joint) : undefined
      // A phone build has no studio, so no rings (their module isn't in it).
      if (!joint || !b || !posing || import.meta.env.TAURI_ENV_PLATFORM === 'android') return
      void import('./mmd-rings.ts').then(({ attachRings }) => {
        if (ringsFor !== joint || !posing || ring) return
        ring = attachRings(scene, b, RINGS_SCALE, (local) => {
          // The joint's local turn into three's axes.
          if (posing) show({ ...posing.pose, [joint]: limit(joint, turnOf(joint, new Q3(-local.x, -local.y, local.z, local.w))) }, false)
        }, () => void (posing && show(posing.pose, true)))
      })
    },
  }

  const actor: MmdActor = {
    kind: 'mmd',
    file,
    canvas,
    // Live2D motion names mean nothing to an MMD model: the director hands her emotions and gestures directly.
    pose: async () => -1,
    resolve: () => undefined,
    addon: async () => -1,
    emote(e) {
      clearTimeout(back)
      // Nod and sigh are one-shots: they play and she goes back to what she holds.
      if (e === 'nod' || e === 'sigh') return flash(e, GESTURE_MS)
      held = e
      eng.emote(e)
    },
    gesture(g) {
      // While she talks, the emotion her words carry is the one to show.
      if (talking || voice) return
      flash(GESTURE_EMOTE[g], GESTURE_MS)
    },
    react(kind, tier) {
      flash(TIER_EMOTE[tier] ?? (kind === 'pat' ? 'shy' : 'surprised'), REACT_MS)
      if (kind === 'pat') eng.stroked(STROKE_MS)
    },
    stroke: () => eng.stroked(STROKE_MS),
    orbit(dx, dy) {
      actor.turn(view.yaw - dx * ORBIT_PER_PX)
      view.pitch = Math.max(-ORBIT_PITCH_MAX, Math.min(ORBIT_PITCH_MAX, view.pitch - dy * ORBIT_PER_PX))
      frame()
    },
    turn(yaw) {
      // While she is posed the camera goes all the way round her (she holds still, so her look needn't follow it).
      if (posing) view.yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw))
      else (view.yaw = Math.max(-ORBIT_YAW_MAX, Math.min(ORBIT_YAW_MAX, yaw))), faceCamera()
      frame()
    },
    yaw: () => view.yaw,
    pan(dy) {
      view.rise = Math.max(-PAN_MAX, Math.min(PAN_MAX, view.rise + dy * PAN_PER_PX))
      frame()
    },
    resetView() {
      view.yaw = view.pitch = view.rise = 0
      frame()
      faceCamera()
    },
    setBlush: (on) => void (blush = on),
    setTalking: (on) => void (talking = on),
    setVoice: (level) => void (voice = level),
    focus: (x, y) => eng.look(x, y),
    geometry(): Geometry {
      const head = project('頭')
      const eyes = project('両目') ?? head
      const chest = project('上半身2') ?? head
      if (!head || !eyes || !chest) {
        // A model without the standard bones: her rough shape in the box.
        return { head: { x: BOX_W / 2, y: BOX_H * 0.12, r: 70 }, face: { x: BOX_W / 2, y: BOX_H * 0.16, r: 55 }, body: { x: BOX_W / 2, y: BOX_H * 0.45, rx: 110, ry: 200 } }
      }
      return {
        head: { x: head.x, y: head.y - HEAD_R * 0.6 * head.unit, r: HEAD_R * head.unit },
        face: { x: eyes.x, y: eyes.y, r: FACE_R * eyes.unit },
        body: { x: chest.x, y: chest.y + BODY_RY * 0.4 * chest.unit, rx: BODY_RX * chest.unit, ry: BODY_RY * chest.unit },
      }
    },
    setZoom: (z) => frame(z),
    setShot(shot) {
      if (shot === view.shot) return
      view.shot = shot
      restBelowWaist(shot === 'bust')
      frame()
    },
    setRunning(on) {
      if (on === running) return
      running = on
      if (on) (lastFrame = 0), (load.since = 0), engine.runRenderLoop(tick)
      else engine.stopRenderLoop(tick)
    },
    setFps: (f) => void (fps = f),
    setResolution(r) {
      engine.setHardwareScalingLevel(1 / cap(r))
      engine.resize()
    },
    render: () => ((stepMs = 0), scene.render()),
    setMotions: (m) => eng.setMotions(m),
    hold: (pose) => eng.hold(pose),
    play: (m) => eng.play(m),
    joints: () => bones.map((b) => b.name).filter((n) => JOINTS.test(n)),
    studio,
    destroy() {
      clearTimeout(back)
      studio.rings(undefined)
      engine.stopRenderLoop()
      // Her model leaves the shared physics world with the runtime; the world itself stays. A step that fails doesn't
      // stop the rest.
      const steps = [
        () => runtime.dispose(scene),
        () => stepPhysics.remove(),
        () => scene.dispose(),
        () => engine.dispose(),
      ]
      for (const step of steps) {
        try {
          step()
        } catch (e) {
          console.warn('[waifufy-code] 3D teardown:', e)
        }
      }
      canvas.remove()
    },
  }
  engine.resize()
  return actor
}
