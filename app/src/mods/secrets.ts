// Mod secret settings (WC-20): API keys and tokens a mod declares as `secret` fields live in the OS credential
// store through the Tauri commands in src-tauri/src/secrets.rs, never in a file. The link keeps them in memory only,
// so this module also hands them back: whenever a mod is enabled or the link (re)connects, the stored secrets of each
// enabled mod go out again as a `mod-settings`. A plain browser (the e2e target) has no keychain: a Map stands in.

import { invoke } from '@tauri-apps/api/core'
import type { ModInfo } from '../../../link/src/protocol.ts'
import type { Link } from '../contracts'

/** The in-memory stand-in when there is no Tauri shell; lost on reload, which is fine for tests. */
const memory = new Map<string, string>()
const native = () => '__TAURI_INTERNALS__' in window
const service = (id: string) => `waifufy-mod:${id}`

/** The stored secret, or null when there is none. */
export async function secretGet(id: string, key: string): Promise<string | null> {
  return native() ? invoke<string | null>('secret_get', { service: service(id), key }) : (memory.get(service(id) + '\0' + key) ?? null)
}

export async function secretSet(id: string, key: string, value: string): Promise<void> {
  if (native()) await invoke('secret_set', { service: service(id), key, value })
  else memory.set(service(id) + '\0' + key, value)
}

export async function secretDelete(id: string, key: string): Promise<void> {
  if (native()) await invoke('secret_delete', { service: service(id), key })
  else memory.delete(service(id) + '\0' + key)
}

/** Sends `mod`'s stored secrets to the link; nothing when it has none. */
async function push(mod: ModInfo, link: Link): Promise<void> {
  const values: Record<string, string> = {}
  for (const f of mod.settings) {
    if (f.type !== 'secret') continue
    const v = await secretGet(mod.id, f.key).catch(() => null)
    if (v !== null) values[f.key] = v
  }
  if (Object.keys(values).length) link.send({ t: 'mod-settings', id: mod.id, values })
}

/** Keeps the link supplied with the stored secrets of enabled mods (desktop only). Returns the unsubscribe. */
export function watchModSecrets(link: Link): () => void {
  /** Mods whose secrets this link connection already has. */
  const sent = new Set<string>()
  const off = link.on((m) => {
    if (m.t !== 'mods') return
    for (const mod of m.mods) {
      if (!mod.enabled) sent.delete(mod.id)
      else if (!sent.has(mod.id) && mod.settings.some((f) => f.type === 'secret')) {
        sent.add(mod.id)
        void push(mod, link)
      }
    }
  })
  const offStatus = link.onStatus((s) => {
    if (s === 'down') return sent.clear()
    link.send({ t: 'mods' })
  })
  link.send({ t: 'mods' })
  return () => (off(), offStatus())
}
