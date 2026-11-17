// The link's mod service: which mods exist, which are on (the `plugins.<id>` settings flag, defaulting to the
// manifest's defaultEnabled), their backends, settings, app events and capability calls. server.ts owns the
// WebSocket; everything here reaches the app through the `broadcast` it is given.

import { EventEmitter } from 'node:events'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { ModInfo, ServerMsg } from '../protocol.ts'
import { discoverMods, modDataDir, modsDir, type DiscoveredMod } from './discover.ts'
import { ModHost } from './host.ts'
import { panelToken } from './http.ts'
import { parseManifest, type SettingField, type ToolDef } from './manifest.ts'

export type AppEventType = 'turn.end' | 'emotion' | 'affection' | 'message'
/** The permission each app event needs. */
const EVENT_PERMS: Record<AppEventType, string> = { 'turn.end': 'events.turn', emotion: 'events.emotion', affection: 'events.affection', message: 'events.message' }
/** The permission each capability needs. */
const CAPABILITY_PERMS: Record<string, string> = {
  'chat.send': 'chat.send',
  notify: 'notify',
  'theme.set': 'theme',
  'session.start': 'session.start',
  'session.interrupt': 'session.interrupt',
}
/** The capabilities server.ts runs: the ones that touch the session. */
export type SessionCapability = 'chat.send' | 'session.start' | 'session.interrupt'

export type ModsOptions = {
  broadcast: (m: ServerMsg) => void
  /** The link's HTTP port, for panel URLs. */
  port: () => number
  /** The stored `plugins` flags. */
  flags: () => Promise<Record<string, boolean>>
  setFlag: (id: string, on: boolean) => Promise<void>
  /** Runs a session capability for a mod (already permission-checked). */
  app: (id: string, capability: SessionCapability, params: unknown) => unknown
  discover?: () => DiscoveredMod[]
  /** Copies a mod folder on install (cpSync); a seam for tests. */
  copy?: (from: string, to: string) => void
  host?: ModHost
}

export type InstallResult = { ok: true; id: string } | { ok: false; reason: string; needsReplace?: boolean }

export class Mods extends EventEmitter {
  private o: ModsOptions
  private host: ModHost
  private mods: DiscoveredMod[] = []
  private flags: Record<string, boolean> = {}
  /** Secret setting values, in memory only: the app keeps them in the OS keychain. */
  private secrets = new Map<string, Record<string, unknown>>()
  /** Why a backend did not start, until it next starts. */
  private errors = new Map<string, string>()
  /** Per-mod queue, so two quick toggles never race two starts. */
  private queue = new Map<string, Promise<void>>()

  constructor(o: ModsOptions) {
    super()
    this.o = o
    this.host = o.host ?? new ModHost()
    this.host.on('status', () => this.changed())
    this.host.on('emit', (id: string, e: { type: unknown; payload: unknown }) => o.broadcast({ t: 'mod-event', id, type: String(e.type), payload: e.payload }))
    this.host.on('app', (id: string, c: { capability: unknown; params: unknown }, reply: (v: unknown, err?: string) => void) =>
      this.appCall(id, String(c.capability), c.params).then((v) => reply(v), (e: Error) => reply(undefined, e.message)),
    )
  }

  async init(): Promise<void> {
    await this.rescan()
  }

  /** Finds the mod folders again (after an install or removal) and brings the backends in line. */
  private async rescan(): Promise<void> {
    this.mods = (this.o.discover ?? discoverMods)()
    await this.refresh()
  }

  /** Validates the mod folder at `path` and copies it into the data folder; an existing id needs `replace`. */
  async install(path: string, replace = false): Promise<InstallResult> {
    const file = join(path, 'mod.json')
    if (!existsSync(file)) return { ok: false, reason: 'no mod.json in that folder' }
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (e) {
      return { ok: false, reason: `mod.json is not valid JSON: ${(e as Error).message}` }
    }
    const r = parseManifest(raw, path)
    if (!r.ok) return { ok: false, reason: r.reason }
    const id = r.manifest.id
    const dest = join(modsDir(), id)
    const src = resolve(path), target = resolve(dest)
    // The source may not be the destination or inside it: replacing deletes the destination.
    if (src === target || src.startsWith(target + sep)) return { ok: false, reason: `${id} is already installed from that folder` }
    if (existsSync(dest) && !replace) return { ok: false, reason: `${id} is already installed`, needsReplace: true }
    // Copy beside the destination first, so a failed copy leaves the old version (and its backend) alone.
    const tmp = join(dirname(modsDir()), `.mods-install-${id}`)
    try {
      rmSync(tmp, { recursive: true, force: true })
      ;(this.o.copy ?? ((from, to) => cpSync(from, to, { recursive: true })))(path, tmp)
      // Through the mod's queue, so a concurrent toggle can't start a backend in the folder being replaced.
      await this.exclusive(id, async () => {
        await this.host.stop(id)
        mkdirSync(modsDir(), { recursive: true })
        rmSync(dest, { recursive: true, force: true })
        renameSync(tmp, dest)
      })
    } catch (e) {
      return { ok: false, reason: `could not copy the mod: ${(e as Error).message}` }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      await this.rescan() // every exit: the list and backends match the disk
    }
    return { ok: true, id }
  }

