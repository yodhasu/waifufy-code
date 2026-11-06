// The optional ticket board (plugins/waifufy-tickets), as the chat panel's card draws it. The ticket engine
// is a plugin folder, not a dependency — the app works without it — so the plugin's own store is loaded on
// first use and every failure comes back as a snapshot the panel can show instead of a WebSocket error.
// Read-only: tickets are created and moved by the agent (the plugin's MCP tools) or by hand (its CLI).

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { BoardSnapshot, TicketCard, TicketStatus } from './protocol.ts'

/** The repo this link lives in, from this module's own URL, so the sidecar works whatever its cwd is. */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** Column ids in board order, as protocol.ts freezes them. The labels and hints come from the plugin's store. */
const STATUSES: readonly TicketStatus[] = ['inbox', 'todo', 'doing', 'blocked', 'done']

/** The slice of the plugin's `TicketStore` this bridge uses. */
type Store = {
  board(options?: { project?: string; doneLimit?: number }): unknown
  close?(): void
}
type StoreCtor = new (path?: string) => Store

/** A store row as plain JSON: everything crossing in from the plugin is checked field by field. */
type Row = Record<string, unknown>

const isStr = (v: unknown): v is string => typeof v === 'string'
const str = (v: unknown) => (isStr(v) ? v : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * The plugin folder: `WC_TICKETS_PLUGIN` (a test, or a checkout elsewhere) wins, then the copy Claude Code
 * installed (like a game's mods folder, so installing or updating it never needs an app rebuild), then the
 * repo's own for dev. The installed app has no repo: its REPO_ROOT is the sidecar folder.
 */
export function pluginDir() {
  return process.env.WC_TICKETS_PLUGIN || installedPluginDir() || join(REPO_ROOT, 'plugins', 'waifufy-tickets')
}

/** `installPath` of waifufy-tickets in Claude Code's installed_plugins.json, newest first; undefined if none has a store. */
function installedPluginDir(): string | undefined {
  const file = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'plugins', 'installed_plugins.json')
  let entries: unknown
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { plugins?: Record<string, unknown> }
    entries = data.plugins?.['waifufy-tickets@waifufy']
  } catch {
    return undefined // no Claude Code plugins yet, or an unreadable file: fall back to the repo
  }
  if (!Array.isArray(entries)) return undefined
  return entries
    .filter((e): e is { installPath: string; lastUpdated?: string } => isStr(e?.installPath))
    .sort((a, b) => str(b.lastUpdated).localeCompare(str(a.lastUpdated)))
    .map((e) => e.installPath)
    .find((dir) => existsSync(join(dir, 'src', 'store.mjs')))
}

/** `WC_TICKETS_DB` wins, else the plugin's own config folder — never the app's data dir (its store's rule). */
function dbFile() {
  if (process.env.WC_TICKETS_DB) return resolve(process.env.WC_TICKETS_DB)
  const base = process.env.APPDATA || process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'waifufy-tickets', 'kanban.db')
}

const zeroCounts = (): Record<TicketStatus, number> => ({ inbox: 0, todo: 0, doing: 0, blocked: 0, done: 0 })

/** The panel's install-hint snapshot. `reason` is shown verbatim, so it names the folder that was looked in. */
function unavailable(reason: string): BoardSnapshot {
  return { available: false, reason, generatedAt: Date.now(), total: 0, counts: zeroCounts(), projects: [], columns: [] }
}

/** No database yet: an installed plugin nobody has filed a ticket with. */
function emptyBoard(dbPath: string): BoardSnapshot {
  return { available: true, dbPath, generatedAt: Date.now(), total: 0, counts: zeroCounts(), projects: [], columns: [] }
}

// One plugin load and one open store per process: a panel refresh is a read of a local file, and keeping the
// connection open is what makes repeat refreshes cheap. A failure drops both, so a plugin installed — or a
// database moved — between two requests is picked up without a link restart.
let loaded: { dir: string; ctor: StoreCtor } | undefined
let open: { path: string; store: Store } | undefined

function release() {
  try {
    open?.store.close?.()
  } catch {
    // A handle that is already gone is fine; a close failure must not become a board error.
  }
  open = undefined
}

