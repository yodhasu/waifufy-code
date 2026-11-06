// Runs each mod's backend as a separate Node process under Node's permission model and talks JSON-RPC to it
// over stdio. The child gets read access to its own folder and data folder, write access to its data folder and whatever
// fs.read:/fs.write: paths its manifest declares; it gets no child-process or worker rights unless declared.
// A crashed backend is restarted at most 3 times per sliding minute, then marked `crashed`.

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { childEnv } from '../shell.ts'
import { modDataDir, type DiscoveredMod } from './discover.ts'
import { RpcPeer } from './rpc.ts'

export type ModStatus = 'running' | 'off' | 'crashed'

export type HostOptions = {
  toolTimeoutMs?: number
  panelTimeoutMs?: number
  initTimeoutMs?: number
  /** How long `shutdown` gets before the child is killed. */
  stopGraceMs?: number
  restartWindowMs?: number
  maxRestarts?: number
  restartDelayMs?: number
  now?: () => number
}

/** `%APPDATA%`, `%LOCALAPPDATA%` and a leading `~` in a declared path. */
function expand(p: string): string {
  return p
    .replace(/^~(?=$|[\\/])/, homedir())
    .replace(/%(APPDATA|LOCALAPPDATA)%/gi, (_, k: string) => process.env[k.toUpperCase()] ?? '')
}

/** Node arguments (before the entry file) that confine a mod's backend. One flag per path: paths may hold commas. */
export function nodeArgs(mod: DiscoveredMod): string[] {
  const perms = mod.manifest?.permissions ?? []
  const declared = (kind: 'fs.read:' | 'fs.write:') =>
    perms.filter((p) => p.startsWith(kind)).map((p) => expand(p.slice(kind.length).trim())).filter(Boolean)
  const args = ['--permission']
  for (const p of [mod.dir, modDataDir(mod.id), ...declared('fs.read:')]) args.push(`--allow-fs-read=${p}`)
  for (const p of [modDataDir(mod.id), ...declared('fs.write:')]) args.push(`--allow-fs-write=${p}`)
  if (perms.includes('process.spawn')) args.push('--allow-child-process')
  if (perms.includes('process.worker')) args.push('--allow-worker')
  return args
}

type Entry = {
  mod: DiscoveredMod
  settings: Record<string, unknown>
  status: ModStatus
  child?: ChildProcess
  peer?: RpcPeer
  exited?: Promise<void>
  crashes: number[]
  stopping: boolean
}

/** Every live child, so the process 'exit' handler can kill them all if the link goes down. */
const live = new Set<ChildProcess>()
process.on('exit', () => {
  for (const c of live) c.kill()
})

export class ModHost extends EventEmitter {
  private entries = new Map<string, Entry>()
  private o: Required<HostOptions>

  constructor(options: HostOptions = {}) {
    super()
    this.o = {
      toolTimeoutMs: 10_000,
      panelTimeoutMs: 5_000,
      initTimeoutMs: 10_000,
      stopGraceMs: 1_000,
      restartWindowMs: 60_000,
      maxRestarts: 3,
      restartDelayMs: 250,
      now: Date.now,
      ...options,
    }
  }

  status(id: string): ModStatus {
    return this.entries.get(id)?.status ?? 'off'
  }

  /** The backend's process id, if one is running. */
  pid(id: string): number | undefined {
    return this.entries.get(id)?.child?.pid
  }

  private setStatus(id: string, e: Entry, status: ModStatus) {
    if (e.status === status) return
    e.status = status
    this.emit('status', id, status)
  }

  /** Start a mod's backend (restarting it if it already runs). Rejects, leaving nothing running, if init fails. */
  async start(mod: DiscoveredMod, settings: Record<string, unknown>): Promise<void> {
    if (mod.status !== 'ok' || !mod.manifest?.backend) throw new Error(`${mod.id} has no runnable backend`)
    await this.stop(mod.id)
    const e: Entry = { mod, settings, status: 'off', crashes: [], stopping: false }
    this.entries.set(mod.id, e)
    try {
      await this.launch(e)
    } catch (err) {
      e.stopping = true
      e.child?.kill()
      this.entries.delete(mod.id)
      throw err
    }
  }

