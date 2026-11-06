#!/usr/bin/env node
// MCP stdio server exposing the board to any agent surface (Claude Code, the Waifufy
// sidecar later). Zero dependencies: newline-delimited JSON-RPC 2.0 on stdin/stdout,
// storage via src/store.mjs.
//
// Protocol rules that matter here: stdout carries protocol frames ONLY; every diagnostic
// goes to stderr, or a client will choke on the stray line.

import { STATUSES, TicketStore, TicketError } from '../src/store.mjs'
import { renderBoard, renderTicket, renderList } from '../src/render.mjs'

const SERVER = { name: 'waifufy-tickets', version: '0.1.0' }
const DEFAULT_PROTOCOL = '2025-06-18'

const STATUS_SCHEMA = { type: 'string', enum: STATUSES, description: `one of: ${STATUSES.join(', ')}` }

const TOOLS = [
  {
    name: 'ticket_board',
    description:
      'Show the kanban board (all columns with their tickets). Start here when asked what is on the board, what is blocked, or what to work on next.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'limit the board to one project label' },
        done_limit: { type: 'integer', description: 'how many recent Done cards to show (default 10)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ticket_create',
    description:
      'Create one ticket on the board. Use it after triaging raw input into atomic issues. Put the raw input in `source` VERBATIM (never a paraphrase) so the ticket can be re-triaged later, and pass a stable `dedupe_key` so re-running triage over the same input returns the existing ticket instead of creating a duplicate.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'imperative one-liner, e.g. "Fix save race in settings"' },
        body: { type: 'string', description: 'what is wrong, what done looks like, any evidence' },
        project: { type: 'string', description: 'project folder name this belongs to (e.g. waifufy-code)' },
        status: STATUS_SCHEMA,
        priority: { type: 'integer', description: '0 normal, 1 high, 2 urgent' },
        labels: { type: 'array', items: { type: 'string' } },
        source: { type: 'string', description: 'the verbatim raw input this ticket came from' },
        source_ref: { type: 'string', description: 'where it came from, e.g. "slack #dev 2026-11-05" or a file path' },
        dedupe_key: { type: 'string', description: 'stable key such as "<project>:<short-slug>"; reuse it when re-triaging' },
        created_by: { type: 'string', description: 'who reported it, default "user"' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'ticket_list',
    description:
      'List tickets, open work first (priority then oldest). Call this before creating tickets so you can dedupe against what already exists.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { ...STATUS_SCHEMA, description: 'filter to one status' },
        project: { type: 'string' },
        query: { type: 'string', description: 'substring match on title, body or id' },
        limit: { type: 'integer', description: 'default 200' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ticket_get',
    description: 'Full detail for one ticket by id (WC-12), including comments and optionally the event log.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ticket id such as WC-12' },
        events: { type: 'integer', description: 'include this many recent events (default 0)' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'ticket_move',
    description:
      'Move a ticket between columns. Moving to "blocked" requires a reason: say what it is waiting on. Use "doing" when you start work and "done" only when it is genuinely finished.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: STATUS_SCHEMA,
        reason: { type: 'string', description: 'required when moving to blocked' },
        comment: { type: 'string', description: 'optional note recorded with the move' },
        author: { type: 'string' },
      },
      required: ['id', 'status'],
      additionalProperties: false,
    },
  },
  {
    name: 'ticket_update',
    description: 'Edit a ticket’s title, body, project, priority or labels. Status is not editable here — use ticket_move.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        project: { type: 'string' },
        priority: { type: 'integer' },
        labels: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'ticket_comment',
    description: 'Append a comment to a ticket — progress notes, findings, or a handoff.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        body: { type: 'string' },
        author: { type: 'string' },
      },
      required: ['id', 'body'],
      additionalProperties: false,
    },
  },
]

function callTool(store, name, args = {}) {
  switch (name) {
    case 'ticket_board': {
      const board = store.board({ project: args.project, doneLimit: args.done_limit })
      return renderBoard(board, { maxPerColumn: 8 })
    }
    case 'ticket_create': {
      const { ticket, created } = store.create({
        title: args.title,
        body: args.body,
        project: args.project,
        status: args.status,
        priority: args.priority,
        labels: args.labels,
        source: args.source,
        sourceRef: args.source_ref,
        dedupeKey: args.dedupe_key,
        createdBy: args.created_by ?? 'agent',
      })
      return created
        ? `created ${ticket.id} [${ticket.status}] ${ticket.title}`
        : `already tracked as ${ticket.id} [${ticket.status}] ${ticket.title} (dedupe_key matched, nothing created)`
    }
    case 'ticket_list': {
      const rows = store.list({ status: args.status, project: args.project, query: args.query, limit: args.limit })
      return rows.length ? renderList(rows) : 'no tickets match'
    }
    case 'ticket_get':
      return renderTicket(store.get(args.id, { events: args.events ?? 0 }))
    case 'ticket_move': {
      const result = store.move(args.id, args.status, { reason: args.reason, comment: args.comment, author: args.author ?? 'agent' })
      return result.changed
        ? `${result.ticket.id}: ${result.from} -> ${result.to}`
        : `${result.ticket.id}: already in ${result.ticket.status}, nothing changed`
    }
    case 'ticket_update': {
      const ticket = store.update(args.id, {
        title: args.title,
        body: args.body,
        project: args.project,
        priority: args.priority,
        labels: args.labels,
      })
      return `updated ${ticket.id}: ${ticket.title}`
    }
    case 'ticket_comment': {
      const ticket = store.comment(args.id, args.body, args.author ?? 'agent')
      return `commented on ${ticket.id}`
    }
    default:
      throw new TicketError(`unknown tool: ${name}`, 'method_not_found')
  }
}

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
      reply(id, { tools: TOOLS })
      return
    case 'tools/call': {
      const name = params?.name
      try {
        const text = callTool(store, name, params?.arguments ?? {})
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
