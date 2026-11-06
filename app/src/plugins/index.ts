// The UI-plugin seam: optional pieces of the app that exist only behind a settings flag (`plugins.<id>`).
// A plugin owns its own element and CSS and is mounted into a host the screen provides; this registry is the
// only list the chat screen (which mounts) and the settings screen (the Plugins tab) read, so a second panel
// is a file plus an entry here and no other app file learns about it.

import type { Settings } from '../../../link/src/protocol.ts'
import type { UiPlugin } from './types'
export type { UiPlugin } from './types'

/** Every UI plugin, in the order the settings screen lists them. Tickets is the first (and, for now, only) one. */
export const UI_PLUGINS: UiPlugin[] = [
  {
    id: 'tickets',
    name: 'Ticket board',
    description: 'A read-only ticket board shown in chat. The agent and ticket CLI create and move tickets.',
    defaultEnabled: false,
    // The chat screen supplies the concrete mount function and imports this plugin's CSS.
    mount: () => () => {},
  },
]

/**
 * Whether a plugin is on: its explicit entry when the user has made one, else the plugin's own default.
 * `Settings.plugins` is optional, so an id nobody has ever toggled simply falls through to the default.
 */
export function pluginEnabled(settings: Settings, id: string): boolean {
  const explicit = settings.plugins?.[id]
  if (typeof explicit === 'boolean') return explicit
  return UI_PLUGINS.find((p) => p.id === id)?.defaultEnabled ?? false
}

/**
 * Writes one flag onto the settings copy `store.update` hands back, which is the app's normal save path
 * (debounced `settings_set`). The `plugins` object is created on first use, so a settings file from before
 * the field existed gains it without a migration.
 */
export function setPluginFlag(settings: Settings, id: string, on: boolean): void {
  settings.plugins ??= {}
  settings.plugins[id] = on
}
