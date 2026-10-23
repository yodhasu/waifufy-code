import type { Placement } from '../contracts'

/** The character box in stage pixels. The canvas (or the placeholder) fills it; placements move and scale it. */
export const BOX_W = 864
export const BOX_H = 900
/** The box's left edge in the chat placement: centered on the column between the panels (x 378–1242). */
export const BOX_LEFT = 378
export const STAGE_W = 1600
export const STAGE_H = 900

/** Where each placement puts the box: a horizontal shift from the chat position, and a scale about its bottom. */
export const PLACEMENTS: Record<Exclude<Placement, 'hidden'>, { x: number; scale: number }> = {
  chat: { x: 0, scale: 1 },
  // Standing tall at the right of the title menu.
  title: { x: 340, scale: 1 },
  // Beside the settings pages, as a live preview.
  side: { x: 560, scale: 0.74 },
}
/** Hidden keeps the last visible spot and sinks a little while fading out. */
export const HIDDEN_DROP = 40
