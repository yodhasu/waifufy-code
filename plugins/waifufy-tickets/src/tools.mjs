// The ticket board's seven tools, shared by the MCP server (bin/tickets-mcp.mjs) and the Waifufy mod
// (backend.mjs, mod.json), so Claude Code and the app can never disagree about them.

import { STATUSES, TicketError } from './store.mjs'
import { renderBoard, renderTicket, renderList } from './render.mjs'

const STATUS_SCHEMA = { type: 'string', enum: STATUSES, description: `one of: ${STATUSES.join(', ')}` }

/** The seven tools, in mod.json's shape (`input` is the JSON Schema; the MCP server calls it `inputSchema`). */
export const TOOLS = [
  {
    name: 'ticket_board',
    description:
      'Show the kanban board (all columns with their tickets). Start here when asked what is on the board, what is blocked, or what to work on next.',
    input: {
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
    input: {
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
    input: {
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
    input: {
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
    input: {
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
    input: {
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
    input: {
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

/** Runs one tool against `store` and returns its text; throws TicketError for anything the caller can fix. */
export function runTool(store, name, args = {}) {
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
