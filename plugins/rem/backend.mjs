// REM (Running Every Midnight) as a Waifufy mod backend. Each night at `start` it replaces whatever session is
// open with a fresh one in `cwd`, permission mode auto, whose first message is the night brief; then it forwards
// every new ticket labelled `label` into that session, says "wrap up" at `wrapUp` and interrupts at `stop`.
// The WhatsApp filter that mints the tickets and the per-run reports live outside the app (lab/rem-system/rem.py).
// Protocol: newline-delimited JSON-RPC on stdin/stdout; stdout carries protocol frames only.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { plan } from './plan.mjs'

const TICK_MS = Number(process.env.WC_REM_TICK_MS) || 30_000
let settings = {}
const statePath = process.env.WC_MOD_DATA ? join(process.env.WC_MOD_DATA, 'state.json') : undefined
let state = { started: null, wrapped: null, stopped: null, forwarded: [] }
let timer
let busy = false

const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n')
const log = (message, level = 'info') => send({ method: 'log', params: { level, message } })

let seq = 0
const waiting = new Map()
/** A capability call to the app (session.start, session.interrupt, chat.send). */
function app(capability, params) {
  const id = `rem-${++seq}`
  send({ id, method: 'app.call', params: { capability, params } })
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }))
}

function save() {
  if (statePath) writeFileSync(statePath, JSON.stringify(state))
}

const ticketsDb = () => join(process.env.APPDATA ?? '', 'waifufy-tickets', 'kanban.db')

/** Open REM tickets waiting in the inbox: [{ id, title, labels }]. */
function inbox() {
  if (!existsSync(ticketsDb())) return []
  const db = new DatabaseSync(ticketsDb(), { readOnly: true })
  try {
    return db
      .prepare("SELECT id, title, labels FROM tickets WHERE status = 'inbox' ORDER BY created_at")
      .all()
      .map((r) => ({ id: r.id, title: r.title, labels: r.labels ? JSON.parse(r.labels) : [] }))
      .filter((t) => t.labels.includes(settings.label || 'rem'))
  } finally {
    db.close()
  }
}

function brief() {
  return readFileSync(settings.brief, 'utf8')
    .replaceAll('{{loops}}', String(settings.loops ?? 3))
    .replaceAll('{{last_commit}}', settings.wrapUp ?? '06:00')
}

async function tick() {
  if (busy) return
  busy = true
  try {
    const actions = plan(new Date(), state, settings, inbox())
    for (const a of actions) {
      if (a.t === 'start') {
        await app('session.start', { cwd: settings.cwd, mode: 'auto', text: brief() })
        log(`night ${a.night}: session started in ${settings.cwd}`)
      } else if (a.t === 'forward') {
        await app('chat.send', { text: `REM: new ticket ${a.ticket.id} — ${a.ticket.title}. Triage it, then hand it to that client's subagent.` })
      } else if (a.t === 'wrap') {
        await app('chat.send', { text: `REM: wrap up. It is ${settings.wrapUp}: no more commits. Push unfinished work as wip/ branches, comment what is left, move those tickets to blocked.` })
      } else if (a.t === 'stop') {
        await app('session.interrupt', {})
        log(`night ${a.night}: hard stop`)
      }
      Object.assign(state, a.state)
      save()
    }
  } catch (e) {
    log(`tick failed: ${e instanceof Error ? e.message : String(e)}`, 'error') // retried on the next tick
  } finally {
    busy = false
  }
}

function handle(m) {
  switch (m.method) {
    case 'init': {
      settings = m.params?.settings ?? {}
      if (statePath && existsSync(statePath)) state = { ...state, ...JSON.parse(readFileSync(statePath, 'utf8')) }
      clearInterval(timer)
      timer = setInterval(tick, TICK_MS)
      void tick()
      return null
    }
    case 'settings.changed':
      settings = m.params?.settings ?? {}
      return null
    case 'event':
      return null
    case 'shutdown':
      clearInterval(timer)
      setTimeout(() => process.exit(0), 50)
      return null
    default:
      throw new Error(`unknown method ${m.method}`)
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  if (m.method === undefined && waiting.has(m.id)) {
    const w = waiting.get(m.id)
    waiting.delete(m.id)
    return m.error ? w.reject(new Error(m.error.message ?? 'app call failed')) : w.resolve(m.result)
  }
  try {
    const result = handle(m)
    if (m.id !== undefined) send({ id: m.id, result: result ?? null })
  } catch (e) {
    if (m.id !== undefined) send({ id: m.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } })
  }
})
