// The ticket board as a Waifufy mod backend (mod.json): the panel reads the board through `panel.call board`,
// the agent files and moves tickets through `tool.call`, and the panel is told to refresh after any write and
// after every turn. The store is the same one the CLI and the Claude Code MCP server use (see ./src/store.mjs).
// Protocol: newline-delimited JSON-RPC on stdin/stdout; stdout carries protocol frames only.

import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { STATUSES, TicketError, TicketStore, defaultDbPath } from './src/store.mjs'
import { runTool } from './src/tools.mjs'

const READ_ONLY = ['ticket_board', 'ticket_list', 'ticket_get']

let settings = {}
let open

const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n')
const changed = () => send({ method: 'panel.emit', params: { type: 'changed' } })

/** One open store per process; a failure drops it so a fixed database is picked up on the next call. */
function theStore() {
  open ??= new TicketStore(defaultDbPath())
  return open
}
function drop() {
  try {
    open?.close()
  } catch {
    // already closed
  }
  open = undefined
}

const zeros = () => Object.fromEntries(STATUSES.map((s) => [s, 0]))
const empty = (extra) => ({ generatedAt: Date.now(), total: 0, counts: zeros(), projects: [], columns: [], ...extra })

/** The fields the card draws; the ticket's verbatim `source` stays in the database. */
const card = (t) => ({
  id: t.id,
  title: t.title,
  status: t.status,
  priority: t.priority ?? 0,
  labels: t.labels ?? [],
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
  ...(t.project ? { project: t.project } : {}),
  ...(t.body ? { body: t.body } : {}),
  ...(t.blockedReason ? { blockedReason: t.blockedReason } : {}),
  ...(t.sourceRef ? { sourceRef: t.sourceRef } : {}),
})

/** The panel's snapshot. No database yet is an empty board (opening would create the file); an unreadable one says why. */
function board(params) {
  const path = defaultDbPath()
  if (!existsSync(path)) return empty({ available: true, dbPath: path })
  try {
    const project = (params?.project ?? settings.project) || undefined
    const doneLimit = params?.doneLimit ?? settings.doneLimit
    const b = theStore().board({ project, ...(doneLimit > 0 ? { doneLimit } : {}) })
    return { available: true, dbPath: b.dbPath, generatedAt: b.generatedAt, total: b.total, counts: b.counts, projects: b.projects,
      columns: b.columns.map((c) => ({ ...c, tickets: c.tickets.map(card) })) }
  } catch (e) {
    drop()
    return empty({ available: false, reason: e instanceof Error ? e.message : String(e) })
  }
}

function handle(m) {
  switch (m.method) {
    case 'init':
      settings = m.params?.settings ?? {}
      return null
    case 'settings.changed':
      settings = m.params?.settings ?? {}
      return void changed()
    case 'event':
      return void (m.params?.type === 'turn.end' && changed())
    case 'panel.call':
      if (m.params.method === 'board') return board(m.params.params)
      throw new Error(`unknown panel method: ${m.params.method}`)
    case 'tool.call': {
      const { name, input } = m.params
      try {
        return runTool(theStore(), name, input ?? {})
      } finally {
        if (!READ_ONLY.includes(name)) changed()
      }
    }
    default:
      return null
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'shutdown') {
    drop()
    send({ id: m.id, result: null })
    return void setTimeout(() => process.exit(0), 10)
  }
  try {
    const result = handle(m)
    if (m.id !== undefined) send({ id: m.id, result: result ?? null })
  } catch (e) {
    // A TicketError is the caller's to fix (the agent sees its message); anything else is logged for mod.log.
    if (!(e instanceof TicketError)) process.stderr.write(`${e?.stack ?? e}\n`)
    if (m.id !== undefined) send({ id: m.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } })
  }
})
