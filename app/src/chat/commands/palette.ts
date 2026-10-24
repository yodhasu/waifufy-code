import type { CommandHost } from './index'

/** Stub: the Ctrl+K command palette (docs/V0.5.md W11, P0-10). */
export function openPalette(host: CommandHost) {
  host.toast('The command palette is not built yet')
}

/** Stub: the `?` shortcut sheet (the CLI's `?` on an empty prompt). */
export function openShortcuts(host: CommandHost) {
  host.toast('The shortcut sheet is not built yet')
}
