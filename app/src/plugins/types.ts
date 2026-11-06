/** Contract for a small UI plugin mounted into a screen-provided host. */
export type UiPlugin = {
  /** Settings key under `plugins`. */
  id: string
  /** Shown in the settings screen's Plugins tab. */
  name: string
  description: string
  /** What the flag starts as before the user has ever touched it. */
  defaultEnabled: boolean
  /** Builds the panel inside `host` and returns its teardown. */
  mount(host: HTMLElement): () => void
}
