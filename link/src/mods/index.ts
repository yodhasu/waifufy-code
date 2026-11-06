// The link's mod service: which mods exist, which are on (the `plugins.<id>` settings flag, defaulting to the
// manifest's defaultEnabled), their backends, settings, app events and capability calls. server.ts owns the
// WebSocket; everything here reaches the app through the `broadcast` it is given.

import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModInfo, ServerMsg } from '../protocol.ts'
import { discoverMods, modDataDir, type DiscoveredMod } from './discover.ts'
import { ModHost } from './host.ts'
import { panelToken } from './http.ts'
import type { SettingField, ToolDef } from './manifest.ts'

export type AppEventType = 'turn.end' | 'emotion' | 'affection' | 'message'
/** The permission each app event needs. */
const EVENT_PERMS: Record<AppEventType, string> = { 'turn.end': 'events.turn', emotion: 'events.emotion', affection: 'events.affection', message: 'events.message' }
/** The permission each capability needs. */
const CAPABILITY_PERMS: Record<string, string> = { 'chat.send': 'chat.send', notify: 'notify', 'theme.set': 'theme' }

export type ModsOptions = {
  broadcast: (m: ServerMsg) => void
  /** The link's HTTP port, for panel URLs. */
  port: () => number
  /** The stored `plugins` flags. */
  flags: () => Promise<Record<string, boolean>>
  setFlag: (id: string, on: boolean) => Promise<void>
  /** Runs `chat.send` for a mod (already permission-checked). */
  app: (id: string, capability: 'chat.send', params: unknown) => unknown
  discover?: () => DiscoveredMod[]
  host?: ModHost
}

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
    this.mods = (this.o.discover ?? discoverMods)()
    await this.refresh()
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
    let stored: Record<string, unknown> = {}
    try {
      if (fields.length) stored = JSON.parse(readFileSync(this.settingsFile(m.id), 'utf8'))
    } catch {
      // no file yet, or a broken one: the defaults stand
    }
    const secrets = this.secrets.get(m.id) ?? {}
    for (const f of fields) {
      const v = f.type === 'secret' ? (withSecrets ? secrets[f.key] : undefined) : stored[f.key]
      if (valid(f, v)) out[f.key] = v
      else if (f.default !== undefined && f.type !== 'secret') out[f.key] = f.default
    }
    return out
  }

  /** Keeps the declared, well-typed values: secrets in memory, the rest in the mod's settings.json. */
  async setSettings(id: string, values: Record<string, unknown>): Promise<void> {
    const m = this.find(id)
    if (!m?.manifest) throw new Error(`no mod ${id}`)
    const plain: Record<string, unknown> = {}
    const secret: Record<string, unknown> = { ...this.secrets.get(id) }
    for (const f of m.manifest.settings) {
      const v = values?.[f.key]
      if (!valid(f, v)) continue
      if (f.type === 'secret') secret[f.key] = v
      else plain[f.key] = v
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
    return this.o.app(id, 'chat.send', params)
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
    return this.served().flatMap((m) => m.manifest!.tools.map((tool) => ({ id: m.id, tool })))
  }

  enabledSkills(): { id: string; name: string; dir: string }[] {
    return this.served().flatMap((m) => m.manifest!.skills.map((name) => ({ id: m.id, name, dir: join(m.dir, 'skills', name) })))
  }

  stopAll(): Promise<void> {
    return this.host.stopAll()
  }
}

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
