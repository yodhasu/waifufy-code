import type { Actor, Geometry } from './director.ts'
import { isHold, type Pose } from './motions.ts'
import { BOX_W } from './layout.ts'

// The built-in sprite shown when no Live2D model is found (R37), from the approved ui-draft design. It speaks the
// same motion vocabulary as the model: a pose's suffix picks a face (egao → closed-eye smile), a one-shot adds
// a CSS move (unazuku → nod), and blink, lip flap, blush and gaze are CSS driven by data attributes.

const VIEW_W = 420
const VIEW_H = 860
/** The sprite's top-left in the character box, before zoom (zoom scales around its top center). */
const LEFT = (BOX_W - VIEW_W) / 2
const TOP = 40
const SHOT_MS = 900
const LOOK_MS = 2000
// Hit zones in sprite coordinates.
const HEAD = { x: 210, y: 112, r: 72 }
const FACE = { x: 210, y: 236, r: 62 }
const BODY = { x: 210, y: 560, rx: 120, ry: 290 }

type Eyes = 'open' | 'smile' | 'shut' | 'wide' | 'soft' | 'teary'
type Face = { mouth: string; open?: boolean; brows?: string; eyes?: Eyes; gaze?: number }

const BROWS = 'M166 196 Q180 190 194 196 M226 196 Q240 190 254 196'
const BROWS_WORRIED = 'M166 199 Q180 192 194 192 M226 192 Q240 192 254 199'
const BROWS_STERN = 'M166 192 L194 199 M226 199 L254 192'
const BROWS_ANGRY = 'M166 190 L194 201 M226 201 L254 190'

/** Faces by motion base name (`act_egao02_w` → `egao02`, falling back to `egao`). */
const FACES: Record<string, Face> = {
  normal: { mouth: 'M198 268 Q210 276 222 268' },
  normal03: { mouth: 'M200 268 Q210 274 220 268', eyes: 'shut' },
  hohoemu: { mouth: 'M196 266 Q210 280 224 266' },
  egao: { mouth: 'M194 264 Q210 284 226 264', eyes: 'smile' },
  egao02: { mouth: 'M192 262 Q210 292 228 262 Q210 270 192 262', open: true, eyes: 'smile' },
  unazuku: { mouth: 'M196 266 Q210 280 224 266', eyes: 'smile' },
  kangaeru: { mouth: 'M202 272 L220 269', brows: BROWS_WORRIED, gaze: -5 },
  nayamu: { mouth: 'M200 274 Q210 266 220 274', brows: BROWS_WORRIED },
  komaru: { mouth: 'M200 274 Q210 266 220 274', brows: BROWS_WORRIED, eyes: 'soft' },
  shinken: { mouth: 'M200 272 L220 272', brows: BROWS_STERN },
  odoroku: { mouth: 'M204 270 Q210 286 216 270 Q210 260 204 270', open: true, eyes: 'wide' },
  bikkuri: { mouth: 'M202 268 Q210 290 218 268 Q210 258 202 268', open: true, eyes: 'wide', brows: BROWS_WORRIED },
  tere: { mouth: 'M202 268 Q210 274 218 268', eyes: 'soft', gaze: 5 },
  punpun: { mouth: 'M202 272 Q210 266 218 272', eyes: 'shut', brows: BROWS_ANGRY },
  kanashimu: { mouth: 'M200 276 Q210 268 220 276', brows: BROWS_WORRIED, eyes: 'soft' },
  kurushimu: { mouth: 'M200 276 Q210 268 220 276', brows: BROWS_WORRIED, eyes: 'shut' },
  ikaru: { mouth: 'M198 274 Q210 266 222 274', brows: BROWS_ANGRY },
  gekido: { mouth: 'M198 276 Q210 262 222 276 Q210 270 198 276', open: true, brows: BROWS_ANGRY, eyes: 'wide' },
  uru: { mouth: 'M200 274 Q205 270 210 274 Q215 270 220 274', brows: BROWS_WORRIED, eyes: 'teary' },
  suneru: { mouth: 'M203 272 Q212 268 219 273', eyes: 'soft', gaze: 6, brows: BROWS_WORRIED },
  tameiki: { mouth: 'M202 272 Q210 276 218 272', eyes: 'shut' },
}
/** CSS moves for one-shots, by motion base name. */
const MOVES: Record<string, string> = {
  unazuku: 'nod', bikkuri: 'hop', odoroku: 'hop', egao: 'bounce', hohoemu: 'bounce', kangaeru: 'tilt',
  nayamu: 'sway', komaru: 'sway', ikaru: 'shake', gekido: 'shake', punpun: 'shake', shinken: 'firm',
  kurushimu: 'droop', kanashimu: 'droop', tameiki: 'droop', uru: 'droop', suneru: 'turn',
}

