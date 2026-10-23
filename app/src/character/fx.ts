import type { Mark } from './motions.ts'

// Floating manga marks over her head: hearts while patted, an anger vein when she pouts, a "!" when startled.
// They are plain DOM in the character's own box, animated by character.css, and remove themselves.

const SVG: Partial<Record<Mark, string>> = {
  anger:
    '<svg viewBox="0 0 40 40"><path d="M15 4 Q17 13 6 15 M25 4 Q23 13 34 15 M15 36 Q17 27 6 25 M25 36 Q23 27 34 25"/></svg>',
  sweat: '<svg viewBox="0 0 24 36"><path d="M12 2 Q22 18 20 25 A8 8 0 0 1 4 25 Q2 18 12 2 Z"/></svg>',
  heart: '<svg viewBox="0 0 32 30"><path d="M16 28 C-6 14 4 -4 16 7 C28 -4 38 14 16 28 Z"/></svg>',
  sparkle: '<svg viewBox="0 0 40 40"><path d="M20 0 Q22 18 40 20 Q22 22 20 40 Q18 22 0 20 Q18 18 20 0 Z"/></svg>',
}
const TEXT: Partial<Record<Mark, string>> = { surprise: '!', question: '?', dots: '…', note: '♪' }

/** Where each mark sits relative to her head point, in multiples of the head radius. */
const OFFSET: Record<Mark, [number, number]> = {
  heart: [0.9, -0.9], hearts: [0.9, -0.9], anger: [0.85, -0.95], surprise: [0.95, -1.05], question: [0.95, -1.05],
  sparkle: [-1, -0.8], sweat: [-0.9, -0.5], dots: [0.95, -0.9], note: [1, -0.85],
}
const HEARTS = 3
const HEART_STAGGER_MS = 260
const HEART_SPREAD = 0.45
/** Every other heart of a bunch sits this much (in head radii) lower, so they don't float up in a line. */
const HEART_DROP = 0.3
/** Marks of one kind closer together than this are merged, so a stroke doesn't pile up hearts. */
const MIN_GAP_MS = 380

export type Fx = { spawn(mark: Mark, head: { x: number; y: number; r: number }): void; clear(): void }

export function createFx(layer: HTMLElement): Fx {
  const last = new Map<Mark, number>()

  function one(mark: Mark, x: number, y: number, delay = 0) {
    const el = document.createElement('span')
    el.className = `fx fx-${mark === 'hearts' ? 'heart' : mark}`
    el.innerHTML = SVG[mark === 'hearts' ? 'heart' : mark] ?? TEXT[mark] ?? ''
    el.style.left = `${x}px`
    el.style.top = `${y}px`
    el.style.animationDelay = `${delay}ms`
    el.addEventListener('animationend', () => el.remove())
    layer.appendChild(el)
  }

  return {
    spawn(mark, head) {
      const now = performance.now()
      if (now - (last.get(mark) ?? 0) < MIN_GAP_MS) return
      last.set(mark, now)
      const [ox, oy] = OFFSET[mark]
      const x = head.x + ox * head.r
      const y = head.y + oy * head.r
      if (mark !== 'hearts') return one(mark, x, y)
      for (let k = 0; k < HEARTS; k++) {
        one(mark, x + (k - 1) * HEART_SPREAD * head.r, y + (k % 2) * HEART_DROP * head.r, k * HEART_STAGGER_MS)
      }
    },
    clear() {
      layer.replaceChildren()
    },
  }
}
