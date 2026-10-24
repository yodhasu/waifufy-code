import { AlphaFilter, Application, Assets, extensions } from 'pixi.js'
import { Live2DModel, Live2DPlugin, MotionPriority, type CubismInternalModel } from 'untitled-pixi-live2d-engine/cubism'
import type { Actor, Geometry } from './director.ts'
import { BOX_H, BOX_W } from './layout.ts'
import { first, indexMotions, isHold, resolvePose, type MotionIndex, type MotionRef, type Pose } from './motions.ts'

// The Live2D side: one Pixi Application for the character box, and a Rig per loaded costume that implements
// the director's Actor. The engine facts this relies on are in docs/audit-v0.md (live2d):
// - Holds are constant frames, so all life (blink, mouth, blush) is added in `beforeModelUpdate`, after the
//   motions and before the model is drawn; the engine restores the motion values right after each frame.
// - The engine's own eye blink never runs while a motion plays, and its lip sync only runs with real audio.
// - Parallel slots: act (body), face (head + expression, overrides the act's own face), add-on (head turns).

/** Her whole body is this many box heights tall at zoom 1, so the box frames her from the knees up. */
const BODY_FIT = 1.5
/** Gap between the top of her hair and the top of the box, in box pixels. */
const HEAD_ROOM = 36
// Points on her body as fractions of her body height, measured from the top of her hair.
const HEAD_Y = 0.055
const HEAD_R = 0.065
const FACE_Y = 0.125
const FACE_R = 0.06
const BODY_Y = 0.4
const BODY_RX = 0.14
const BODY_RY = 0.28

const ACT = 0
const FACE = 1
const ADDON = 2
const SLOTS = 3
// Seconds. Cubism's default fades are 0.5–1 s, which flattens a 0.7 s gesture into a slow morph.
const SHOT_FADE_IN = 0.2
const SHOT_FADE_OUT = 0.3
const HOLD_FADE_IN = 0.45
const HOLD_FADE_OUT = 0.45
const ADDON_FADE = 0.6

const BLINK_MS = 150
/** Share of a blink spent closing; opening is slower, as with real lids. */
const BLINK_CLOSE = 0.35
const BLINK_GAP_MS: [number, number] = [2000, 6000]
const DOUBLE_BLINK_CHANCE = 0.22
const DOUBLE_BLINK_GAP_MS = 110

/** Syllables per second while talking, and how wide the mouth opens on each. */
const TALK_HZ: [number, number] = [8, 12]
const TALK_OPEN: [number, number] = [0.35, 0.95]
const TALK_CLOSED: [number, number] = [0, 0.12]
/** Share of a syllable the mouth is opening; the rest it is closing. */
const TALK_OPEN_SHARE = 0.55
/** Smoothing time constants, ms: the mouth follows its target quickly, the blush fades slowly. */
const MOUTH_TAU = 28
const BLUSH_TAU = 260
const MAX_DT = 100
const TICKER_FPS = 60
/** Frames drawn before measuring: the engine only knows the drawable bounds once the model has been drawn. */
const BOUNDS_FRAMES = 2

const rand = ([lo, hi]: [number, number]) => lo + Math.random() * (hi - lo)

type ModelJson = {
  FileReferences?: { Motions?: Record<string, { File: string }[]>; Textures?: string[] }
  Groups?: { Name: string; Ids: string[] }[]
  url?: string
}

let isPluginAdded = false

export type Stage = {
  app: Application
  /** Re-renders at a new pixel density (devicePixelRatio × CSS scale), keeping the box size. */
  setResolution(resolution: number): void
  setRunning(on: boolean): void
}