const base = (suffix: string) => suffix.replace(/^(act|face)_/, '').replace(/_w$/, '')
const lookup = <T>(table: Record<string, T>, suffix: string) => table[base(suffix)] ?? table[base(suffix).replace(/\d+$/, '')]

/** Computed styles baked into the thumbnail copy, which has no stylesheet. */
const BAKED = ['fill', 'stroke', 'stroke-width', 'opacity', 'stop-color', 'd', 'display', 'transform', 'transform-origin', 'transform-box']

const TEMPLATE = `
<svg class="sprite" viewBox="0 0 ${VIEW_W} ${VIEW_H}" aria-label="Character placeholder">
  <defs>
    <linearGradient id="spHair" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="sp-hair-1"/><stop offset="1" class="sp-hair-2"/></linearGradient>
    <linearGradient id="spDress" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="sp-dress-1"/><stop offset="1" class="sp-dress-2"/></linearGradient>
  </defs>
  <g class="sp-move"><g class="sp-all">
    <g class="sp-body">
      <path class="sp-hair" d="M118 235 Q105 115 210 92 Q315 115 302 235 L306 340 Q290 356 274 340 L268 262 L152 262 L146 340 Q130 356 114 340 Z"/>
      <rect class="sp-skin" x="190" y="298" width="40" height="56" rx="14"/>
      <path class="sp-dress" d="M84 860 L108 440 Q118 362 210 348 Q302 362 312 440 L336 860 Z"/>
      <path class="sp-white" d="M158 860 L170 480 Q210 462 250 480 L262 860 Z"/>
      <path class="sp-white" d="M150 360 Q210 410 270 360 L258 396 Q210 430 162 396 Z"/>
      <path class="sp-ribbon" d="M196 404 L210 420 L224 404 L210 440 Z"/>
      <ellipse class="sp-white" cx="116" cy="424" rx="42" ry="36"/>
      <ellipse class="sp-white" cx="304" cy="424" rx="42" ry="36"/>
    </g>
    <g class="sp-head">
      <g class="sp-look">
        <ellipse class="sp-skin" cx="210" cy="214" rx="78" ry="90"/>
        <ellipse class="sp-blush" cx="168" cy="252" rx="16" ry="8"/>
        <ellipse class="sp-blush" cx="252" cy="252" rx="16" ry="8"/>
        <g class="sp-eyes">
          <g class="sp-eyes-open">
            <ellipse class="sp-iris" cx="180" cy="224" rx="12" ry="16"/>
            <ellipse class="sp-iris" cx="240" cy="224" rx="12" ry="16"/>
            <circle class="sp-shine" cx="184" cy="218" r="4"/>
            <circle class="sp-shine" cx="244" cy="218" r="4"/>
            <path class="sp-tear" d="M170 238 Q180 246 190 238 M230 238 Q240 246 250 238"/>
          </g>
          <path class="sp-eyes-smile" d="M168 228 Q180 214 192 228 M228 228 Q240 214 252 228"/>
          <path class="sp-eyes-shut" d="M168 226 Q180 232 192 226 M228 226 Q240 232 252 226"/>
        </g>
        <path class="sp-brows" d="${BROWS}"/>
        <path class="sp-mouth" d="${FACES.normal!.mouth}"/>
        <ellipse class="sp-talk" cx="210" cy="270" rx="8" ry="7"/>
        <path class="sp-hair" d="M130 205 Q138 110 210 104 Q292 110 292 210 Q272 160 252 178 Q240 140 214 172 Q192 138 172 178 Q152 160 130 205 Z"/>
        <path class="sp-band" d="M138 124 Q210 66 282 124 Q272 102 210 88 Q148 102 138 124 Z"/>
        <g class="sp-x" transform="translate(266 150)"><path d="M-8 -8 L8 8 M8 -8 L-8 8"/></g>
      </g>
    </g>
  </g></g>
</svg>`

