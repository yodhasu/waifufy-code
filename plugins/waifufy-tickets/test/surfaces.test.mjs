// End-to-end tests over the real surfaces: the CLI (spawned) and the MCP stdio server
// (spawned, spoken to as a client). No agent, no Claude Code needed.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'bin', 'tickets.mjs')
const MCP = join(ROOT, 'bin', 'tickets-mcp.mjs')

let dir
let dbPath

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'wc-tickets-e2e-'))
  dbPath = join(dir, 'kanban.db')
})

after(() => {
  // Spawned servers may still hold the WAL when this runs; a leftover %TEMP% folder must never
  // fail the suite, so cleanup is best-effort on top of waiting for the children.
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  } catch (error) {
    console.warn(`could not remove ${dir}: ${error.code}`)
  }
})

/** Run the CLI with an isolated database. */
function cli(args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, WC_TICKETS_DB: dbPath },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => resolvePromise({ code, out, err }))
  })
}

/** Minimal MCP client over the server's stdio. */
class McpClient {
  #child
  #buf = ''
  #waiters = []
  #nextId = 1

  static start(db) {
    const client = new McpClient()
    client.#child = spawn(process.execPath, [MCP], { env: { ...process.env, WC_TICKETS_DB: db } })
    client.#child.stdout.setEncoding('utf8')
    client.#child.stdout.on('data', (chunk) => client.#onData(chunk))
    // Resolved once the server is really gone, so cleanup never races a live process holding the db.
    client.exited = new Promise((resolveExit) => client.#child.once('exit', resolveExit))
    return client
  }

  #onData(chunk) {
    this.#buf += chunk
    let index
    while ((index = this.#buf.indexOf('\n')) !== -1) {
      const line = this.#buf.slice(0, index).trim()
      this.#buf = this.#buf.slice(index + 1)
      if (!line) continue
      const message = JSON.parse(line)
      const waiter = this.#waiters.find((w) => w.id === message.id)
      if (waiter) {
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1)
        waiter.resolve(message)
      } else {
        this.unmatched.push(message)
      }
    }
  }

  unmatched = []

  call(method, params) {
    const id = this.#nextId++
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 10000)
      this.#waiters.push({
        id,
        resolve: (message) => {
          clearTimeout(timer)
          resolvePromise(message)
        },
      })
    })
  }

  notify(method, params) {
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  async stop() {
    this.#child.stdin.end()
    await this.exited
  }
}

describe('cli', () => {
  it('adds, lists, moves and shows a ticket', async () => {
    const add = await cli(['add', 'Fix the save race', '--project', 'waifufy-code', '--dedupe', 'wc:save-race', '--json'])
    assert.equal(add.code, 0)
    const created = JSON.parse(add.out)
    assert.equal(created.created, true)
    assert.match(created.ticket.id, /^WC-\d+$/)

    const again = await cli(['add', 'Fix the save race again', '--dedupe', 'wc:save-race', '--json'])
    assert.equal(JSON.parse(again.out).created, false, 'the same dedupe key must not duplicate')

    const moved = await cli(['move', created.ticket.id, 'doing', '--json'])
    assert.equal(moved.code, 0)
    assert.equal(JSON.parse(moved.out).to, 'doing')

    const blocked = await cli(['move', created.ticket.id, 'blocked'])
    assert.equal(blocked.code, 1, 'blocked without a reason is refused')
    assert.match(blocked.err, /needs a reason/)

    const listed = await cli(['list', '--json'])
    const rows = JSON.parse(listed.out)
    assert.ok(rows.some((t) => t.id === created.ticket.id))

    const shown = await cli(['show', created.ticket.id])
    assert.match(shown.out, /Fix the save race/)
    assert.match(shown.out, /status: doing/)
  })

  it('reads a source file so long input never needs quoting', async () => {
    const raw = join(dir, 'raw.txt')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(raw, 'the watchdog restarts the sidecar mid-turn\nsecond line', 'utf8')
    const added = await cli(['add', 'Watchdog restart', '--source-file', raw, '--json'])
    const ticket = JSON.parse(added.out).ticket
    const shown = await cli(['show', ticket.id, '--json'])
    assert.match(JSON.parse(shown.out).source, /restarts the sidecar mid-turn/)
  })

  it('renders the board and writes a standalone html board', async () => {
    const board = await cli(['board'])
    assert.equal(board.code, 0)
    assert.match(board.out, /Inbox/)
    assert.match(board.out, /Doing/)

    const html = join(dir, 'board.html')
    const write = await cli(['board', '--html', html])
    assert.equal(write.code, 0)
    assert.ok(existsSync(html))
    const markup = readFileSync(html, 'utf8')
    assert.match(markup, /<!doctype html>/i)
    assert.match(markup, /Waifufy Tickets|waifufy/i)
  })

  it('fails cleanly on a missing ticket', async () => {
    const missing = await cli(['show', 'WC-4242'])
    assert.equal(missing.code, 3)
    assert.match(missing.err, /no ticket WC-4242/)
  })

  it('prints the database path', async () => {
    const path = await cli(['path'])
    assert.equal(path.code, 0)
    assert.equal(path.out.trim(), resolve(dbPath))
  })
})

