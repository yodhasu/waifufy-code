#!/usr/bin/env node
// MCP stdio server exposing the board to any agent surface (Claude Code, the Waifufy
// sidecar later). Zero dependencies: newline-delimited JSON-RPC 2.0 on stdin/stdout,
// storage via src/store.mjs.
//
// Protocol rules that matter here: stdout carries protocol frames ONLY; every diagnostic
// goes to stderr, or a client will choke on the stray line.

import { TicketStore, TicketError } from '../src/store.mjs'
import { TOOLS, runTool } from '../src/tools.mjs'

const SERVER = { name: 'waifufy-tickets', version: '0.1.0' }
const DEFAULT_PROTOCOL = '2025-06-18'

/** One JSON-RPC response frame. */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })
}

function handle(store, message) {
  const { id, method, params } = message
  const isNotification = id === undefined || id === null
  switch (method) {
    case 'initialize': {
      reply(id, {
        protocolVersion: params?.protocolVersion ?? DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions:
          'Local kanban board. The board is the source of truth for what is queued, in progress, or blocked; read it with ticket_board before claiming work, and record state changes with ticket_move rather than only in chat.',
      })
      return
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/roots/list_changed':
      return
    case 'ping':
      if (!isNotification) reply(id, {})
      return
    case 'tools/list':
      reply(id, { tools: TOOLS.map(({ input, ...t }) => ({ ...t, inputSchema: input })) })
      return
    case 'tools/call': {
      const name = params?.name
      try {
        const text = runTool(store, name, params?.arguments ?? {})
        reply(id, { content: [{ type: 'text', text }], isError: false })
      } catch (error) {
        // Tool failures are results, not protocol failures: the model should see the
        // message and be able to retry with better arguments.
        const text = error instanceof TicketError ? error.message : `internal error: ${error?.message ?? error}`
        reply(id, { content: [{ type: 'text', text }], isError: true })
      }
      return
    }
    default:
      if (!isNotification) replyError(id, -32601, `method not found: ${method}`)
  }
}

function main() {
  const store = new TicketStore()
  process.stderr.write(`waifufy-tickets mcp ready (db: ${store.path})\n`)
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        process.stderr.write(`dropped unparseable frame: ${line.slice(0, 200)}\n`)
        continue
      }
      try {
        handle(store, message)
      } catch (error) {
        process.stderr.write(`handler failed: ${error?.stack ?? error}\n`)
        if (message?.id !== undefined && message?.id !== null) {
          replyError(message.id, -32603, `internal error: ${error?.message ?? error}`)
        }
      }
    }
  })
  const shutdown = () => {
    try {
      store.close()
    } catch {
      // already closed
    }
    process.exit(0)
  }
  process.stdin.on('end', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main()
