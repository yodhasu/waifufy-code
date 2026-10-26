import type { MotionSettings } from '../../../link/src/protocol.ts'
import type { Actor, Director, Geometry } from './director.ts'
import { BOX_W } from './layout.ts'
import { BODY_TAPS, FACE_TAPS, PAT_BUSY, PAT_TIERS, type Mark, type Tier } from './motions.ts'

// Pointer life: her head and eyes follow the cursor anywhere in the window (R32), press-and-drag on her head
// pats her (R33, ported from waifufy's overlay without voices), and clicks on her face or body are taps (R34).
// Only her own canvas receives presses, and only while the pointer is over her, so UI above her always wins.

/** A full head turn at this many head radii from her head, like the overlay's focus radius. */
const FOCUS_RADII = 5
/** She looks back to the front after the cursor rests this long, or leaves the window. */
const FOCUS_IDLE_MS = 3000
// A press on her head becomes a pat once the pointer has stroked this far (box pixels).
const PAT_DISTANCE = 30
// Stroking counts as nonstop while the pointer moved within this long.
const STILL_MS = 500
const PAT_TICK_MS = 200
/** A run of pats starts over after this long without one. */
const PAT_RESET_MS = 60_000
/** Pauses between tiers while stroking nonstop, each shorter than the last; the last repeats. */
const PAT_GAPS_MS = [2000, 1200, 500]
/** A press that travels less than this is a tap. */
const TAP_SLOP = 12
/** Taps closer together than this escalate. */
const TAP_WINDOW_MS = 1200
/** The lower tiers are fond; hearts keep floating up while she is stroked through them. */
const FOND_TIERS = 2

type Zone = 'head' | 'face' | 'body'

/** One press-and-drag on her. */
type Stroke = {
  pointerId: number
  /** The canvas (or sprite) holding the pointer capture. */
  target: Element
  zone: Zone
  distance: number
  last: { x: number; y: number }
  lastMoveAt: number
  isPat: boolean
  /** When the current pause between tiers began, while stroking nonstop. */
  gapStart?: number
  /** Tiers this stroke has advanced past its first, which picks the next pause. */
  advances: number
  /** The tier this pat started at, and the last one it played (-1: none yet). */
  baseTier: number
  playedTier: number
  isBusy: boolean
  timer?: number
}

export type Interact = { refresh(): void; reset(): void }

