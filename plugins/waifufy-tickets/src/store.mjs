// Local ticket store for the waifufy-tickets plugin (v0).
//
// Design notes, borrowed from Hermes' kanban (the reference implementation):
//  - SQLite in WAL mode, one file, zero dependencies (`node:sqlite` is built in).
//  - Every state change appends to an append-only `ticket_events` table, so a UI or a
//    later automation layer can tail changes instead of polling for diffs.
//  - Raw input is stored verbatim in `source` and never paraphrased, so a ticket can be
//    re-triaged later without asking the human to paste it again.
//  - `dedupe_key` is a unique-partial index: the triage filter can re-run over the same
//    input and only the first run creates a ticket.
//
// v0 is deliberately just a board: no dispatcher, no workers, no verify gate. The main
// agent is the filter; humans move cards.

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Columns of the board, in board order. */
export const STATUSES = ['inbox', 'todo', 'doing', 'blocked', 'done']

/** Human labels for the columns. */
export const STATUS_LABELS = {
  inbox: 'Inbox',
  todo: 'Todo',
  doing: 'Doing',
  blocked: 'Blocked',
  done: 'Done',
}

/** What a column means, shown by `/tickets:board` and in the HTML export. */
export const STATUS_HINTS = {
  inbox: 'raw, not triaged yet',
  todo: 'ready to pick up',
  doing: 'in progress now',
  blocked: 'waiting on someone or something',
  done: 'closed',
}

export const EVENT_KINDS = ['created', 'moved', 'updated', 'commented', 'removed']

/** Thrown for anything the caller can fix; `code` is stable for scripting. */
export class TicketError extends Error {
  constructor(message, code = 'invalid') {
    super(message)
    this.name = 'TicketError'
    this.code = code
  }
}

