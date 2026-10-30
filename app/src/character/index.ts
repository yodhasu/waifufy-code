import type { Costume, ServerMsg } from '../../../link/src/protocol.ts'
import type { Character, Link, Placement, ScreenName, Store } from '../contracts'
import './character.css'
import { createDirector, type Actor } from './director.ts'
import { createFx } from './fx.ts'
import { createInteract } from './interact.ts'
import { BOX_H, BOX_LEFT, BOX_W, HIDDEN_DROP, PHONE_LANDSCAPE, PLACEMENTS, portraitPlacements, STAGE_H, STAGE_W } from './layout.ts'
// The engine is imported on first use (see startStage): it throws at import when the Cubism core is missing.
import type { Rig, Stage } from './live2d.ts'
import type { MmdActor } from './mmd.ts'
import type { Mark } from './motions.ts'
import { createPlaceholder, type Placeholder } from './placeholder.ts'

// The character layer (#chara): loads her costumes, keeps her alive and lets her be touched. Everything she does
// goes through the director, which drives the Live2D rig, a 3D (MMD) model when the waifu card has one, or the
// placeholder sprite.

const COSTUMES_TIMEOUT_MS = 8000
/**
 * A models-folder change waits this long before she reloads, so typing a path doesn't list every prefix of it,
 * and an emptied path (the default folder) is read after the store has saved settings.json (state.ts, 400 ms).
 */
const FOLDER_SETTLE_MS = 900
/** main.ts waits on `ready` before showing the first screen; past this the placeholder shows meanwhile. */
const READY_TIMEOUT_MS = 12000
const CROSSFADE_MS = 450
/** Matches the placement transition in character.css; the canvas stops rendering once she has faded out. */
const HIDE_MS = 700
const RESIZE_DEBOUNCE_MS = 150
const MAX_RESOLUTION = 2
const FPS_FRONT = 60
const FPS_BACK = 30
const JPEG_QUALITY = 0.86
// The stage backdrop as base.css #stage paints it, for the snapshot: sky color stops, the sun's center height and
// its ellipse radii (fractions of the stage), where the sun has faded out, and the floor shade's height.
const SKY_STOPS = [0, 0.38, 0.72, 1]
const SUN_Y = 0.28
const SUN_RX = 0.6
const SUN_RY = 0.5
const SUN_FADE = 0.7
const FLOOR_H = 260

/** Where she stands on each screen unless the screen says otherwise with setPlacement. */
const SCREEN_PLACEMENT: Record<ScreenName, Placement> = {
  title: 'title', chat: 'chat', settings: 'side', wizard: 'side', saves: 'hidden',
}

const TEMPLATE = `
<div class="chara-box">
  <div class="chara-glow"></div>
  <div class="chara-fx"></div>
</div>`

type CostumesMsg = Extract<ServerMsg, { t: 'costumes' }>

/** Folder paths compared loosely: the sidecar answers with the resolved path, in Windows or POSIX form. */
const samePath = (a: string, b: string) => {
  const norm = (d: string) => d.trim().replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
  return norm(a) === norm(b)
}

