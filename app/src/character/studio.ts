// The pose studio's layer over her 3D model: a dot on each joint a drag moves, kept on her joint every frame. A drag
// poses her (mmd.ts does the reaching and turning); a click picks the joint for its rotation rings. A right-drag turns
// the camera round her and the wheel zooms, as on the other screens.

import type { CharacterStudio } from '../contracts'
import { BOX_W } from './layout.ts'
import type { MmdActor } from './mmd.ts'

/** A press that moves less than this (box pixels) is a click: it picks the joint. */
const CLICK_PX = 4

const LABELS: Record<string, string> = {
  頭: 'Head', 首: 'Neck', 上半身2: 'Chest', 上半身: 'Waist', 左肩: 'Left shoulder', 右肩: 'Right shoulder',
  左ひじ: 'Left elbow', 右ひじ: 'Right elbow', 左手首: 'Left hand', 右手首: 'Right hand',
}

export function createStudioLayer(o: { box: HTMLElement; mmd(): MmdActor | undefined; onZoom(steps: number): void; onActive(on: boolean): void }): CharacterStudio {
  const layer = document.createElement('div')
  layer.className = 'chara-studio'
  layer.dataset.test = 'studio-layer'
  let dots = new Map<string, HTMLElement>()
  let frame = 0
  let selected: string | undefined
  let onSelect: (joint: string | undefined) => void = () => {}
  let press: { joint: string; id: number; x: number; y: number; moved: boolean } | undefined
  let cam: { id: number; x: number; y: number } | undefined

  const toBox = (e: { clientX: number; clientY: number }) => {
    const r = o.box.getBoundingClientRect()
    const s = r.width / BOX_W || 1
    return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s }
  }

  function place() {
    const m = o.mmd()
    for (const h of m?.studio.handles() ?? []) {
      let d = dots.get(h.joint)
      if (!d) {
        const button = document.createElement('button')
        button.type = 'button'
        d = button
        d.className = 'studio-dot'
        d.dataset.joint = h.joint
        d.dataset.test = `studio-dot-${h.joint}`
        d.title = LABELS[h.joint] ?? h.joint
        d.setAttribute('aria-label', d.title)
        layer.append(d)
        dots.set(h.joint, d)
      }
      d.style.transform = `translate(${h.x}px, ${h.y}px)`
      d.classList.toggle('on', h.joint === selected)
    }
    frame = requestAnimationFrame(place)
  }

  // The dots take their own presses (the layer lets the rest through to her canvas, where the rings are picked).
  layer.addEventListener('pointerdown', (e) => {
    const m = o.mmd()
    const dot = (e.target as HTMLElement).closest<HTMLElement>('.studio-dot')
    if (!m || !dot || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const p = toBox(e)
    press = { joint: dot.dataset.joint!, id: e.pointerId, ...p, moved: false }
    dot.setPointerCapture(e.pointerId)
    m.studio.drag(press.joint, p.x, p.y, 'start', e.shiftKey)
  })
  layer.addEventListener('pointermove', (e) => {
    const m = o.mmd()
    if (!press || press.id !== e.pointerId || !m) return
    const p = toBox(e)
    if (!press.moved && Math.hypot(p.x - press.x, p.y - press.y) < CLICK_PX) return
    press.moved = true
    m.studio.drag(press.joint, p.x, p.y, 'move', e.shiftKey)
  })
  const up = (e: PointerEvent) => {
    if (!press || press.id !== e.pointerId) return
    const { joint, moved } = press
    press = undefined
    const p = toBox(e)
    o.mmd()?.studio.drag(joint, p.x, p.y, 'end', e.shiftKey)
    // A click picks the joint for its rings; clicking the picked one again puts them away.
    if (!moved) select(selected === joint ? undefined : joint), onSelect(selected)
  }
  layer.addEventListener('pointerup', up)
  layer.addEventListener('pointercancel', up)

  // The camera, anywhere over her box: a right-drag turns round her, a middle-drag (or Shift) moves up and down her, a
  // right double-click puts it back, the wheel zooms.
  let lastRight = 0
  const camDown = (e: PointerEvent) => {
    if (e.button !== 2 && e.button !== 1) return
    e.preventDefault()
    if (e.button === 2 && performance.now() - lastRight < 350) return (lastRight = 0), o.mmd()?.resetView()
    if (e.button === 2) lastRight = performance.now()
    cam = { id: e.pointerId, ...toBox(e) }
    o.box.setPointerCapture(e.pointerId)
  }
  const camMove = (e: PointerEvent) => {
    if (cam?.id !== e.pointerId) return
    const m = o.mmd()
    const p = toBox(e)
    if (e.shiftKey || e.buttons & 4) m?.pan(p.y - cam.y)
    else m?.orbit(p.x - cam.x, p.y - cam.y)
    cam = { id: e.pointerId, ...p }
  }
  const camUp = (e: PointerEvent) => void (cam?.id === e.pointerId && (cam = undefined))
  const noMenu = (e: Event) => e.preventDefault()
  const wheel = (e: WheelEvent) => {
    e.preventDefault()
    o.onZoom(Math.sign(e.deltaY))
  }
  const listen = (on: boolean) => {
    const f = on ? o.box.addEventListener.bind(o.box) : o.box.removeEventListener.bind(o.box)
    f('pointerdown', camDown as EventListener)
    f('pointermove', camMove as EventListener)
    f('pointerup', camUp as EventListener)
    f('pointercancel', camUp as EventListener)
    f('contextmenu', noMenu)
    on ? o.box.addEventListener('wheel', wheel, { passive: false }) : o.box.removeEventListener('wheel', wheel)
  }

  function select(joint: string | undefined) {
    selected = joint
    o.mmd()?.studio.rings(joint)
  }

  function end() {
    cancelAnimationFrame(frame)
    frame = 0
    select(undefined)
    press = cam = undefined
    listen(false)
    layer.remove()
    for (const d of dots.values()) d.remove()
    dots = new Map()
    o.mmd()?.studio.end()
    o.onActive(false)
  }

  return {
    begin(pose, onEdit, pick) {
      const m = o.mmd()
      if (!m) return
      if (frame) end()
      onSelect = pick
      o.onActive(true)
      o.box.append(layer)
      listen(true)
      m.studio.begin(pose, onEdit)
      frame = requestAnimationFrame(place)
    },
    set: (pose) => o.mmd()?.studio.set(pose),
    select,
    play: (m) => o.mmd()?.play(m),
    turn(yaw, by) {
      const m = o.mmd()
      m?.turn(by ? m.yaw() + yaw : yaw)
    },
    end: () => void (frame && end()),
  }
}
