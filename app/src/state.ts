import type { Settings } from '../../link/src/protocol.ts'
import type { Link, Store } from './contracts'

const SAVE_DEBOUNCE_MS = 400

/** The settings store: one copy shared by every screen, persisted through the link. */
export function createStore(link: Link, initial: Settings): Store {
  let settings = structuredClone(initial)
  /** What the link last sent us or was sent: the base a pending local edit is compared against. */
  let synced = structuredClone(initial)
  const subs = new Set<(s: Settings) => void>()
  let timer: number | undefined

  // The link pushes settings it changed itself (lastDir on New Game, a researched preset). A local edit still
  // waiting for its save wins section by section; everything else follows the link.
  link.on((m) => {
    if (m.t !== 'settings') return
    if (timer === undefined) settings = m.settings
    else {
      const merged: Record<string, unknown> = { ...m.settings }
      const local = settings as Record<string, unknown>
      const base = synced as Record<string, unknown>
      for (const k of Object.keys(local)) if (JSON.stringify(local[k]) !== JSON.stringify(base[k])) merged[k] = local[k]
      settings = merged as Settings
    }
    synced = m.settings
    for (const fn of subs) fn(settings)
  })

  return {
    get: () => settings,
    update(mutate) {
      const next = structuredClone(settings)
      mutate(next)
      settings = next
      for (const fn of subs) fn(settings)
      clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = undefined
        synced = settings
        link.send({ t: 'settings_set', settings })
      }, SAVE_DEBOUNCE_MS)
    },
    subscribe(fn) {
      subs.add(fn)
      return () => void subs.delete(fn)
    },
  }
}

/** Applies the theme, scene and accent to the document (R41, R46). */
export function applyAppearance(s: Settings) {
  const root = document.documentElement
  const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches
  const theme = s.appearance.theme === 'system' ? (prefersDark ? 'dark' : 'light') : s.appearance.theme
  root.dataset.theme = theme
  const scene = s.appearance.background === 'auto' ? (theme === 'dark' ? 'night' : 'day') : s.appearance.background
  root.dataset.scene = scene
  root.style.setProperty('--accent', s.appearance.accent)
  root.style.setProperty('--dialogue-font', `${s.appearance.fontSize}px`)
  root.style.setProperty('--dialogue-opacity', String(s.appearance.boxOpacity))
  root.style.setProperty('--name-color', s.profile.nameColor)
  document.getElementById('stage')!.dataset.petals = s.appearance.petals ? 'on' : 'off'
}