/** The caller places `app.canvas` in the page. */
export async function createStage(resolution: number): Promise<Stage> {
  if (!isPluginAdded) extensions.add(Live2DPlugin), (isPluginAdded = true)
  const app = new Application()
  await app.init({
    width: BOX_W,
    height: BOX_H,
    backgroundAlpha: 0,
    antialias: true,
    resolution,
    autoDensity: true,
    preference: 'webgl',
    // Nothing on the stage is interactive (interact.ts reads DOM pointer events). Pixi's event system would also
    // write an inline cursor on the canvas at every pointer move, hiding the grab and pointer cursors.
    eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
  })
  app.renderer.events.cursorStyles.default = ''
  app.ticker.maxFPS = TICKER_FPS
  return {
    app,
    setResolution(r) {
      if (Math.abs(app.renderer.resolution - r) > 0.01) app.renderer.resize(BOX_W, BOX_H, r)
    },
    setRunning(on) {
      if (on === app.ticker.started) return
      on ? app.ticker.start() : app.ticker.stop()
    },
  }
}

/** Blink timing: k is 1 with the eyes as the pose has them, 0 fully closed. */
function createBlink() {
  let nextAt = performance.now() + rand(BLINK_GAP_MS)
  let startAt: number | undefined
  let isDouble = false
  return (now: number) => {
    if (startAt === undefined) {
      if (now < nextAt) return 1
      startAt = now
    }
    const t = (now - startAt) / BLINK_MS
    if (t >= 1) {
      startAt = undefined
      nextAt = isDouble ? now + DOUBLE_BLINK_GAP_MS : now + rand(BLINK_GAP_MS)
      isDouble = !isDouble && Math.random() < DOUBLE_BLINK_CHANCE
      return 1
    }
    return t < BLINK_CLOSE ? 1 - t / BLINK_CLOSE : (t - BLINK_CLOSE) / (1 - BLINK_CLOSE)
  }
}

/** Mouth flap for the typewriter: syllables of jittered length and width, smoothed. */
function createMouth() {
  let isOn = false
  let value = 0
  let target = 0
  let syllableAt = 0
  let syllableMs = 0
  let openTarget = 0
  let closedTarget = 0
  return {
    set(on: boolean) {
      isOn = on
    },
    update(now: number, dt: number) {
      if (isOn) {
        if (now - syllableAt >= syllableMs) {
          syllableAt = now
          syllableMs = 1000 / rand(TALK_HZ)
          openTarget = rand(TALK_OPEN)
          closedTarget = rand(TALK_CLOSED)
        }
        target = now - syllableAt < syllableMs * TALK_OPEN_SHARE ? openTarget : closedTarget
      } else {
        target = 0
      }
      value += (target - value) * (1 - Math.exp(-dt / MOUTH_TAU))
      return value
    },
  }
}

export type Rig = Actor & {
  model: Live2DModel
  costume: string
  /** Fades the model as one picture (an AlphaFilter), so her inner layers never show through each other. */
  setOpacity(alpha: number): void
}