  /** Deletes an installed mod's folder (and its data folder with `deleteData`). Env and repo mods are not ours to delete. */
  async remove(id: string, deleteData = false): Promise<void> {
    const m = this.find(id)
    if (!m) throw new Error(`no mod ${id}`)
    if (m.source !== 'installed') throw new Error(`${id} is not an installed mod: remove its folder yourself`)
    await this.exclusive(id, async () => {
      await this.host.stop(id)
      rmSync(m.dir, { recursive: true, force: true })
      if (deleteData) {
        rmSync(modDataDir(id), { recursive: true, force: true })
        this.secrets.delete(id)
      }
    })
    this.errors.delete(id)
    await this.rescan()
  }

  /** Re-reads the flags and starts or stops backends to match (after the settings changed). */
  async refresh(): Promise<void> {
    this.flags = await this.o.flags()
    await Promise.all(this.mods.map((m) => this.apply(m.id)))
    this.changed()
  }

  private find(id: string) {
    return this.mods.find((m) => m.id === id)
  }

  private enabledMod(id: string) {
    const m = this.find(id)
    if (!m?.manifest || !this.isOn(m)) throw new Error(`mod ${id} is not enabled`)
    return m
  }

  private isOn(m: DiscoveredMod) {
    return m.status === 'ok' && (this.flags[m.id] ?? m.manifest?.defaultEnabled ?? false)
  }

  /** Enabled mods with a valid manifest: the ones whose panels are served. */
  served(): DiscoveredMod[] {
    return this.mods.filter((m) => this.isOn(m))
  }

  async enable(id: string, on: boolean): Promise<void> {
    if (!this.find(id)) throw new Error(`no mod ${id}`)
    // The flag is written inside the queued step, so a quick off-then-on stops and restarts in order.
    await this.apply(id, async () => {
      await this.o.setFlag(id, on)
      this.flags[id] = on
    })
    this.changed()
  }

  /** Runs `work` after the mod's earlier queued steps, and holds later ones until it is done. */
  private exclusive(id: string, work: () => Promise<void>): Promise<void> {
    const run = (this.queue.get(id) ?? Promise.resolve()).then(work)
    this.queue.set(id, run.catch(() => {}))
    return run
  }

  private apply(id: string, first?: () => Promise<void>): Promise<void> {
    const run = (this.queue.get(id) ?? Promise.resolve()).then(async () => {
      await first?.()
      const m = this.find(id)!
      if (!this.isOn(m) || !m.manifest?.backend) return this.host.stop(id)
      if (this.host.status(id) === 'running') return
      this.errors.delete(id)
      await this.host.start(m, this.values(m, true)).catch((e: Error) => {
        this.errors.set(id, e.message)
        console.warn(`[mods] ${id} did not start: ${e.message}`)
      })
    })
    this.queue.set(id, run.catch(() => {}))
    return run
  }

  private changed() {
    this.emit('changed')
    this.o.broadcast({ t: 'mods', mods: this.list() })
  }

  private settingsFile(id: string) {
    return join(modDataDir(id), 'settings.json')
  }

  /** Defaults, then the stored values; secrets (held in memory) only for the backend. */
  private values(m: DiscoveredMod, withSecrets: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    const fields = m.manifest?.settings ?? []
    const stored = fields.length ? this.readStored(m.id) : {}
    const secrets = this.secrets.get(m.id) ?? {}
    for (const f of fields) {
      const v = f.type === 'secret' ? (withSecrets ? secrets[f.key] : undefined) : stored[f.key]
      if (valid(f, v)) out[f.key] = v
      else if (f.default !== undefined && f.type !== 'secret') out[f.key] = f.default
    }
    return out
  }

  private readStored(id: string): Record<string, unknown> {
    try {
      return JSON.parse(readFileSync(this.settingsFile(id), 'utf8'))
    } catch {
      return {} // no file yet, or a broken one: the defaults stand
    }
  }

  /**
   * Merges `values` into the stored settings: secrets in memory, the rest in the mod's settings.json. Every value is
   * checked first and a bad one rejects the whole call with the reason, so nothing is half-applied or silently dropped.
   */
  async setSettings(id: string, values: Record<string, unknown>): Promise<void> {
    const m = this.find(id)
    if (!m?.manifest) throw new Error(`no mod ${id}`)
    const plain = this.readStored(id)
    const secret: Record<string, unknown> = { ...this.secrets.get(id) }
    for (const [key, v] of Object.entries(values)) {
      const f = m.manifest.settings.find((x) => x.key === key)
      if (!f) throw new Error(`${id} has no setting "${key}"`)
      if (!valid(f, v)) throw new Error(`setting "${key}" must be ${EXPECTED[f.type]}`)
      if (f.type === 'secret') secret[key] = v
      else plain[key] = v
    }
    writeFileSync(this.settingsFile(id), JSON.stringify(plain, null, 2) + '\n')
    this.secrets.set(id, secret)
    this.host.settingsChanged(id, this.values(m, true))
    this.changed()
  }

