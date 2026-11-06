#!/usr/bin/env node
// Human and script surface for the waifufy-tickets board. The agent surface is the MCP
// server (bin/tickets-mcp.mjs); both go through src/store.mjs so they cannot drift.
//
//   node bin/tickets.mjs board [--project P] [--html out.html] [--json]
//   node bin/tickets.mjs add "<title>" [--body-file f] [--source-file f] [--project P] ...
//   node bin/tickets.mjs list|show|move|edit|comment|rm|events|path ...

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { STATUSES, TicketStore, TicketError, defaultDbPath } from '../src/store.mjs'
import { renderBoard, renderBoardHtml, renderList, renderTicket } from '../src/render.mjs'

const USAGE = `waifufy-tickets — local kanban (v0)

usage: tickets <command> [options]

  board                     show the board            [--project P] [--max N] [--html FILE] [--json]
  add "<title>"             create a ticket           [--body|--body-file] [--source|--source-file]
                                                      [--project P] [--priority N] [--status S]
                                                      [--labels a,b] [--dedupe KEY] [--source-ref R] [--by NAME]
  list                      list tickets              [--status S] [--project P] [--query Q] [--limit N] [--json]
  show <id>                 one ticket in full        [--events N] [--json]
  move <id> <status>        move between columns      [--reason R] [--comment C] [--by NAME]
  edit <id>                 patch fields              [--title|--body|--project|--priority|--labels]
  comment <id> "<text>"     append a comment          [--by NAME]
  rm <id>                   delete a ticket
  events                    tail the event log        [--since N] [--limit N] [--json]
  path                      print the database path

statuses: ${STATUSES.join(' | ')}
env: WC_TICKETS_DB overrides the database path (default ${defaultDbPath()})
`

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true
    } else {
      flags[key] = next
      i += 1
    }
  }
  return { positional, flags }
}

/** `--body-file x` reads a file so callers never have to quote a long body. */
function fromFile(value) {
  return value === undefined || value === true ? undefined : readFileSync(resolve(String(value)), 'utf8')
}

function emit(payload, flags, render) {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return
  }
  process.stdout.write(`${render(payload)}\n`)
}

function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(USAGE)
    return 0
  }
  const { positional, flags } = parseArgs(rest)
  if (command === 'path') {
    process.stdout.write(`${defaultDbPath()}\n`)
    return 0
  }
  const store = new TicketStore()
  try {
    switch (command) {
      case 'board': {
        const board = store.board({ project: flags.project, doneLimit: flags.max })
        if (flags.html) {
          const file = resolve(String(flags.html === true ? 'board.html' : flags.html))
          writeFileSync(file, renderBoardHtml(board), 'utf8')
          process.stdout.write(`wrote ${file}\n`)
          if (flags.json) process.stdout.write(`${JSON.stringify(board, null, 2)}\n`)
          else process.stdout.write(`${renderBoard(board)}\n`)
          return 0
        }
        emit(board, flags, (b) => renderBoard(b, { maxPerColumn: flags.all ? 1000 : 8 }))
        return 0
      }
      case 'add': {
        const title = positional.join(' ').trim() || flags.title
        if (!title) throw new TicketError('add needs a title')
        const { ticket, created } = store.create({
          title,
          body: flags.body ?? fromFile(flags['body-file']),
          project: flags.project,
          status: flags.status,
          priority: flags.priority,
          labels: flags.labels,
          source: flags.source ?? fromFile(flags['source-file']),
          sourceRef: flags['source-ref'],
          dedupeKey: flags.dedupe,
          createdBy: flags.by,
        })
        emit({ ticket, created }, flags, (r) => `${r.created ? 'created' : 'already tracked'} ${r.ticket.id}: ${r.ticket.title}`)
        return 0
      }
      case 'list':
        emit(
          store.list({ status: flags.status, project: flags.project, query: flags.query, limit: flags.limit }),
          flags,
          renderList,
        )
        return 0
      case 'show': {
        const ticket = store.get(positional[0], { events: Number(flags.events ?? 0) })
        emit(ticket, flags, renderTicket)
        return 0
      }
      case 'move': {
        const result = store.move(positional[0], positional[1], {
          reason: flags.reason,
          comment: flags.comment,
          author: flags.by,
        })
        emit(result, flags, (r) =>
          r.changed ? `${r.ticket.id}: ${r.from} -> ${r.to}` : `${r.ticket.id}: already ${r.ticket.status}`,
        )
        return 0
      }
      case 'edit': {
        const ticket = store.update(positional[0], {
          title: flags.title,
          body: flags.body ?? fromFile(flags['body-file']),
          project: flags.project,
          priority: flags.priority,
          labels: flags.labels,
        })
        emit(ticket, flags, (t) => `updated ${t.id}: ${t.title}`)
        return 0
      }
      case 'comment': {
        const body = positional.slice(1).join(' ').trim() || flags.body
        const ticket = store.comment(positional[0], body, flags.by)
        emit(ticket, flags, (t) => `commented on ${t.id}`)
        return 0
      }
      case 'rm': {
        const result = store.remove(positional[0])
        emit(result, flags, (r) => `removed ${r.id}`)
        return 0
      }
      case 'events':
        emit(store.eventsSince(flags.since ?? 0, flags.limit ?? 200), flags, (rows) =>
          rows.length
            ? rows.map((e) => `${e.id}  ${new Date(e.createdAt).toISOString()}  ${e.ticketId}  ${e.kind}`).join('\n')
            : 'no events',
        )
        return 0
      default:
        process.stderr.write(`unknown command: ${command}\n\n${USAGE}`)
        return 2
    }
  } finally {
    store.close()
  }
}

try {
  process.exitCode = main()
} catch (error) {
  if (error instanceof TicketError) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = error.code === 'not_found' ? 3 : 1
  } else {
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exitCode = 1
  }
}