/** `WC_TICKETS_DB` wins, else `<config>/waifufy-tickets/kanban.db`. Never the app's data dir. */
export function defaultDbPath() {
  if (process.env.WC_TICKETS_DB) return resolve(process.env.WC_TICKETS_DB)
  const base =
    process.env.APPDATA ||
    process.env.XDG_CONFIG_HOME ||
    join(homedir(), '.config')
  return join(base, 'waifufy-tickets', 'kanban.db')
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (
    id             TEXT PRIMARY KEY,
    seq            INTEGER NOT NULL,
    title          TEXT NOT NULL,
    body           TEXT,
    status         TEXT NOT NULL,
    priority       INTEGER NOT NULL DEFAULT 0,
    project        TEXT,
    labels         TEXT,
    source         TEXT,
    source_ref     TEXT,
    dedupe_key     TEXT,
    created_by     TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    started_at     INTEGER,
    done_at        INTEGER,
    blocked_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_dedupe ON tickets(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_tickets_project ON tickets(project);

CREATE TABLE IF NOT EXISTS ticket_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id  TEXT NOT NULL,
    author     TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_ticket ON ticket_comments(ticket_id, created_at);

CREATE TABLE IF NOT EXISTS ticket_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id  TEXT NOT NULL,
    kind       TEXT NOT NULL,
    payload    TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ticket ON ticket_events(ticket_id, id);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`

const now = () => Date.now()

/** Trimmed string or undefined; `max` guards against a runaway title or body. */
function text(value, max = 20000) {
  if (value === undefined || value === null) return undefined
  const s = String(value).replace(/\r\n/g, '\n').trim()
  return s.length ? s.slice(0, max) : undefined
}

function integer(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) throw new TicketError(`not a number: ${value}`)
  return Math.trunc(n)
}

function labels(value) {
  if (value === undefined || value === null) return undefined
  const list = Array.isArray(value) ? value : String(value).split(',')
  const out = [...new Set(list.map((l) => text(l, 40)).filter(Boolean))]
  return out.length ? JSON.stringify(out) : undefined
}

export function assertStatus(value) {
  const s = text(value, 20)?.toLowerCase()
  if (!s) throw new TicketError(`status is required (one of ${STATUSES.join(', ')})`)
  if (!STATUSES.includes(s)) throw new TicketError(`unknown status "${value}" (one of ${STATUSES.join(', ')})`)
  return s
}

function rowToTicket(row) {
  if (!row) return undefined
  return {
    id: row.id,
    seq: row.seq,
    title: row.title,
    body: row.body ?? undefined,
    status: row.status,
    priority: row.priority,
    project: row.project ?? undefined,
    labels: row.labels ? JSON.parse(row.labels) : [],
    source: row.source ?? undefined,
    sourceRef: row.source_ref ?? undefined,
    dedupeKey: row.dedupe_key ?? undefined,
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    doneAt: row.done_at ?? undefined,
    blockedReason: row.blocked_reason ?? undefined,
  }
}

/** Accepts `WC-12`, `wc-12`, or `12`. Returns the integer sequence. */
export function parseSeq(id) {
  const m = /^\s*(?:wc-?)?(\d+)\s*$/i.exec(String(id ?? ''))
  if (!m) throw new TicketError(`not a ticket id: ${id} (expected WC-12)`, 'not_found')
  return Number(m[1])
}

export class TicketStore {
  #db
  #path

  constructor(path = defaultDbPath()) {
    this.#path = path === ':memory:' ? path : resolve(path)
    if (path !== ':memory:') mkdirSync(dirname(this.#path), { recursive: true })
    this.#db = new DatabaseSync(this.#path)
    this.#db.exec('PRAGMA busy_timeout = 5000')
    if (path !== ':memory:') this.#db.exec('PRAGMA journal_mode = WAL')
    this.#db.exec(SCHEMA)
  }

  get path() {
    return this.#path
  }

  close() {
    this.#db.close()
  }

  /** BEGIN IMMEDIATE so two surfaces (CLI, MCP, a future UI) never interleave a write. */
  #tx(fn) {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.#db.exec('COMMIT')
      return out
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK')
      } catch {
        // the transaction was already rolled back by SQLite
      }
      throw error
    }
  }

  #event(ticketId, kind, payload) {
    this.#db
      .prepare('INSERT INTO ticket_events (ticket_id, kind, payload, created_at) VALUES (?, ?, ?, ?)')
      .run(ticketId, kind, payload ? JSON.stringify(payload) : null, now())
  }

  #nextSeq() {
    const row = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get('next_seq')
    const seq = row ? Number(row.value) : 1
    this.#db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('next_seq', String(seq + 1))
    return seq
  }

  /** Resolve an id to a row, or throw `not_found`. */
  #row(id) {
    const seq = parseSeq(id)
    const row = this.#db.prepare('SELECT * FROM tickets WHERE seq = ?').get(seq)
    if (!row) throw new TicketError(`no ticket WC-${seq}`, 'not_found')
    return row
  }

  /**
   * Create a ticket. Returns `{ticket, created}`; `created: false` means an existing
   * ticket already carried this `dedupeKey` (the re-triage case).
   */
  create(input = {}) {
    const title = text(input.title, 300)
    if (!title) throw new TicketError('title is required')
    const status = assertStatus(input.status ?? 'inbox')
    const priority = integer(input.priority, 0)
    const dedupeKey = text(input.dedupeKey ?? input.dedupe_key, 200)
    if (dedupeKey) {
      const existing = this.#db.prepare('SELECT * FROM tickets WHERE dedupe_key = ?').get(dedupeKey)
      if (existing) return { ticket: rowToTicket(existing), created: false }
    }
    return this.#tx(() => {
      const seq = this.#nextSeq()
      const id = `WC-${seq}`
      const ts = now()
      this.#db
        .prepare(
          `INSERT INTO tickets (id, seq, title, body, status, priority, project, labels, source,
                                source_ref, dedupe_key, created_by, created_at, updated_at,
                                started_at, done_at, blocked_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          seq,
          title,
          text(input.body) ?? null,
          status,
          priority,
          text(input.project, 200) ?? null,
          labels(input.labels) ?? null,
          text(input.source) ?? null,
          text(input.sourceRef ?? input.source_ref, 300) ?? null,
          dedupeKey ?? null,
          text(input.createdBy ?? input.created_by, 80) ?? null,
          ts,
          ts,
          status === 'doing' ? ts : null,
          status === 'done' ? ts : null,
          status === 'blocked' ? (text(input.blockedReason ?? input.blocked_reason, 500) ?? null) : null,
        )
      this.#event(id, 'created', { status })
      return { ticket: rowToTicket(this.#db.prepare('SELECT * FROM tickets WHERE id = ?').get(id)), created: true }
    })
  }

  /** One ticket with its comments and recent events. */
  get(id, { comments = true, events = 0 } = {}) {
    const ticket = rowToTicket(this.#row(id))
    return {
      ...ticket,
      comments: comments
        ? this.#db
            .prepare('SELECT id, author, body, created_at FROM ticket_comments WHERE ticket_id = ? ORDER BY id')
            .all(ticket.id)
            .map((c) => ({ id: c.id, author: c.author, body: c.body, createdAt: c.created_at }))
        : undefined,
      events:
        events > 0
          ? this.#db
              .prepare('SELECT id, kind, payload, created_at FROM ticket_events WHERE ticket_id = ? ORDER BY id DESC LIMIT ?')
              .all(ticket.id, events)
              .map((e) => ({ id: e.id, kind: e.kind, payload: e.payload ? JSON.parse(e.payload) : undefined, createdAt: e.created_at }))
              .reverse()
          : undefined,
    }
  }

  /** Tickets matching a filter. Open work is ordered priority DESC then oldest first. */
  list({ status, project, query, limit = 200 } = {}) {
    const where = []
    const args = []
    const statuses = status === undefined ? undefined : (Array.isArray(status) ? status : [status]).map(assertStatus)
    if (statuses?.length) {
      where.push(`status IN (${statuses.map(() => '?').join(', ')})`)
      args.push(...statuses)
    }
    if (project) {
      where.push('project = ?')
      args.push(text(project, 200))
    }
    if (query) {
      where.push('(title LIKE ? OR body LIKE ? OR id LIKE ?)')
      const like = `%${text(query, 200)}%`
      args.push(like, like, like)
    }
    const sql = `SELECT * FROM tickets ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY CASE WHEN status = 'done' THEN 1 ELSE 0 END,
                          priority DESC, created_at ASC, seq ASC
                 LIMIT ?`
    return this.#db
      .prepare(sql)
      .all(...args, integer(limit, 200))
      .map(rowToTicket)
  }

  /** Patch text fields. Status changes go through `move` so the board stays consistent. */
  update(id, patch = {}) {
    const row = this.#row(id)
    const sets = []
    const args = []
    const changed = []
    const put = (column, value) => {
      if (value === undefined) return
      sets.push(`${column} = ?`)
      args.push(value)
      changed.push(column)
    }
    if (patch.title !== undefined) {
      const title = text(patch.title, 300)
      if (!title) throw new TicketError('title cannot be empty')
      put('title', title)
    }
    if (patch.body !== undefined) put('body', text(patch.body) ?? null)
    if (patch.project !== undefined) put('project', text(patch.project, 200) ?? null)
    if (patch.priority !== undefined) put('priority', integer(patch.priority, 0))
    if (patch.labels !== undefined) put('labels', labels(patch.labels) ?? null)
    if (!changed.length) throw new TicketError('nothing to update (title, body, project, priority, labels)')
    return this.#tx(() => {
      args.push(now(), row.id)
      this.#db.prepare(`UPDATE tickets SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args)
      this.#event(row.id, 'updated', { fields: changed })
      return rowToTicket(this.#db.prepare('SELECT * FROM tickets WHERE id = ?').get(row.id))
    })
  }

  /**
   * Move a ticket between columns. `blocked` requires a reason; leaving `blocked` clears it.
   * Sets `started_at` on the first `doing` and `done_at` on `done`.
   */
  move(id, status, { reason, comment, author = 'user' } = {}) {
    const row = this.#row(id)
    const to = assertStatus(status)
    if (row.status === to) return { ticket: rowToTicket(row), changed: false }
    const blockedReason = text(reason, 500)
    if (to === 'blocked' && !blockedReason) {
      throw new TicketError('moving to blocked needs a reason (what is it waiting on?)')
    }
    return this.#tx(() => {
      const ts = now()
      this.#db
        .prepare(
          `UPDATE tickets
              SET status = ?, updated_at = ?, blocked_reason = ?,
                  started_at = COALESCE(started_at, CASE WHEN ? = 'doing' THEN ? END),
                  done_at = CASE WHEN ? = 'done' THEN ? ELSE done_at END
            WHERE id = ?`,
        )
        .run(to, ts, to === 'blocked' ? blockedReason : null, to, ts, to, ts, row.id)
      this.#event(row.id, 'moved', { from: row.status, to, reason: blockedReason })
      if (comment) this.#comment(row.id, comment, author)
      return {
        ticket: rowToTicket(this.#db.prepare('SELECT * FROM tickets WHERE id = ?').get(row.id)),
        changed: true,
        from: row.status,
        to,
      }
    })
  }

  #comment(ticketId, body, author) {
    const value = text(body)
    if (!value) throw new TicketError('comment body is required')
    this.#db
      .prepare('INSERT INTO ticket_comments (ticket_id, author, body, created_at) VALUES (?, ?, ?, ?)')
      .run(ticketId, text(author, 80) ?? 'user', value, now())
    this.#event(ticketId, 'commented', null)
  }

  comment(id, body, author = 'user') {
    const row = this.#row(id)
    this.#comment(row.id, body, author)
    this.#db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(now(), row.id)
    return rowToTicket(this.#db.prepare('SELECT * FROM tickets WHERE id = ?').get(row.id))
  }

  /** Permanently delete a ticket and its comments. Events stay as the audit trail. */
  remove(id) {
    const row = this.#row(id)
    return this.#tx(() => {
      this.#db.prepare('DELETE FROM ticket_comments WHERE ticket_id = ?').run(row.id)
      this.#event(row.id, 'removed', { title: row.title })
      this.#db.prepare('DELETE FROM tickets WHERE id = ?').run(row.id)
      return { id: row.id, removed: true }
    })
  }

  events(id, limit = 50) {
    const row = this.#row(id)
    return this.#db
      .prepare('SELECT id, kind, payload, created_at FROM ticket_events WHERE ticket_id = ? ORDER BY id DESC LIMIT ?')
      .all(row.id, integer(limit, 50))
      .map((e) => ({ id: e.id, kind: e.kind, payload: e.payload ? JSON.parse(e.payload) : undefined, createdAt: e.created_at }))
      .reverse()
  }

  /** Event cursor: everything after `sinceId`, for a tailing UI. */
  eventsSince(sinceId = 0, limit = 200) {
    return this.#db
      .prepare('SELECT id, ticket_id, kind, payload, created_at FROM ticket_events WHERE id > ? ORDER BY id LIMIT ?')
      .all(integer(sinceId, 0), integer(limit, 200))
      .map((e) => ({
        id: e.id,
        ticketId: e.ticket_id,
        kind: e.kind,
        payload: e.payload ? JSON.parse(e.payload) : undefined,
        createdAt: e.created_at,
      }))
  }

  /** The whole board, grouped by column, plus counts and the project list for filters. */
  board({ project, doneLimit = 10 } = {}) {
    const counts = {}
    for (const s of STATUSES) counts[s] = 0
    // Counts describe what the board is showing, so they follow the same filter as the columns: a header
    // saying "Todo 5" over a filtered column of two would be lying. `projects` stays global — it is the filter list.
    const counted = project
      ? this.#db.prepare('SELECT status, COUNT(*) AS n FROM tickets WHERE project = ? GROUP BY status').all(project)
      : this.#db.prepare('SELECT status, COUNT(*) AS n FROM tickets GROUP BY status').all()
    for (const row of counted) {
      if (STATUSES.includes(row.status)) counts[row.status] = row.n
    }
    const columns = STATUSES.map((status) => {
      const rows = this.list({ status, project, limit: status === 'done' ? integer(doneLimit, 10) : 500 })
      if (status === 'done') rows.sort((a, b) => (b.doneAt ?? b.updatedAt) - (a.doneAt ?? a.updatedAt))
      return { status, label: STATUS_LABELS[status], hint: STATUS_HINTS[status], tickets: rows }
    })
    const projects = this.#db
      .prepare('SELECT project, COUNT(*) AS n FROM tickets WHERE project IS NOT NULL GROUP BY project ORDER BY n DESC, project')
      .all()
      .map((r) => ({ project: r.project, count: r.n }))
    return {
      generatedAt: now(),
      dbPath: this.#path,
      project: project ?? null,
      columns,
      counts,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      projects,
    }
  }
}

/** Convenience for scripts: open, use, close. */
export function withStore(fn, path) {
  const store = new TicketStore(path)
  try {
    return fn(store)
  } finally {
    store.close()
  }
}
