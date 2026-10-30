import type { Placement } from '../contracts'

/** The character box in stage pixels. The canvas (or the placeholder) fills it; placements move and scale it. */
export const BOX_W = 864
export const BOX_H = 900
/** The box's left edge in the chat placement: centered on the column between the panels (x 378–1242). */
export const BOX_LEFT = 378
export const STAGE_W = 1600
/** Her zoom (appearance.zoom), from the wheel over her or Settings → Appearance. */
export const ZOOM_MIN = 0.6
export const ZOOM_MAX = 2.5
export const ZOOM_STEP = 0.05
/**
 * Beside the settings pages a 3D model stands taller than the Live2D costumes (PLACEMENTS.side): her framing leaves
 * room above her head, and at the costumes' scale she looked small next to the panels.
 */
export const MMD_SIDE_SCALE = 0.93
export const STAGE_H = 900

type Spot = { x: number; y: number; scale: number }

/** Where each placement puts the box: a shift from the chat position, and a scale about its bottom. */
export const PLACEMENTS: Record<Exclude<Placement, 'hidden'>, Spot> = {
  chat: { x: 0, y: 0, scale: 1 },
  // Standing tall at the right of the title menu.
  title: { x: 340, y: 0, scale: 1 },
  // Beside the settings pages, as a live preview.
  side: { x: 560, y: 0, scale: 0.74 },
}

/** A phone held sideways (Theater): she stands at the left, the dialogue and the composer take the right. */
export const PHONE_LANDSCAPE: Record<Exclude<Placement, 'hidden'>, Spot> = {
  chat: { x: -330, y: 30, scale: 1.05 },
  title: { x: 340, y: 0, scale: 1 },
  side: { x: 560, y: 0, scale: 0.74 },
}

/** The box centered on the 900-wide portrait stage. */
const PORTRAIT_X = (STAGE_H - BOX_W) / 2 - BOX_LEFT

/** In portrait her feet sit this far above the stage's bottom edge: tucked behind the dialogue box, or the title menu. */
const PORTRAIT_FEET = { chat: 600, title: 420 }
/** Her scale on a 900×1600 portrait stage (a 9:16 screen), and at most on taller ones. */
const PORTRAIT_SCALE = { chat: [1.1, 1.4], title: [0.95, 1.2] } as const
/** On a taller stage she grows by this much per stage pixel past 1600, filling the sky over her head. */
const PORTRAIT_GROW = 1 / 1600

/**
 * The portrait stage (900 wide, 1600 or taller: a phone). The dialogue box and the title menu hang from the
 * bottom, so she does too, standing above them, and a taller screen makes her bigger. There is no room for the
 * settings preview, so 'side' isn't used there (index.ts hides her instead).
 */
export function portraitPlacements(stageH: number, compact = false): Record<Exclude<Placement, 'hidden'>, Spot> {
  const grow = Math.max(0, stageH - STAGE_W) * PORTRAIT_GROW
  const at = (k: 'chat' | 'title') => ({
    x: PORTRAIT_X,
    y: stageH - PORTRAIT_FEET[k] - BOX_H,
    scale: Math.min(PORTRAIT_SCALE[k][1], PORTRAIT_SCALE[k][0] + grow),
  })
  // Compact (the keyboard is up): her head and shoulders, the top of her head just under the stage's top edge.
  // The box scales about its bottom, so its top sits at y + BOX_H × (1 − scale).
  const chat = compact ? { x: PORTRAIT_X, y: COMPACT_TOP - BOX_H * (1 - COMPACT_SCALE), scale: COMPACT_SCALE } : at('chat')
  return { chat, title: at('title'), side: chat }
}
/** Compact portrait: her scale, and where the box's top goes (above the stage: her hair starts a little below it). */
const COMPACT_SCALE = 1.3
const COMPACT_TOP = -40
/** Hidden keeps the last visible spot and sinks a little while fading out. */
export const HIDDEN_DROP = 40