  private async launch(e: Entry): Promise<void> {
    const { mod } = e
    const data = modDataDir(mod.id)
    const logFile = join(data, 'mod.log')
    const log = (text: string) => {
      try {
        appendFileSync(logFile, text.endsWith('\n') ? text : text + '\n')
      } catch {
        // a full disk must not take the backend down with it
      }
    }
    const child = spawn(process.execPath, [...nodeArgs(mod), join(mod.dir, mod.manifest!.backend!.entry)], {
      cwd: mod.dir,
      env: { ...childEnv(), WC_MOD_ID: mod.id, WC_MOD_DATA: data },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    live.add(child)
    e.child = child
    child.stderr!.on('data', (d: Buffer) => log(d.toString()))
    const peer = new RpcPeer(child.stdout!, child.stdin!, (m, p) => this.fromMod(e, m, p, log), (l) => log(`[stdout] ${l}`))
    e.peer = peer
    let gone = false
    const onGone = () => {
      if (gone) return
      gone = true
      live.delete(child)
      peer.close()
      if (!e.stopping && e.child === child) this.crashed(e)
    }
    e.exited = new Promise<void>((resolve) => {
      child.once('close', () => (onGone(), resolve()))
      child.once('error', () => (onGone(), resolve())) // spawn failure: 'exit' may never come
    })
    await peer.request('init', { apiVersion: 1, settings: e.settings, grantedPermissions: mod.manifest!.permissions }, this.o.initTimeoutMs)
    if (e.child === child && !gone) this.setStatus(mod.id, e, 'running')
  }

  private crashed(e: Entry) {
    const now = this.o.now()
    this.setStatus(e.mod.id, e, 'off') // not running during the gap before the restart
    e.crashes = [...e.crashes.filter((t) => now - t < this.o.restartWindowMs), now]
    if (e.crashes.length > this.o.maxRestarts) {
      this.setStatus(e.mod.id, e, 'crashed')
      return
    }
    setTimeout(() => {
      if (e.stopping) return
      // A failed init kills the child; its exit counts as the next crash.
      this.launch(e).catch(() => e.child?.kill())
    }, this.o.restartDelayMs)
  }

  private async fromMod(e: Entry, method: string, params: unknown, log: (s: string) => void): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>
    if (method === 'panel.emit') {
      this.emit('emit', e.mod.id, { type: p.type, payload: p.payload })
      return null
    }
    if (method === 'log') {
      log(`[${String(p.level ?? 'info')}] ${String(p.message ?? '')}`)
      return null
    }
    if (method === 'app.call') {
      if (!this.listenerCount('app')) throw new Error('no app handler')
      return new Promise((resolve, reject) => {
        const reply = (value: unknown, error?: string) => (error ? reject(new Error(error)) : resolve(value))
        this.emit('app', e.mod.id, { capability: p.capability, params: p.params }, reply)
      })
    }
    throw new Error(`unknown method ${method}`)
  }

  /** Ask the backend to shut down, give it a moment, then kill it. */
  async stop(id: string): Promise<void> {
    const e = this.entries.get(id)
    if (!e) return
    e.stopping = true
    this.entries.delete(id)
    const { child, peer } = e
    if (child && e.exited && child.exitCode === null) {
      peer?.request('shutdown', null, this.o.stopGraceMs).catch(() => {})
      await Promise.race([e.exited, new Promise((r) => setTimeout(r, this.o.stopGraceMs))])
      if (child.exitCode === null) child.kill()
      await e.exited
    }
    peer?.close()
    this.emit('status', id, 'off')
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.stop(id)))
  }

  private call(id: string, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const e = this.entries.get(id)
    if (!e?.peer || e.status !== 'running') return Promise.reject(new Error(`mod ${id} is ${this.status(id)}`))
    return e.peer.request(method, params, timeoutMs)
  }

  toolCall(id: string, name: string, input: unknown): Promise<unknown> {
    return this.call(id, 'tool.call', { name, input }, this.o.toolTimeoutMs)
  }

  panelCall(id: string, method: string, params: unknown): Promise<unknown> {
    return this.call(id, 'panel.call', { method, params }, this.o.panelTimeoutMs)
  }

  event(id: string, type: string, payload: unknown): void {
    this.entries.get(id)?.peer?.notify('event', { type, payload })
  }

  settingsChanged(id: string, settings: Record<string, unknown>): void {
    const e = this.entries.get(id)
    if (!e) return
    e.settings = settings
    e.peer?.notify('settings.changed', { settings })
  }
}
