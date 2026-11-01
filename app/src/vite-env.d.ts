/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set by the Tauri CLI while it builds: 'android' for the phone app (vite.config.ts lets TAURI_ENV_* through). */
  readonly TAURI_ENV_PLATFORM?: string
}