  list(): ModInfo[] {
    return this.mods.map((m) => {
      const man = m.manifest
      const on = this.isOn(m)
      const status: ModInfo['status'] = m.status !== 'ok' ? m.status : !on ? 'off' : man?.backend ? this.host.status(m.id) : 'running'
      const reason = m.reason ?? (on && status !== 'running' ? this.errors.get(m.id) : undefined)
      const panelUrl = on && man?.panel ? this.uiUrl(m.id, man.panel.entry) : undefined
      const settingsPageUrl = on && man?.settingsPage ? this.uiUrl(m.id, man.settingsPage) : undefined
      return {
        id: m.id,
        name: man?.name ?? m.id,
        version: man?.version ?? '',
        description: man?.description ?? '',
        status,
        ...(reason ? { reason } : {}),
        enabled: on,
        ...(panelUrl ? { panel: { slot: man!.panel!.slot, url: panelUrl } } : {}),
        ...(settingsPageUrl ? { settingsPageUrl } : {}),
        settings: man?.settings ?? [],
        values: m.manifest ? this.values(m, false) : {},
        permissions: man?.permissions ?? [],
        source: m.source,
      }
    })
  }

  /** Only files under ui/ are served (http.ts), so an entry elsewhere has no URL. */
  private uiUrl(id: string, entry: string): string | undefined {
    if (!entry.startsWith('ui/')) return undefined
    return `http://127.0.0.1:${this.o.port()}/mods/${id}/${panelToken(id)}/ui/${entry.slice(3)}`
  }

  /** An app event, to the backends and panels of the enabled mods whose permissions name it. */
  appEvent(type: AppEventType, payload: unknown): void {
    for (const m of this.served()) {
      if (!m.manifest!.permissions.includes(EVENT_PERMS[type])) continue
      this.host.event(m.id, type, payload)
      this.o.broadcast({ t: 'mod-event', id: m.id, type, payload })
    }
  }

  /** A capability call from a mod's panel or backend, checked against its permissions. */
  async appCall(id: string, capability: string, params: unknown): Promise<unknown> {
    const m = this.enabledMod(id)
    const perm = CAPABILITY_PERMS[capability]
    if (!perm) throw new Error(`unknown capability: ${capability}`)
    if (!m.manifest!.permissions.includes(perm)) throw new Error(`permission denied: ${capability}`)
    if (capability === 'theme.set') return void this.o.broadcast({ t: 'mod-event', id: '_app', type: 'theme.set', payload: params })
    if (capability === 'notify') {
      // An app toast, not a session event: it must show with no session running.
      const text = (params as { text?: unknown } | null)?.text
      if (typeof text !== 'string' || !text.trim()) throw new Error('notify needs a non-empty text')
      return void this.o.broadcast({ t: 'mod-event', id: '_app', type: 'notify', payload: { modId: id, text } })
    }
    return this.o.app(id, capability as SessionCapability, params)
  }

  async panelCall(id: string, method: string, params?: unknown): Promise<unknown> {
    this.enabledMod(id)
    return this.host.panelCall(id, method, params)
  }

  async toolCall(id: string, name: string, input: unknown): Promise<unknown> {
    this.enabledMod(id)
    return this.host.toolCall(id, name, input)
  }

  enabledTools(): { id: string; tool: ToolDef }[] {
    // Tools reach the agent only with the agent.tools permission.
    return this.served()
      .filter((m) => m.manifest!.permissions.includes('agent.tools'))
      .flatMap((m) => m.manifest!.tools.map((tool) => ({ id: m.id, tool })))
  }

  enabledSkills(): { id: string; name: string; dir: string }[] {
    return this.served().flatMap((m) => m.manifest!.skills.map((name) => ({ id: m.id, name, dir: join(m.dir, 'skills', name) })))
  }

  stopAll(): Promise<void> {
    return this.host.stopAll()
  }
}

const EXPECTED: Record<SettingField['type'], string> = { string: 'text', secret: 'text', number: 'a number', boolean: 'true or false', select: 'one of its options' }

function valid(f: SettingField, v: unknown): boolean {
  switch (f.type) {
    case 'string':
    case 'secret':
      return typeof v === 'string'
    case 'number':
      return typeof v === 'number' && Number.isFinite(v)
    case 'boolean':
      return typeof v === 'boolean'
    case 'select':
      return typeof v === 'string' && !!f.options?.includes(v)
  }
}