export function createInteract(o: {
  root: HTMLElement
  box: HTMLElement
  actor(): Actor | undefined
  director: Director
  motion(): MotionSettings
  fx(mark: Mark): void
  /** A headpat began while she was free (a busy one is a telling-off, not a pat). */
  onPat(): void
}): Interact {
  const { root, box, director } = o
  let stroke: Stroke | undefined
  let patCount = 0
  let lastPatAt = 0
  const taps: Record<'face' | 'body', { count: number; at: number }> = { face: { count: 0, at: 0 }, body: { count: 0, at: 0 } }
  let focusTimer: number | undefined
  let zone: Zone | undefined
  /** The pointer's last client position, to re-check what is under it when she moves or resizes under it. */
  let lastPoint: { x: number; y: number } | undefined

  /** Client pixels → character box pixels. The box rect already carries the stage scale and placement. */
  function toBox(clientX: number, clientY: number) {
    const r = box.getBoundingClientRect()
    const s = r.width / BOX_W || 1
    return { x: (clientX - r.left) / s, y: (clientY - r.top) / s }
  }

  function zoneAt(g: Geometry, p: { x: number; y: number }): Zone | undefined {
    if (Math.hypot(p.x - g.head.x, p.y - g.head.y) < g.head.r) return 'head'
    if (Math.hypot(p.x - g.face.x, p.y - g.face.y) < g.face.r) return 'face'
    if (((p.x - g.body.x) / g.body.rx) ** 2 + ((p.y - g.body.y) / g.body.ry) ** 2 < 1) return 'body'
    return undefined
  }

  // The engine aims from the middle of the canvas and always turns fully. Aim from her face instead (not the
  // headpat point on her crown), and scale the turn with distance so a cursor near her face reads as straight on.
  function lookAt(a: Actor, g: Geometry, p: { x: number; y: number }) {
    const dx = p.x - g.face.x
    const dy = p.y - g.face.y
    const distance = Math.hypot(dx, dy)
    if (distance < 1) return focus(a, 0, 0)
    const strength = Math.min(1, distance / (g.head.r * FOCUS_RADII))
    focus(a, (dx / distance) * strength, (-dy / distance) * strength)
  }

  /** Turns her toward (x, y) and mirrors it on `#chara[data-focus]`, so tracking can be seen and tested (R32). */
  function focus(a: Actor, x: number, y: number) {
    a.focus(x, y)
    root.dataset.focus = `${x.toFixed(2)},${y.toFixed(2)}`
  }

  const center = () => {
    const a = o.actor()
    if (a) focus(a, 0, 0)
  }

  function updateCursor() {
    const m = o.motion()
    const isPattable = zone === 'head' && m.headpats
    const isTappable = zone !== undefined && m.taps
    root.dataset.cursor = stroke?.isPat ? 'grabbing' : isPattable ? 'grab' : isTappable ? 'pointer' : ''
    // Her canvas only takes the pointer over her body (or mid-stroke), so presses elsewhere fall through.
    root.toggleAttribute('data-hit', stroke !== undefined || ((isPattable || isTappable) && root.dataset.placement !== 'hidden'))
  }

  // ---------------------------------------------------------------- headpats

  const tierFor = (count: number) => Math.max(0, PAT_TIERS.filter((t) => count >= t.from).length - 1)

  // A stroke turns into a pat once it has travelled PAT_DISTANCE. Each pat counts once toward the running
  // total (separate pats in quick succession escalate). Stroking nonstop walks her through every remaining
  // tier in order: each one plays to the end, then a pause, each shorter than the last. Pausing the stroke
  // restarts the pause. While she works, one telling-off per pat instead.
  function beginPat(s: Stroke) {
    const now = Date.now()
    if (now - lastPatAt > PAT_RESET_MS) patCount = 0
    patCount++
    lastPatAt = now
    s.isPat = true
    s.baseTier = tierFor(patCount)
    s.isBusy = director.busy()
    if (!s.isBusy) o.onPat()
    s.timer = window.setInterval(() => patTick(s), PAT_TICK_MS)
    updateCursor()
    patTick(s)
  }

  function patTick(s: Stroke) {
    const now = Date.now()
    const isMoving = now - s.lastMoveAt < STILL_MS
    if (isMoving) {
      lastPatAt = now
      if (!s.isBusy && s.playedTier < FOND_TIERS) o.fx('heart')
    }
    if (director.reacting()) return void (s.gapStart = undefined)
    if (s.isBusy) {
      if (s.playedTier < 0) (s.playedTier = PAT_TIERS.length), director.react('pat', PAT_BUSY)
      return
    }
    if (s.playedTier < 0) {
      s.playedTier = s.baseTier
    } else {
      if (s.playedTier >= PAT_TIERS.length - 1) return
      if (!isMoving) return void (s.gapStart = undefined)
      s.gapStart ??= now
      if (now - s.gapStart < (PAT_GAPS_MS[s.advances] ?? PAT_GAPS_MS.at(-1)!)) return
      s.advances++
      s.playedTier++
    }
    const tier = PAT_TIERS[s.playedTier]!
    // Nonstop stroking that reaches a tier counts as that many pats, so the next pat picks up from there.
    patCount = Math.max(patCount, tier.from)
    director.react('pat', tier)
  }

  function endStroke() {
    if (!stroke) return
    clearInterval(stroke.timer)
    if (stroke.target.hasPointerCapture(stroke.pointerId)) stroke.target.releasePointerCapture(stroke.pointerId)
    stroke = undefined
    updateCursor()
  }

  // ---------------------------------------------------------------- taps

  function tap(where: 'face' | 'body') {
    if (!o.motion().taps) return
    const now = Date.now()
    const t = taps[where]
    t.count = now - t.at < TAP_WINDOW_MS ? t.count + 1 : 1
    t.at = now
    const tiers: Tier[] = where === 'face' ? FACE_TAPS : BODY_TAPS
    director.react('tap', tiers.filter((x) => t.count >= x.from).at(-1)!)
  }

  // ---------------------------------------------------------------- listeners

  function onMove(e: PointerEvent) {
    lastPoint = { x: e.clientX, y: e.clientY }
    const a = o.actor()
    if (!a) return
    const g = a.geometry()
    const p = toBox(e.clientX, e.clientY)
    if (o.motion().cursor) {
      lookAt(a, g, p)
      clearTimeout(focusTimer)
      focusTimer = window.setTimeout(center, FOCUS_IDLE_MS)
    }
    const next = zoneAt(g, p)
    if (next !== zone) (zone = next), updateCursor()
    const s = stroke
    if (!s || e.pointerId !== s.pointerId) return
    s.distance += Math.hypot(p.x - s.last.x, p.y - s.last.y)
    s.last = p
    s.lastMoveAt = Date.now()
    if (!s.isPat && s.zone === 'head' && o.motion().headpats && s.distance >= PAT_DISTANCE) beginPat(s)
  }

  function onDown(e: PointerEvent) {
    if (e.button !== 0 || stroke) return
    const a = o.actor()
    if (!a) return
    const p = toBox(e.clientX, e.clientY)
    const z = zoneAt(a.geometry(), p)
    if (!z) return
    // Keeps the press from moving focus: clicking her never takes the caret out of the chat input.
    e.preventDefault()
    const target = e.target as Element
    target.setPointerCapture(e.pointerId)
    stroke = {
      pointerId: e.pointerId, target, zone: z, distance: 0, last: p, lastMoveAt: 0, isPat: false, advances: 0, baseTier: 0,
      playedTier: -1, isBusy: false,
    }
    updateCursor()
  }

  function onUp(e: PointerEvent) {
    const s = stroke
    if (!s || e.pointerId !== s.pointerId) return
    // A press on her head that never became a pat is a tap on her face.
    if (!s.isPat && s.distance < TAP_SLOP) tap(s.zone === 'body' ? 'body' : 'face')
    endStroke()
  }

  // Losing the pointer mid-press (another window took it, or the OS cancelled it) ends the stroke without a tap.
  const onCancel = (e: PointerEvent) => e.pointerId === stroke?.pointerId && endStroke()
  const onLeave = (e: PointerEvent) => {
    if (e.relatedTarget) return
    clearTimeout(focusTimer)
    center()
    lastPoint = undefined
    zone = undefined
    updateCursor()
  }

  /** Re-reads the zone under a resting pointer: placements, zoom and costumes move her without a pointermove. */
  function rezone() {
    const a = o.actor()
    zone = a && lastPoint ? zoneAt(a.geometry(), toBox(lastPoint.x, lastPoint.y)) : undefined
    updateCursor()
  }

  function reset() {
    endStroke()
    clearTimeout(focusTimer)
    center()
  }

  addEventListener('pointermove', onMove)
  box.addEventListener('pointerdown', onDown)
  addEventListener('pointerup', onUp)
  addEventListener('pointercancel', onCancel)
  box.addEventListener('lostpointercapture', onCancel, true)
  document.addEventListener('pointerout', onLeave)
  // Alt+Tab mid-press: the pointerup never arrives.
  addEventListener('blur', reset)
  box.addEventListener('transitionend', (e) => e.target === box && rezone())

  return {
    /** Applies the motion toggles at once (tracking off looks ahead again, pats off drops the grab cursor). */
    refresh() {
      if (!o.motion().cursor) clearTimeout(focusTimer), center()
      if (!o.motion().headpats && stroke?.isPat) endStroke()
      rezone()
    },
    reset,
  }
}