export function createCharacter(root: HTMLElement, link: Link, store: Store): Character {
  root.innerHTML = TEMPLATE
  const box = root.querySelector<HTMLElement>('.chara-box')!
  const fxLayer = root.querySelector<HTMLElement>('.chara-fx')!
  const stageEl = (root.closest('#stage') as HTMLElement | null) ?? document.getElementById('stage') ?? root
  box.style.left = `${BOX_LEFT}px`
  box.style.width = `${BOX_W}px`
  box.style.height = `${BOX_H}px`

  const ds = root.dataset
  ds.emotion = 'normal'
  ds.talking = '0'
  ds.busy = '0'
  ds.gesture = ''
  ds.costume = ''

  let stage: Stage | undefined
  let stageReady: Promise<Stage> | undefined
  let rig: Rig | undefined
  /** The card's 3D model, when it has one; it takes the Live2D rig's place while it is loaded. */
  let mmd: MmdActor | undefined
  /** The .pmx being loaded, so a newer card wins over an older one still in flight. */
  let mmdLoading: string | undefined
  let sprite: Placeholder | undefined
  let list: Costume[] = []
  /** The costume being loaded, so a newer request wins over an older one still in flight. */
  let loading: string | undefined
  let placement: Placement = 'title'
  /** What the screen asked for; in portrait 'side' shows as hidden, and a rotation re-applies it. */
  let requested: Placement = 'title'
  let lastVisible: Exclude<Placement, 'hidden'> = 'title'
  let hideTimer: number | undefined

  const actor = (): Actor | undefined => mmd ?? rig ?? sprite
  const fx = createFx(fxLayer)
  const spawnFx = (mark: Mark) => {
    const a = actor()
    if (a && placement !== 'hidden') fx.spawn(mark, a.geometry().head)
  }
  const motion = () => store.get().motion
  const director = createDirector({
    motion,
    onEmotion: (e) => (ds.emotion = e),
    onGesture: (g) => (ds.gesture = g),
    fx: spawnFx,
  })
  const patListeners = new Set<() => void>()
  /** Her voice's loudness while a clip plays; every rig loaded meanwhile follows it too. */
  let voiceLevel: (() => number) | undefined
  const interact = createInteract({ root, box, actor, director, motion, fx: spawnFx, onPat: () => patListeners.forEach((f) => f()) })

  // ---------------------------------------------------------------- rendering

  const stageScale = () => Number(stageEl.dataset.scale) || stageEl.getBoundingClientRect().width / STAGE_W || 1
  const portrait = () => stageEl.dataset.orient === 'portrait'
  const spot = () =>
    (portrait() ? portraitPlacements(stageEl.offsetHeight, stageEl.dataset.compact === 'on') : stageEl.dataset.device === 'phone' ? PHONE_LANDSCAPE : PLACEMENTS)[lastVisible]
  const visibleScale = () => spot().scale
  const resolution = () => Math.min(MAX_RESOLUTION, (devicePixelRatio || 1) * stageScale() * visibleScale())

  function updateRunning() {
    const shown = !document.hidden && placement !== 'hidden'
    stage?.setRunning(rig !== undefined && !mmd && shown)
    mmd?.setRunning(shown)
  }

  let resizeTimer: number | undefined
  addEventListener('resize', () => {
    // A portrait stage changes height with the window, and her spot hangs from its bottom.
    if (portrait()) applyPlacement()
    clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(() => (stage?.setResolution(resolution()), mmd?.setResolution(resolution())), RESIZE_DEBOUNCE_MS)
  })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) interact.reset()
    updateRunning()
  })
  // Full motion only where it is watched: 60 fps in the focused desktop window, 30 on a phone (battery) or while
  // another window is in front. Her breathing and blinks look the same at 30.
  const updateFps = () => {
    const fps = stageEl.dataset.device !== 'phone' && document.hasFocus() ? FPS_FRONT : FPS_BACK
    stage?.setFps(fps)
    mmd?.setFps(fps)
  }
  addEventListener('focus', updateFps)
  addEventListener('blur', updateFps)

  function applyPlacement() {
    const { x, y, scale } = spot()
    const drop = placement === 'hidden' ? HIDDEN_DROP : 0
    box.style.transform = `translate(${x}px, ${y + drop}px) scale(${scale})`
    ds.placement = placement
    clearTimeout(hideTimer)
    if (placement === 'hidden') fx.clear(), (hideTimer = window.setTimeout(updateRunning, HIDE_MS))
    else updateRunning()
    stage?.setResolution(resolution())
    mmd?.setResolution(resolution())
    interact.refresh()
  }

  function setPlacement(asked: Placement) {
    requested = asked
    // The settings preview has no room on a phone.
    const p = asked === 'side' && portrait() ? 'hidden' : asked
    placement = p
    if (p !== 'hidden') lastVisible = p
    if (p === 'hidden') interact.reset()
    applyPlacement()
  }
  setPlacement(SCREEN_PLACEMENT[stageEl.dataset.screen as ScreenName] ?? 'title')

  // Follow the router by default. The router sets data-screen and then calls the screen's show(), and the
  // observer only runs after that, so a setPlacement made in the same task marks itself and wins.
  let isPlacedThisTask = false
  function placeExplicitly(p: Placement) {
    setPlacement(p)
    isPlacedThisTask = true
    queueMicrotask(() => (isPlacedThisTask = false))
  }
  new MutationObserver((records) => {
    // A rotation, or the keyboard coming up (compact), keeps what the screen asked for, in that layout's spot.
    if (records.every((r) => r.attributeName === 'data-orient' || r.attributeName === 'data-compact')) return setPlacement(requested)
    const p = SCREEN_PLACEMENT[stageEl.dataset.screen as ScreenName]
    if (p && !isPlacedThisTask) setPlacement(p)
  }).observe(stageEl, { attributes: true, attributeFilter: ['data-screen', 'data-orient', 'data-compact'] })

  // ---------------------------------------------------------------- costumes

  /**
   * Lists the models folder from settings. Other screens scan other folders with the same message, so only the
   * reply for this folder counts (with no folder set, the sidecar reads its default from settings.json).
   */
  async function fetchCostumes() {
    const dir = store.get().appearance.modelsDir.trim()
    const reply = link.next((m): m is CostumesMsg => m.t === 'costumes' && (!dir || samePath(m.dir, dir)), COSTUMES_TIMEOUT_MS)
    link.send({ t: 'costumes', ...(dir ? { dir } : {}) })
    return (await reply).list
  }

  function showPlaceholder() {
    if (sprite || rig || mmd) return
    sprite = createPlaceholder(box, store.get().appearance.zoom)
    sprite.setVoice(voiceLevel)
    box.insertBefore(sprite.el, fxLayer)
    director.setActor(sprite)
    interact.refresh()
    ds.model = 'placeholder'
    ds.costume = ''
  }

  /** Fades the placeholder out over the incoming model instead of leaving the stage empty for a moment. */
  function dropPlaceholder() {
    const old = sprite
    if (!old) return
    sprite = undefined
    old.el.style.pointerEvents = 'none'
    old.el.style.transition = `opacity ${CROSSFADE_MS}ms ease`
    old.el.style.opacity = '0'
    window.setTimeout(() => old.destroy(), CROSSFADE_MS)
  }

  /** Ends the running crossfade early: the costume it was leaving goes, the incoming one stays as it is. */
  let endFade: (() => void) | undefined
  /** The current model's opacity, which a crossfade interrupted by another swap fades out from. */
  let rigOpacity = 1

  function crossfade(next: Rig, prev: Rig | undefined) {
    endFade?.()
    const app = stage!.app
    const from = rigOpacity
    const startAt = performance.now()
    const step = () => {
      const k = Math.min(1, (performance.now() - startAt) / CROSSFADE_MS)
      next.setOpacity((rigOpacity = k))
      prev?.setOpacity(from * (1 - k))
      if (k === 1) end()
    }
    const end = () => {
      app.ticker.remove(step)
      endFade = undefined
      prev?.destroy()
    }
    endFade = end
    if (!app.ticker.started) return void (next.setOpacity((rigOpacity = 1)), end())
    app.ticker.add(step)
  }

  const engine = () => import('./live2d.ts')

  async function startStage() {
    // The core is never committed (Live2D's license; see README), so a fresh checkout may lack it.
    if (!('Live2DCubismCore' in window)) throw new Error('the Live2D Cubism core (live2dcubismcore.min.js) is missing')
    const s = await (await engine()).createStage(resolution())
    box.insertBefore(s.app.canvas, fxLayer)
    stage = s
    updateRunning()
    updateFps()
    return s
  }

  /** Loads a costume and swaps to it. On any failure she keeps what she has and it is only logged. */
  async function swapTo(id: string, withGesture: boolean) {
    // A 3D card has no costumes; the Live2D one loads again when the card goes back to Live2D.
    if (mmd || mmdLoading) return
    const costume = list.find((c) => c.id === id)
    if (!costume) return void console.warn(`[waifufy-code] no costume "${id}" in the models folder`)
    loading = id
    if (rig?.costume === id) return void (loading = undefined)
    try {
      // A failed start is retried by the next swap.
      stageReady ??= startStage().catch((e) => {
        stageReady = undefined
        throw e
      })
      const s = await stageReady
      const next = await (await engine()).loadRig(s, id, link.base + costume.modelUrl, store.get().appearance.zoom)
      if (loading !== id) return next.destroy()
      loading = undefined
      const prev = rig
      rig = next
      next.setVoice(voiceLevel)
      updateRunning()
      fx.clear()
      director.setActor(next)
      interact.refresh()
      crossfade(next, prev)
      dropPlaceholder()
      ds.model = 'live2d'
      ds.costume = id
      if (store.get().appearance.costume !== id) store.update((s) => void (s.appearance.costume = id))
      if (withGesture) director.gesture('costume')
    } catch (e) {
      if (loading === id) loading = undefined
      console.warn(`[waifufy-code] costume "${id}" failed to load; keeping the current look`, e)
    }
  }

  /** The saved costume if the folder has it, else the first one found. */
  const preferred = () => {
    const want = store.get().appearance.costume
    return (list.find((c) => c.id === want) ?? list[0])?.id
  }

  /** Bumped by every folder reload, so an older listing still in flight never overwrites a newer one. */
  let folderRequest = 0

  async function reloadFolder() {
    const my = ++folderRequest
    let found: Costume[]
    try {
      found = await fetchCostumes()
    } catch (e) {
      if (my === folderRequest) console.warn('[waifufy-code] could not list costumes', e)
      return
    }
    if (my !== folderRequest) return
    list = found
    const id = preferred()
    if (id && id !== rig?.costume) await swapTo(id, rig !== undefined)
    if (!rig) showPlaceholder()
  }

  // ---------------------------------------------------------------- a 3D card

  /** The .pmx the card asks for, or undefined for Live2D. */
  const wantedMmd = () => {
    const a = store.get().appearance
    return a.model === 'mmd' && a.mmdFile.trim() ? a.mmdFile.trim() : undefined
  }

  /** Loads the card's 3D model and puts it in the Live2D rig's place. False when it couldn't (she keeps her look). */
  async function useMmd(file: string) {
    if (mmd?.file === file) return true
    mmdLoading = file
    try {
      // The link serves the folder of the active card's .pmx; textures load from it by their relative paths.
      const name = file.split(/[\\/]/).pop()!
      const { loadMmd } = await import('./mmd.ts')
      const next = await loadMmd(box, fxLayer, `${link.base}/mmd/${encodeURIComponent(name)}`, file, store.get().appearance.zoom, resolution())
      if (mmdLoading !== file) return next.destroy(), false
      mmdLoading = undefined
      const prev = mmd
      mmd = next
      prev?.destroy()
      next.setVoice(voiceLevel)
      if (stage) stage.app.canvas.style.display = 'none'
      updateRunning()
      updateFps()
      fx.clear()
      director.setActor(next)
      interact.refresh()
      dropPlaceholder()
      ds.model = 'mmd'
      ds.costume = ''
      return true
    } catch (e) {
      if (mmdLoading === file) mmdLoading = undefined
      console.warn(`[waifufy-code] her 3D model (${file}) failed to load; showing her Live2D costume`, e)
      return false
    }
  }

  /** Back to the Live2D costume (or the placeholder until it loads). */
  function dropMmd() {
    mmdLoading = undefined
    const old = mmd
    if (!old) return
    mmd = undefined
    old.destroy()
    if (stage) stage.app.canvas.style.display = ''
    updateRunning()
    if (rig) {
      director.setActor(rig)
      interact.refresh()
      ds.model = 'live2d'
      ds.costume = rig.costume
    } else showPlaceholder()
    void reloadFolder()
  }

  /** Follows the card: its 3D model when it has one, else the Live2D costume. */
  async function applyModel() {
    const want = wantedMmd()
    if (want && (await useMmd(want))) return
    if (want && mmdLoading) return
    dropMmd()
    if (!rig) await reloadFolder()
  }

  const ready = Promise.race([
    applyModel(),
    new Promise<void>((r) => setTimeout(r, READY_TIMEOUT_MS)),
  ]).then(() => {
    if (!rig) showPlaceholder()
  }, (e) => {
    console.warn('[waifufy-code] character failed to start', e)
    showPlaceholder()
  })

  // A listing lost to a sidecar restart is asked for again once the link is back (R24).
  link.onStatus((status) => {
    if (status === 'up' && !rig && !mmd && loading === undefined && mmdLoading === undefined) void applyModel()
  })

  // ---------------------------------------------------------------- live settings

  let lastSettings = store.get()
  let folderTimer: number | undefined
  let modelTimer: number | undefined
  store.subscribe((s) => {
    const was = lastSettings
    lastSettings = s
    if (s.appearance.zoom !== was.appearance.zoom) actor()?.setZoom(s.appearance.zoom)
    if (s.appearance.model !== was.appearance.model || s.appearance.mmdFile !== was.appearance.mmdFile) {
      // After the store has saved settings.json: the link serves the 3D model of the card as it has it on disk.
      clearTimeout(modelTimer)
      modelTimer = window.setTimeout(() => void applyModel(), FOLDER_SETTLE_MS)
    } else if (s.appearance.modelsDir !== was.appearance.modelsDir) {
      clearTimeout(folderTimer)
      folderTimer = window.setTimeout(() => void reloadFolder(), FOLDER_SETTLE_MS)
    } else if (s.appearance.costume !== was.appearance.costume && s.appearance.costume !== (loading ?? rig?.costume)) {
      void swapTo(s.appearance.costume, true)
    }
    director.refresh()
    interact.refresh()
  })

  // ---------------------------------------------------------------- snapshot

  function cssVar(name: string) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  }

  /**
   * The same color at zero alpha. A canvas gradient toward 'transparent' (transparent black) passes through
   * gray, where CSS gradients don't.
   */
  function faded(g: CanvasRenderingContext2D, color: string) {
    g.fillStyle = color
    const c = String(g.fillStyle)
    const [r, gr, b] = c.startsWith('#') ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) : c.match(/[\d.]+/g)!.map(Number)
    return `rgba(${r}, ${gr}, ${b}, 0)`
  }

  /** The stage backdrop as base.css paints it: the sky gradient, the sun glow and the floor shade. */
  function paintBackdrop(g: CanvasRenderingContext2D) {
    const sky = g.createLinearGradient(0, 0, 0, STAGE_H)
    SKY_STOPS.forEach((at, k) => sky.addColorStop(at, cssVar(`--sky-${k + 1}`)))
    g.fillStyle = sky
    g.fillRect(0, 0, STAGE_W, STAGE_H)
    g.save()
    g.translate(STAGE_W / 2, STAGE_H * SUN_Y)
    g.scale(1, (STAGE_H * SUN_RY) / (STAGE_W * SUN_RX))
    const sun = g.createRadialGradient(0, 0, 0, 0, 0, STAGE_W * SUN_RX)
    const sunColor = cssVar('--sun')
    sun.addColorStop(0, sunColor)
    sun.addColorStop(SUN_FADE, faded(g, sunColor))
    g.fillStyle = sun
    g.fillRect(-STAGE_W, -STAGE_W, STAGE_W * 2, STAGE_W * 2)
    g.restore()
    const floor = g.createLinearGradient(0, STAGE_H - FLOOR_H, 0, STAGE_H)
    const floorColor = cssVar('--floor')
    floor.addColorStop(0, faded(g, floorColor))
    floor.addColorStop(1, floorColor)
    g.fillStyle = floor
    g.fillRect(0, STAGE_H - FLOOR_H, STAGE_W, FLOOR_H)
  }

  async function snapshot(width: number, height: number) {
    try {
      const out = document.createElement('canvas')
      out.width = width
      out.height = height
      const g = out.getContext('2d')!
      // Cover-fit the 1600×900 stage into the thumbnail and draw in stage pixels.
      const k = Math.max(width / STAGE_W, height / STAGE_H)
      g.translate((width - STAGE_W * k) / 2, (height - STAGE_H * k) / 2)
      g.scale(k, k)
      paintBackdrop(g)
      const s = stageScale()
      const stageRect = stageEl.getBoundingClientRect()
      const at = (el: Element) => {
        const r = el.getBoundingClientRect()
        return [(r.left - stageRect.left) / s, (r.top - stageRect.top) / s, r.width / s, r.height / s] as const
      }
      if (mmd) {
        mmd.render()
        g.drawImage(mmd.canvas, ...at(mmd.canvas))
      } else if (rig && stage) {
        // The WebGL buffer is only valid in the task that drew it, so render and copy back to back.
        stage.app.render()
        g.drawImage(stage.app.canvas, ...at(stage.app.canvas))
      } else if (sprite) {
        // Measured before the await: the placement may start moving while the image decodes.
        const rect = at(sprite.el)
        const img = await sprite.image()
        g.drawImage(img, ...rect)
      }
      return out.toDataURL('image/jpeg', JPEG_QUALITY)
    } catch (e) {
      console.warn('[waifufy-code] snapshot failed', e)
      return undefined
    }
  }

  // ---------------------------------------------------------------- the Character contract

  return {
    ready,
    hasModel: () => rig !== undefined || mmd !== undefined,
    costumes: () => list,
    async setCostume(id) {
      if (!list.some((c) => c.id === id)) list = await fetchCostumes().catch(() => list)
      await swapTo(id, true)
    },
    emote: (e) => director.emote(e),
    gesture: (g) => director.gesture(g),
    setTalking(on) {
      ds.talking = on ? '1' : '0'
      director.setTalking(on)
    },
    setBusy(on) {
      ds.busy = on ? '1' : '0'
      director.setBusy(on)
    },
    setPlacement: placeExplicitly,
    snapshot,
    setVoiceLevel(level) {
      voiceLevel = level
      ds.voice = level ? '1' : '0'
      actor()?.setVoice(level)
    },
    onHeadpat(fn) {
      patListeners.add(fn)
      return () => patListeners.delete(fn)
    },
  }
}
