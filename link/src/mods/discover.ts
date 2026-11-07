// Finds mod folders. Three roots, highest priority first: WC_MODS_DIR (env), the user's installed mods in the
// data dir, and the repo's bundled plugins/. The first root holding an id wins; the rest are shadowed.

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_DIR } from '../settings.ts'
import { parseManifest, type ModManifest } from './manifest.ts'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

export type DiscoveredMod = {
  id: string
  dir: string
  source: 'env' | 'installed' | 'repo'
  manifest?: ModManifest
  status: 'ok' | 'invalid' | 'incompatible'
  reason?: string
}

/** Where user-installed mods live. */
export const modsDir = () => join(DATA_DIR, 'mods')

/** A mod's private writable folder (created on demand). Kept apart from the mod's own code folder. */
export function modDataDir(id: string): string {
  const dir = join(DATA_DIR, 'mod-data', id)
  mkdirSync(dir, { recursive: true })
  return dir
}

function scan(root: string, source: DiscoveredMod['source']): DiscoveredMod[] {
  if (!existsSync(root)) return []
  const out: DiscoveredMod[] = []
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const dir = join(root, e.name)
    const file = join(dir, 'mod.json')
    if (!existsSync(file)) continue
    const bad = (reason: string, status: 'invalid' | 'incompatible' = 'invalid'): DiscoveredMod => ({ id: e.name, dir, source, status, reason })
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      out.push(bad(`mod.json is not valid JSON: ${(err as Error).message}`))
      continue
    }
    const r = parseManifest(raw, dir)
    if (!r.ok) out.push(bad(r.reason, r.status))
    // A repo plugin folder is shared with other tools (waifufy-tickets is also a Claude Code plugin), so only it may be named differently.
    else if (r.manifest.id !== e.name && source !== 'repo') out.push(bad('folder name must match id'))
    else out.push({ id: r.manifest.id, dir, source, manifest: r.manifest, status: 'ok' })
  }
  return out
}

export function discoverMods(roots: { env?: string; installed?: string; repo?: string } = {}): DiscoveredMod[] {
  const env = roots.env ?? process.env.WC_MODS_DIR
  const found = new Map<string, DiscoveredMod>()
  for (const [root, source] of [
    [env, 'env'],
    [roots.installed ?? modsDir(), 'installed'],
    [roots.repo ?? join(REPO_ROOT, 'plugins'), 'repo'],
  ] as const) {
    if (!root) continue
    for (const m of scan(root, source)) if (!found.has(m.id)) found.set(m.id, m)
  }
  return [...found.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