export type Placeholder = Actor & { el: SVGSVGElement; image(): Promise<HTMLImageElement> }

export function createPlaceholder(box: HTMLElement, zoom: number): Placeholder {
  box.insertAdjacentHTML('beforeend', TEMPLATE)
  const el = box.lastElementChild as SVGSVGElement
  Object.assign(el.style, { left: `${LEFT}px`, top: `${TOP}px`, width: `${VIEW_W}px`, height: `${VIEW_H}px` })
  const mouth = el.querySelector<SVGPathElement>('.sp-mouth')!
  const brows = el.querySelector<SVGPathElement>('.sp-brows')!
  let z = zoom
  let moveTimer: number | undefined
  let lookTimer: number | undefined

  const setZoom = (next: number) => {
    z = next
    el.style.setProperty('--zoom', String(next))
  }
  setZoom(zoom)

  function faceFor(p: Pose) {
    const suffix = p.face?.[0] ?? p.act[0] ?? 'normal'
    return { key: lookup(FACES, suffix) ? base(suffix) : 'normal', face: lookup(FACES, suffix) ?? FACES.normal! }
  }

  const toBox = (x: number, y: number) => ({ x: BOX_W / 2 + (LEFT + x - BOX_W / 2) * z, y: TOP + y * z })

  return {
    kind: 'placeholder',
    el,

    async pose(p) {
      const { key, face } = faceFor(p)
      el.dataset.face = key
      el.dataset.eyes = face.eyes ?? 'open'
      el.style.setProperty('--gaze', `${face.gaze ?? 0}px`)
      mouth.style.setProperty('d', `path('${face.mouth}')`)
      mouth.classList.toggle('open', !!face.open)
      brows.style.setProperty('d', `path('${face.brows ?? BROWS}')`)
      const act = p.act[0] ?? ''
      if (isHold(act)) return 0
      // Restart the move even when it is the same one again.
      clearTimeout(moveTimer)
      delete el.dataset.move
      void el.getBoundingClientRect()
      el.dataset.move = lookup(MOVES, act) ?? 'bounce'
      moveTimer = window.setTimeout(() => delete el.dataset.move, SHOT_MS)
      return SHOT_MS
    },

    resolve: (p) => faceFor(p).key,

    async addon(candidates) {
      const side = candidates[0]?.match(/_(L|R)$/)?.[1]
      if (!side) return -1
      clearTimeout(lookTimer)
      el.dataset.look = side
      lookTimer = window.setTimeout(() => delete el.dataset.look, LOOK_MS)
      return LOOK_MS
    },

    setBlush(on) {
      el.toggleAttribute('data-blush', on)
    },

    setTalking(on) {
      el.toggleAttribute('data-talking', on)
    },

    focus(x, y) {
      el.style.setProperty('--fx', x.toFixed(3))
      el.style.setProperty('--fy', y.toFixed(3))
    },

    geometry(): Geometry {
      const head = toBox(HEAD.x, HEAD.y)
      const face = toBox(FACE.x, FACE.y)
      const body = toBox(BODY.x, BODY.y)
      return {
        head: { ...head, r: HEAD.r * z },
        face: { ...face, r: FACE.r * z },
        body: { ...body, rx: BODY.rx * z, ry: BODY.ry * z },
      }
    },

    setZoom,

    /** The sprite as an image with its theme colors baked in, for save thumbnails. */
    image() {
      const clone = el.cloneNode(true) as SVGSVGElement
      // The root is left as is: its zoom transform is already in the rect the image is drawn into.
      const from = [...el.querySelectorAll('*')]
      const to = [...clone.querySelectorAll('*')]
      from.forEach((node, k) => {
        const cs = getComputedStyle(node)
        const target = to[k] as SVGElement
        for (const prop of BAKED) {
          const v = cs.getPropertyValue(prop)
          if (v) target.style.setProperty(prop, v)
        }
      })
      clone.setAttribute('width', String(VIEW_W))
      clone.setAttribute('height', String(VIEW_H))
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }))
      return new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => (URL.revokeObjectURL(url), resolve(img))
        img.onerror = (e) => (URL.revokeObjectURL(url), reject(e))
        img.src = url
      })
    },

    destroy() {
      clearTimeout(moveTimer)
      clearTimeout(lookTimer)
      el.remove()
    },
  }
}