async function storeCtor(dir: string): Promise<StoreCtor> {
  if (loaded?.dir === dir) return loaded.ctor
  const file = join(dir, 'src', 'store.mjs')
  if (!existsSync(file)) throw new Error(`the waifufy-tickets plugin isn't installed: no ${file}`)
  // Variable specifier on purpose: tsc must not try to resolve or compile the plugin's JavaScript.
  const mod = (await import(pathToFileURL(file).href)) as { TicketStore?: StoreCtor }
  if (typeof mod.TicketStore !== 'function') throw new Error(`${file} doesn't export TicketStore`)
  loaded = { dir, ctor: mod.TicketStore }
  return mod.TicketStore
}

async function theStore(dir: string, path: string): Promise<Store> {
  if (open?.path === path) return open.store
  release()
  const store = new (await storeCtor(dir))(path)
  open = { path, store }
  return store
}

/** One ticket as the panel draws it. Only the frozen fields travel: a newer plugin must not change the wire. */
function toCard(row: Row, status: TicketStatus): TicketCard {
  const card: TicketCard = {
    id: str(row.id),
    title: str(row.title),
    status,
    priority: num(row.priority),
    labels: Array.isArray(row.labels) ? row.labels.filter(isStr) : [],
    createdAt: num(row.createdAt),
    updatedAt: num(row.updatedAt),
  }
  if (isStr(row.project)) card.project = row.project
  if (isStr(row.body)) card.body = row.body
  if (isStr(row.blockedReason)) card.blockedReason = row.blockedReason
  if (isStr(row.sourceRef)) card.sourceRef = row.sourceRef
  return card
}

/** Columns in the store's own order. A status the contract doesn't know can't be drawn, so it is left out. */
function toColumns(rows: unknown): BoardSnapshot['columns'] {
  if (!Array.isArray(rows)) return []
  const columns: BoardSnapshot['columns'] = []
  for (const raw of rows) {
    const col = (raw ?? {}) as Row
    const status = isStr(col.status) ? STATUSES.find((s) => s === col.status) : undefined
    if (!status) continue
    const tickets = Array.isArray(col.tickets) ? col.tickets : []
    columns.push({ status, label: str(col.label) || status, hint: str(col.hint), tickets: tickets.map((t) => toCard((t ?? {}) as Row, status)) })
  }
  return columns
}

function toProjects(value: unknown): { project: string; count: number }[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw) => {
    const row = (raw ?? {}) as Row
    return isStr(row.project) ? [{ project: row.project, count: num(row.count) }] : []
  })
}

/** The store's counts keyed by the statuses in the contract; anything else is zero. */
function toCounts(value: unknown): Record<TicketStatus, number> {
  const out = zeroCounts()
  const row = (value ?? {}) as Row
  for (const status of STATUSES) out[status] = num(row[status])
  return out
}

/**
 * The board for the panel. A missing plugin, a missing database or an unreadable store are all normal
 * answers, never errors: each one comes back as a snapshot that says what it found.
 */
export async function ticketBoard(project?: string): Promise<BoardSnapshot> {
  const dir = pluginDir()
  const file = join(dir, 'src', 'store.mjs')
  if (!existsSync(file)) return unavailable(`the waifufy-tickets plugin isn't installed (looked in ${dir})`)
  const path = dbFile()
  // An installed plugin with no tickets yet has no database. That is an empty board, and deliberately not an
  // open: opening the store would create the file, and this bridge only ever reads.
  if (!existsSync(path)) return emptyBoard(path)
  try {
    const board = (await (await theStore(dir, path)).board({ project })) as Row
    return {
      available: true,
      dbPath: str(board.dbPath) || path,
      generatedAt: num(board.generatedAt) || Date.now(),
      total: num(board.total),
      counts: toCounts(board.counts),
      projects: toProjects(board.projects),
      columns: toColumns(board.columns),
    }
  } catch (e) {
    // A store that can't be read (a corrupt file, a plugin on an older layout) reads as unavailable to the
    // panel; dropping the cache means the next request starts over, so fixing it needs no link restart.
    release()
    loaded = undefined
    return unavailable(e instanceof Error ? e.message : String(e))
  }
}
