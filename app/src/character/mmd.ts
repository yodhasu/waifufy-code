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
import type { Emotion } from '../../../link/src/protocol.ts'
import type { Gesture } from '../contracts'
import type { Actor, Geometry } from './director.ts'
import { BOX_H, BOX_W } from './layout.ts'
import { createEngine, standIn } from './mmd-engine.ts'

RegisterPmxLoader()
RegisterMmdOutlineRenderer()

// The camera frames her whole body in the character box, feet at its bottom edge, like the Live2D costumes stand.
// MMD units: she is about 20 tall. The camera faces her front (MMD models face -Z).
const FOV = 0.5
const TARGET_Y = 11
const RADIUS = 46
/** Zoom scales the distance; her feet stay near the box's bottom, so the target rises as she gets closer. */
const ZOOM_RISE = 4
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

const GESTURE_EMOTE: Record<Gesture, Emotion> = {
  confirm: 'think', danger: 'worried', push: 'happy', success: 'delighted', fail: 'sad', interrupt: 'surprised', greet: 'happy', costume: 'smile',
}

export type MmdActor = Actor & {
  readonly kind: 'mmd'
  /** The .pmx path on disk this actor was loaded from. */
  readonly file: string
  readonly canvas: HTMLCanvasElement
  emote(e: Emotion): void
  gesture(g: Gesture): void
  react(kind: 'tap' | 'pat'): void
  setRunning(on: boolean): void
  setFps(fps: number): void
  setResolution(r: number): void
  /** Draws one frame now, so the canvas can be copied in the same task (a snapshot). */
  render(): void
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
export async function loadMmd(box: HTMLElement, before: Node, url: string, file: string, zoom: number, resolution: number): Promise<MmdActor> {
  const canvas = document.createElement('canvas')
  canvas.className = 'chara-mmd'
  canvas.style.cssText = `position:absolute;left:0;top:0;width:${BOX_W}px;height:${BOX_H}px;pointer-events:none`
  box.insertBefore(canvas, before)
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true, antialias: true, alpha: true, premultipliedAlpha: false }, false)
  engine.setHardwareScalingLevel(1 / resolution)
  const scene = new Scene(engine)
  try {
    return await build(engine, scene, canvas, url, file, zoom)
  } catch (e) {
    scene.dispose()
    engine.dispose()
    canvas.remove()
    throw e
  }
}

async function build(engine: Engine, scene: Scene, canvas: HTMLCanvasElement, url: string, file: string, zoom: number): Promise<MmdActor> {
  scene.clearColor = new Color4(0, 0, 0, 0)
  scene.ambientColor = new Color3(0.5, 0.5, 0.5)
  const camera = new ArcRotateCamera('camera', -Math.PI / 2, Math.PI / 2, RADIUS, new Vector3(0, TARGET_Y, 0), scene)
  camera.fov = FOV
  camera.minZ = 0.5
  const frame = (z: number) => {
    camera.radius = RADIUS / z
    camera.target.y = TARGET_Y + ZOOM_RISE * (z - 1)
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
  const shadows = new ShadowGenerator(1024, key, true)
  shadows.transparencyShadow = true
  shadows.usePercentageCloserFiltering = true
  shadows.forceBackFacesOnly = true
  shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM
  shadows.frustumEdgeFalloff = 0.1

  const physics = await sharedPhysics()
  // Stepped by this scene, after its animations, the way MultiPhysicsRuntime.register does it; register() binds one
  // scene only, and while cards swap two scenes are briefly alive.
  const stepPhysics = scene.onAfterAnimationsObservable.add(() => physics.afterAnimations(engine.getDeltaTime()))
  const runtime = new MmdRuntime(scene, new MmdBulletPhysics(physics))
  runtime.register(scene)

  const container = await LoadAssetContainerAsync(url, scene, {
    pluginOptions: { mmdmodel: { materialBuilder: new MmdStandardMaterialBuilder(), loggingEnabled: false } },
  })
  container.addAllToScene()
  const mesh = container.rootNodes[0] as MmdMesh
  for (const m of mesh.metadata.meshes as Mesh[]) m.receiveShadows = true
  shadows.addShadowCaster(mesh)
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
  const eng = createEngine(rig)
  let held: Emotion = 'normal'
  eng.emote(held, true)

  // three's axes back to MMD's: a rotation (x, y, z, w) becomes (-x, -y, z, w), as three's loader converts them.
  const bq = new Quaternion()
  const writes = eng.controlled.map((b) => ({ b, lb: byName.get(b.name)?.linkedBone })).filter((x) => x.lb)
  const morphCache = new Map<string, readonly number[]>()
  const morphIndices = (name: string) => {
    let list = morphCache.get(name)
    if (!list) morphCache.set(name, (list = model.morph.getMorphIndices(name) ?? []))
    return list
  }

  let talking = false
  let voice: (() => number) | undefined
  let blush = false
  let mouth = 0
  let back: number | undefined
  let fps = 60
  let lastFrame = 0
  let warmed = false
  let running = false

  function tick() {
    const now = performance.now()
    // A frame-rate cap: skip frames that come too early (a phone, or a window in the back).
    if (now - lastFrame < 1000 / fps - 2) return
    const dt = Math.min((now - (lastFrame || now)) / 1000, 0.1)
    lastFrame = now
    eng.update(dt)
    for (const { b, lb } of writes) lb!.setRotationQuaternion(bq.set(-b.quaternion.x, -b.quaternion.y, b.quaternion.z, b.quaternion.w), Space.LOCAL)
    const open = voice ? Math.min(1, voice() * VOICE_GAIN) : talking ? FLAP_OPEN * Math.max(0, Math.sin((now / 1000) * Math.PI * 2 * FLAP_HZ)) : 0
    mouth += (open - mouth) * Math.min(1, dt * 18)
    const weights: Record<string, number> = { ...eng.face, あ: Math.max(eng.face['あ'] ?? 0, mouth) }
    if (blush) weights['照れ'] = Math.max(weights['照れ'] ?? 0, 0.6)
    for (const [name, w] of Object.entries(weights)) for (const i of morphIndices(name)) model.morph.setMorphWeightFromIndex(i, w)
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
      flash(GESTURE_EMOTE[g], GESTURE_MS)
    },
    react(kind) {
      flash(kind === 'pat' ? 'shy' : 'surprised', REACT_MS)
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
    setZoom: frame,
    setRunning(on) {
      if (on === running) return
      running = on
      if (on) (lastFrame = 0), engine.runRenderLoop(tick)
      else engine.stopRenderLoop(tick)
    },
    setFps: (f) => void (fps = f),
    setResolution(r) {
      engine.setHardwareScalingLevel(1 / r)
      engine.resize()
    },
    render: () => scene.render(),
    destroy() {
      clearTimeout(back)
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