describe('mcp', () => {
  it('initializes, lists tools, and drives the board', async () => {
    const mcpDb = join(dir, 'mcp.db')
    const client = McpClient.start(mcpDb)
    try {
      const init = await client.call('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      })
      assert.equal(init.result.serverInfo.name, 'waifufy-tickets')
      assert.equal(init.result.protocolVersion, '2025-06-18')
      assert.equal(init.result.capabilities.tools.listChanged, false)
      client.notify('notifications/initialized')

      const tools = await client.call('tools/list', {})
      const names = tools.result.tools.map((t) => t.name).sort()
      assert.deepEqual(names, [
        'ticket_board',
        'ticket_comment',
        'ticket_create',
        'ticket_get',
        'ticket_list',
        'ticket_move',
        'ticket_update',
      ])
      for (const tool of tools.result.tools) {
        assert.equal(tool.inputSchema.type, 'object')
        assert.ok(tool.description.length > 20, `${tool.name} needs a real description`)
      }

      const created = await client.call('tools/call', {
        name: 'ticket_create',
        arguments: {
          title: 'Sidecar dies on resize',
          project: 'waifufy-code',
          source: 'original words',
          dedupe_key: 'wc:resize-crash',
        },
      })
      assert.equal(created.result.isError, false)
      assert.match(created.result.content[0].text, /created WC-1/)

      const deduped = await client.call('tools/call', {
        name: 'ticket_create',
        arguments: { title: 'Sidecar dies on resize (again)', dedupe_key: 'wc:resize-crash' },
      })
      assert.match(deduped.result.content[0].text, /already tracked as WC-1/)

      const board = await client.call('tools/call', { name: 'ticket_board', arguments: {} })
      assert.match(board.result.content[0].text, /Inbox \(1\)/)
      assert.match(board.result.content[0].text, /WC-1/)

      const list = await client.call('tools/call', { name: 'ticket_list', arguments: { project: 'waifufy-code' } })
      assert.match(list.result.content[0].text, /Sidecar dies on resize/)
    } finally {
      await client.stop()
    }
  })

  it('reports tool failures as results, and unknown methods as protocol errors', async () => {
    const mcpDb = join(dir, 'mcp2.db')
    const client = McpClient.start(mcpDb)
    try {
      await client.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} })

      const blocked = await client.call('tools/call', {
        name: 'ticket_create',
        arguments: { title: 'Needs blocking' },
      })
      assert.match(blocked.result.content[0].text, /created WC-1/)
      const moved = await client.call('tools/call', {
        name: 'ticket_move',
        arguments: { id: 'WC-1', status: 'blocked' },
      })
      assert.equal(moved.result.isError, true)
      assert.match(moved.result.content[0].text, /needs a reason/)

      const unknown = await client.call('tools/call', { name: 'nope', arguments: {} })
      assert.equal(unknown.result.isError, true)
      assert.match(unknown.result.content[0].text, /unknown tool/)

      const bad = await client.call('does/not/exist', {})
      assert.equal(bad.error.code, -32601)
    } finally {
      await client.stop()
    }
  })
})