/** Loads a costume into the stage. Rejects if the model can't be loaded; the caller keeps what it had. */
export async function loadRig(stage: Stage, costume: string, url: string, zoom: number): Promise<Rig> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} loading ${url}`)
  const json = (await res.json()) as ModelJson
  // The engine loads the atlases through Pixi's Assets, keyed by these URLs (it resolves them the same way).
  // Unloading them with the model keeps only the costumes on screen resident.
  const textures = (json.FileReferences?.Textures ?? []).map((t) => new URL(t, url).href)
  for (const t of textures) textureUsers.set(t, (textureUsers.get(t) ?? 0) + 1)
  let model: Live2DModel | undefined
  try {
    model = await Live2DModel.from(
      { ...json, url },
      {
        autoFocus: false,
        autoHitTest: false,
        anchorMode: 'drawable',
        // One texture sized to what is on screen, instead of a full mipmap chain.
        textureOptions: { lod: 'single-auto' },
        ticker: stage.app.ticker,
      },
    )
    stage.app.stage.addChild(model)
    return await rig(stage, model, json, costume, zoom, () => release(stage, model, textures))
  } catch (e) {
    release(stage, model, textures)
    throw e
  }
}

/** How many loaded models use each texture URL: the same costume can be loading while its old copy fades out. */
const textureUsers = new Map<string, number>()

function release(stage: Stage, model: Live2DModel | undefined, textures: string[]) {
  if (model && !model.destroyed) {
    stage.app.stage.removeChild(model)
    model.destroy({ children: true })
  }
  const unused = textures.filter((t) => {
    const users = (textureUsers.get(t) ?? 1) - 1
    users > 0 ? textureUsers.set(t, users) : textureUsers.delete(t)
    return users <= 0
  })
  if (unused.length) Assets.unload(unused).catch((e) => console.warn('[waifufy-code] could not unload costume textures', e))
}

/** Lays a freshly loaded model out in the box and wires up its motions and life. */
async function rig(stage: Stage, model: Live2DModel, json: ModelJson, costume: string, zoom: number, unload: () => void): Promise<Rig> {
  const index: MotionIndex = indexMotions(json.FileReferences?.Motions ?? {})
  model.anchor.set(0.5, 1)
  model.alpha = 0
  // The engine only knows the drawable bounds once the model has been drawn, so draw before measuring. The
  // model only advances on its ticker, which may be paused, so step it by hand.
  for (let i = 0; i < BOUNDS_FRAMES; i++) {
    model.update(1000 / TICKER_FPS)
    stage.app.render()
    await new Promise(requestAnimationFrame)
  }
  const naturalHeight = model.height / model.scale.y
  let bodyHeight = 0
  const layout = (z: number) => {
    bodyHeight = BODY_FIT * BOX_H * z
    model.scale.set(bodyHeight / naturalHeight)
    model.position.set(BOX_W / 2, HEAD_ROOM + bodyHeight)
  }
  layout(zoom)

  // Rem's costumes are all Cubism 3+ models.
  const internal = model.internalModel as CubismInternalModel
  internal.extendParallelMotionManager(SLOTS)
  const slot = (n: number) => internal.parallelMotionManager[n]!
  const motions = internal.motionManager

  type Prepared = { durationMs: number }
  const prepared = new Map<string, Promise<Prepared | undefined>>()
  /** Loads a motion once and sets its fades: holds blend in gently, gestures snap in. */
  function prepare(ref: MotionRef) {
    let p = prepared.get(ref.suffix)
    if (!p) {
      p = motions.loadMotion(ref.group, ref.index).then((m) => {
        if (!m) return undefined
        const isAddon = ref.suffix.startsWith('add_')
        const hold = isHold(ref.suffix)
        m.setFadeInTime(isAddon ? ADDON_FADE : hold ? HOLD_FADE_IN : SHOT_FADE_IN)
        m.setFadeOutTime(isAddon ? ADDON_FADE : hold ? HOLD_FADE_OUT : SHOT_FADE_OUT)
        // By default every loop restart fades the motion in again from zero, which snaps the head back toward
        // the neutral pose once per loop (about every second on the short holds). Fade in once, then loop clean.
        m.setLoopFadeIn(false)
        // getDuration() is -1 for looping motions, and every Rem motion is marked as looping in its file.
        return { durationMs: m.getLoopDuration() * 1000 }
      })
      prepared.set(ref.suffix, p)
    }
    return p
  }
  // Warm every motion up front, so the first gesture doesn't wait on a fetch.
  for (const ref of index.values()) void prepare(ref)

  function start(n: number, ref: MotionRef) {
    const hold = isHold(ref.suffix)
    // A one-shot restarts even when it is the motion already playing (a second nod nods again).
    if (!hold) slot(n).stopAllMotions()
    return slot(n).startMotion(ref.group, ref.index, MotionPriority.FORCE, { loop: hold })
  }

  // ---------------------------------------------------------------- life: blink, mouth, blush

  const core = internal.coreModel
  const ids = core.getModel().parameters.ids
  const group = (name: string, fallback: string[]) => json.Groups?.find((g) => g.Name === name)?.Ids ?? fallback
  const indices = (list: string[]) => list.map((id) => ids.indexOf(id)).filter((i) => i >= 0)
  const eyes = indices(group('EyeBlink', ['ParamEyeLOpen', 'ParamEyeROpen']))
  const mouths = indices(group('LipSync', ['ParamMouthOpenY']))
  const cheek = ids.indexOf('ParamCheek')
  const blink = createBlink()
  const mouth = createMouth()
  let blush = 0
  let blushTarget = 0
  let lastAt = performance.now()

  // Multiplying keeps closed-eye smiles (face_egao_w holds the eyes at 0) closed; adding keeps a face's own
  // mouth shape underneath the flap.
  const onBeforeUpdate = () => {
    const now = performance.now()
    const dt = Math.min(MAX_DT, now - lastAt)
    lastAt = now
    const k = blink(now)
    if (k < 1) for (const i of eyes) core.setParameterValueByIndex(i, core.getParameterValueByIndex(i) * k)
    const open = mouth.update(now, dt)
    if (open > 0.005) for (const i of mouths) core.addParameterValueByIndex(i, open)
    blush += (blushTarget - blush) * (1 - Math.exp(-dt / BLUSH_TAU))
    if (cheek >= 0 && blush > 0.005) core.addParameterValueByIndex(cheek, blush)
  }
  internal.on('beforeModelUpdate', onBeforeUpdate)

  /** Bumped by every pose, so a pose still loading never lands after a newer one. */
  let token = 0
  // From here on the model fades as one picture. It starts out invisible; the caller fades it in.
  let fade: AlphaFilter | undefined = new AlphaFilter({ alpha: 0, resolution: 'inherit' })
  model.filters = [fade]
  model.alpha = 1

  return {
    kind: 'live2d',
    model,
    costume,

    async pose(p: Pose) {
      const r = resolvePose(index, p)
      if (!r) return -1
      const my = ++token
      const [act] = await Promise.all([prepare(r.act), r.face && prepare(r.face)])
      if (my !== token || !act) return 0
      void start(ACT, r.act)
      if (r.face) void start(FACE, r.face)
      else slot(FACE).stopAllMotions()
      return isHold(r.act.suffix) ? 0 : act.durationMs
    },

    resolve(p: Pose) {
      const r = resolvePose(index, p)
      return r && `${r.act.suffix}|${r.face?.suffix ?? ''}`
    },

    async addon(candidates: string[]) {
      const ref = first(index, candidates)
      if (!ref) return -1
      const m = await prepare(ref)
      if (!m) return -1
      void start(ADDON, ref)
      return m.durationMs
    },

    setBlush(on: boolean) {
      blushTarget = on ? 1 : 0
    },

    setTalking(on: boolean) {
      mouth.set(on)
    },

    focus(x: number, y: number) {
      internal.focusController.focus(x, y)
    },

    geometry(): Geometry {
      const at = (f: number) => HEAD_ROOM + f * bodyHeight
      const x = BOX_W / 2
      return {
        head: { x, y: at(HEAD_Y), r: HEAD_R * bodyHeight },
        face: { x, y: at(FACE_Y), r: FACE_R * bodyHeight },
        body: { x, y: at(BODY_Y), rx: BODY_RX * bodyHeight, ry: BODY_RY * bodyHeight },
      }
    },

    setZoom: layout,

    setOpacity(alpha: number) {
      if (alpha >= 1) {
        model.filters = null
        fade?.destroy()
        fade = undefined
        return
      }
      if (!fade) model.filters = [(fade = new AlphaFilter({ alpha, resolution: 'inherit' }))]
      fade.alpha = alpha
    },

    destroy() {
      internal.off('beforeModelUpdate', onBeforeUpdate)
      unload()
      fade?.destroy()
    },
  }
}
