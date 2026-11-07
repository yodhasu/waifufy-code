// The Waifufy mod: mod.json stays in step with src/tools.mjs, and backend.mjs speaks the mod protocol
// (init, panel.call, tool.call, events) over a real child process on a temp database.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { TOOLS } from '../src/tools.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

test('mod.json tools equal src/tools.mjs TOOLS', () => {
  const mod = JSON.parse(readFileSync(join(ROOT, 'mod.json'), 'utf8'))
  assert.deepEqual(mod.tools, TOOLS)
  assert.equal(TOOLS.length, 7)
})

/** A backend child with `rpc(method, params)` and the pushes it made. */
function backend() {
  const db = join(mkdtempSync(join(tmpdir(), 'wc-tickets-mod-')), 'kanban.db')
  const child = spawn(process.execPath, [join(ROOT, 'backend.mjs')], { env: { ...process.env, WC_TICKETS_DB: db }, stdio: ['pipe', 'pipe', 'inherit'] })
  const pending = new Map()
  const pushes = []
  let seq = 0
  createInterface({ input: child.stdout }).on('line', (line) => {
    const m = JSON.parse(line)
    if (m.id === undefined) return void pushes.push(m)
    const p = pending.get(m.id)
    pending.delete(m.id)
    if (m.error) p.reject(new Error(m.error.message))
    else p.resolve(m.result)
  })
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  const stop = () => child.kill()
  return { rpc, notify, pushes, stop }
}
const settle = () => new Promise((r) => setTimeout(r, 100))

test('backend: an empty board, a write tool, then the board with the new ticket', async () => {
  const b = backend()
  try {
    await b.rpc('init', { apiVersion: 1, settings: { project: '', doneLimit: 10 }, grantedPermissions: [] })
    const empty = await b.rpc('panel.call', { method: 'board', params: {} })
    assert.equal(empty.available, true)
    assert.equal(empty.total, 0)

    const said = await b.rpc('tool.call', { name: 'ticket_create', input: { title: 'Fix the login redirect', project: 'booking-agent', priority: 2 } })
    assert.match(said, /^created WC-1 /)
    await settle()
    assert.ok(b.pushes.some((p) => p.method === 'panel.emit' && p.params.type === 'changed'), 'a write tool tells the panel')

    const board = await b.rpc('panel.call', { method: 'board', params: {} })
    assert.equal(board.total, 1)
    assert.equal(board.columns.find((c) => c.status === 'inbox').tickets[0].title, 'Fix the login redirect')
    assert.equal(board.columns.find((c) => c.status === 'inbox').tickets[0].priority, 2)

    b.pushes.length = 0
    await b.rpc('tool.call', { name: 'ticket_list', input: {} })
    await settle()
    assert.equal(b.pushes.length, 0, 'a read tool is quiet')
    b.notify('event', { type: 'turn.end', payload: {} })
    await settle()
    assert.ok(b.pushes.some((p) => p.params.type === 'changed'), 'turn.end tells the panel')

    await assert.rejects(b.rpc('tool.call', { name: 'ticket_get', input: { id: 'WC-99' } }), /WC-99/)
    await b.rpc('shutdown')
  } finally {
    b.stop()
  }
})

test('backend: the project setting filters the board', async () => {
  const b = backend()
  try {
    await b.rpc('init', { apiVersion: 1, settings: { project: 'a', doneLimit: 10 }, grantedPermissions: [] })
    await b.rpc('tool.call', { name: 'ticket_create', input: { title: 'one', project: 'a' } })
    await b.rpc('tool.call', { name: 'ticket_create', input: { title: 'two', project: 'b' } })
    assert.equal((await b.rpc('panel.call', { method: 'board', params: {} })).total, 1)
    b.notify('settings.changed', { settings: { project: '', doneLimit: 10 } })
    await settle()
    assert.equal((await b.rpc('panel.call', { method: 'board', params: {} })).total, 2)
  } finally {
    b.stop()
  }
})
