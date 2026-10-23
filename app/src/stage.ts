import { Application, Ticker, extensions } from 'pixi.js'
import { Live2DModel, Live2DPlugin, MotionPriority } from 'untitled-pixi-live2d-engine/cubism'

// Adapted from waifufy's overlay/src/stage.ts: same model, config and motion lookup, laid out
// as a visual-novel standing sprite instead of a desktop corner overlay.

export type Kind = 'success' | 'fail' | 'confirm' | 'push' | 'danger'
/** `extra`: more motions layered on top, such as a blush. */
export type Pose = { act: string; face: string; extra?: string[] }
export type Reaction = Pose & { voice?: string }
export type Config = {
  model: string
  scale: number
  volume: number
  idleFps: number
  reactionFps: number
  focus?: { x: number; y: number; radius: number }
  idle: Pose
  reactions: Partial<Record<Kind, Reaction>>
}
export type Stage = Awaited<ReturnType<typeof loadStage>>

/** How far past "whole body fits the canvas" she is zoomed, so the sprite reads as upper body. */
const ZOOM = 1.55
/** Gap between the top of her head and the top of the canvas, in CSS pixels. */
const HEAD_ROOM = 36
const DEFAULT_FOCUS = { x: 0.5, y: 0.15, radius: 400 }

export async function loadStage(container: HTMLElement, base: string, width: number, height: number) {
  const config: Config = await (await fetch(`${base}/config`)).json()
  const asset = (path: string) => `${base}/assets/${path}`

  extensions.add(Live2DPlugin)
  const app = new Application()
  await app.init({
    width,
    height,
    backgroundAlpha: 0,
    antialias: true,
    resolution: Math.min(2, window.devicePixelRatio || 1),
    autoDensity: true,
    preference: 'webgl',
  })
  container.appendChild(app.canvas)
  Ticker.shared.maxFPS = config.idleFps

  const modelUrl = asset(config.model)
  const model = await Live2DModel.from(modelUrl, {
    autoFocus: false,
    autoHitTest: false,
    anchorMode: 'drawable',
    textureOptions: { lod: 'single-auto' },
  })
  model.anchor.set(0.5, 1)
  app.stage.addChild(model)
  // The engine only knows the drawable bounds once the model has been drawn, so draw before measuring.
  for (let i = 0; i < 2; i++) {
    app.render()
    await new Promise(requestAnimationFrame)
  }
  const bodyHeight = config.scale * height * ZOOM
  model.scale.set(bodyHeight / model.height)
  const top = HEAD_ROOM
  model.position.set(width / 2, top + bodyHeight)

  // Rem's model keeps every motion in one unnamed group, so poses are looked up by file name.
  const motionIndex = new Map<string, { group: string; index: number }>()
  const settings = await (await fetch(modelUrl)).json()
  for (const [group, list] of Object.entries<{ File: string }[]>(settings.FileReferences?.Motions ?? {})) {
    list.forEach((m, index) => {
      const name = m.File.split('/').pop()!.replace(/\.motion3\.json$/, '')
      motionIndex.set(name, { group, index })
    })
  }

  const pose = (p: Pose, priority: MotionPriority, loop: boolean) => {
    const list = [p.act, p.face, ...(p.extra ?? [])].flatMap((name) => {
      const hit = motionIndex.get(name)
      if (!hit) console.warn(`[waifufy-code] unknown motion ${name}`)
      return hit ? [{ ...hit, priority, loop }] : []
    })
    // A layer the last pose added (a looping blush) would otherwise outlive it.
    model.internalModel.parallelMotionManager.slice(list.length).forEach((m) => m.stopAllMotions())
    return model.parallelMotion(list)
  }

  const focus = { ...DEFAULT_FOCUS, ...config.focus }
  /** Turns her toward a point given in canvas CSS pixels, scaled by distance like the overlay does. */
  const lookAt = (x: number, y: number) => {
    const dx = x - width / 2
    const dy = y - (top + focus.y * bodyHeight)
    const distance = Math.hypot(dx, dy)
    if (distance < 1) return model.internalModel.focusController.focus(0, 0)
    const strength = Math.min(1, distance / focus.radius)
    model.internalModel.focusController.focus((dx / distance) * strength, (-dy / distance) * strength)
  }

  return { app, model, config, asset, pose, lookAt }
}
