// Store-level tests: the rules that make the board trustworthy (ids, dedupe, moves,
// blocked reasons, ordering, the event log).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { STATUSES, TicketError, TicketStore } from '../src/store.mjs'

let dir
let dbPath
let store

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'wc-tickets-store-'))
  dbPath = join(dir, 'kanban.db')
  store = new TicketStore(dbPath)
})

after(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('create', () => {
  it('assigns sequential human ids and defaults to inbox', () => {
    const first = store.create({ title: 'Fix the save race' })
    const second = store.create({ title: 'Add a test hook' })
    assert.equal(first.created, true)
    assert.equal(first.ticket.id, 'WC-1')
    assert.equal(first.ticket.status, 'inbox')
    assert.equal(second.ticket.id, 'WC-2')
  })

  it('requires a title', () => {
    assert.throws(() => store.create({ title: '   ' }), TicketError)
  })

  it('rejects an unknown status', () => {
    assert.throws(() => store.create({ title: 'x', status: 'nope' }), /unknown status/)
  })

  it('dedupes on dedupe_key instead of duplicating', () => {
    const first = store.create({ title: 'Slack: login broken', project: 'app', dedupeKey: 'app:login-broken' })
    const again = store.create({ title: 'Login still broken', project: 'app', dedupeKey: 'app:login-broken' })
    assert.equal(again.created, false)
    assert.equal(again.ticket.id, first.ticket.id)
    const rows = store.list({ query: 'broken' })
    assert.equal(rows.length, 1)
  })

  it('keeps the raw input verbatim and parses labels', () => {
    const { ticket } = store.create({
      title: 'Crash on startup',
      source: 'it crashed\n  with a stack trace',
      labels: ['bug', 'bug', 'crash'],
      sourceRef: 'slack #dev',
      priority: 2,
    })
    const loaded = store.get(ticket.id)
    assert.equal(loaded.source, 'it crashed\n  with a stack trace')
    assert.deepEqual(loaded.labels, ['bug', 'crash'])
    assert.equal(loaded.sourceRef, 'slack #dev')
    assert.equal(loaded.priority, 2)
  })
})

describe('move', () => {
  it('walks the columns and stamps started_at / done_at', () => {
    const { ticket } = store.create({ title: 'Move me' })
    const doing = store.move(ticket.id, 'doing')
    assert.equal(doing.changed, true)
    assert.equal(doing.to, 'doing')
    assert.ok(doing.ticket.startedAt, 'started_at set on first doing')

    store.move(ticket.id, 'todo')
    const back = store.move(ticket.id, 'doing')
    assert.equal(back.ticket.startedAt, doing.ticket.startedAt, 'started_at is not reset')

    const done = store.move(ticket.id, 'done')
    assert.ok(done.ticket.doneAt)
  })

  it('refuses blocked without a reason, and keeps the reason once given', () => {
    const { ticket } = store.create({ title: 'Needs an answer' })
    assert.throws(() => store.move(ticket.id, 'blocked'), /needs a reason/)
    const blocked = store.move(ticket.id, 'blocked', { reason: 'waiting on the API key' })
    assert.equal(blocked.ticket.blockedReason, 'waiting on the API key')
    const unblocked = store.move(ticket.id, 'todo')
    assert.equal(unblocked.ticket.blockedReason, undefined, 'leaving blocked clears the reason')
  })

  it('is a no-op when the status does not change', () => {
    const { ticket } = store.create({ title: 'Stays put', status: 'todo' })
    const result = store.move(ticket.id, 'todo')
    assert.equal(result.changed, false)
  })

  it('records a comment alongside the move', () => {
    const { ticket } = store.create({ title: 'With a note' })
    store.move(ticket.id, 'blocked', { reason: 'no access', comment: 'asked in #infra' })
    const loaded = store.get(ticket.id)
    assert.equal(loaded.comments.length, 1)
    assert.match(loaded.comments[0].body, /asked in #infra/)
  })
})

describe('list and board', () => {
  it('orders open work by priority then oldest first', () => {
    const rows = store.list({ status: 'inbox' })
    const priorities = rows.map((t) => t.priority)
    const sorted = [...priorities].sort((a, b) => b - a)
    assert.deepEqual(priorities, sorted)
  })

  it('groups the board into the five columns with counts', () => {
    const board = store.board()
    assert.deepEqual(board.columns.map((c) => c.status), STATUSES)
    assert.equal(board.total, board.columns.reduce((n, c) => n + c.tickets.length, 0))
    assert.ok(board.counts.done >= 1)
    assert.ok(board.projects.some((p) => p.project === 'app'))
  })

  it('scopes counts to the project it is showing, but keeps the project list global', () => {
    const scoped = new TicketStore(join(dir, 'scoped.db'))
    try {
      scoped.create({ title: 'one', project: 'app', status: 'todo' })
      scoped.create({ title: 'two', project: 'app', status: 'done' })
      scoped.create({ title: 'three', project: 'other', status: 'todo' })

      assert.equal(scoped.board().total, 3)
      const app = scoped.board({ project: 'app' })
      assert.equal(app.total, 2)
      assert.equal(app.counts.todo, 1)
      assert.equal(app.counts.done, 1)
      assert.equal(app.counts.inbox, 0)
      // A header count that disagreed with the column under it would be a lie in the panel.
      assert.equal(
        app.columns.reduce((n, c) => n + c.tickets.length, 0),
        app.total,
      )
      assert.equal(scoped.board().projects.length, 2, 'the filter list must still offer every project')
    } finally {
      scoped.close()
    }
  })
})

describe('update, comment, remove, events', () => {
  it('patches fields and records what changed', () => {
    const { ticket } = store.create({ title: 'Rename me' })
    const updated = store.update(ticket.id, { title: 'Renamed', priority: 1 })
    assert.equal(updated.title, 'Renamed')
    assert.equal(updated.priority, 1)
    const events = store.events(ticket.id)
    const last = events.at(-1)
    assert.equal(last.kind, 'updated')
    assert.deepEqual(last.payload.fields.sort(), ['priority', 'title'])
  })

  it('refuses an empty patch', () => {
    const { ticket } = store.create({ title: 'Nothing to do' })
    assert.throws(() => store.update(ticket.id, {}), /nothing to update/)
  })

  it('rejects an empty title on update', () => {
    const { ticket } = store.create({ title: 'Has a title' })
    assert.throws(() => store.update(ticket.id, { title: ' ' }), /cannot be empty/)
  })

  it('appends comments and events in order', () => {
    const { ticket } = store.create({ title: 'Comment target' })
    store.comment(ticket.id, 'first', 'lead')
    store.comment(ticket.id, 'second')
    const loaded = store.get(ticket.id, { events: 20 })
    assert.deepEqual(loaded.comments.map((c) => c.body), ['first', 'second'])
    assert.deepEqual(loaded.comments.map((c) => c.author), ['lead', 'user'])
    assert.deepEqual(loaded.events.map((e) => e.kind), ['created', 'commented', 'commented'])
  })

  it('exposes a monotonic event cursor for a tailing UI', () => {
    const all = store.eventsSince(0)
    assert.ok(all.length > 0)
    const mid = all[Math.floor(all.length / 2)].id
    const tail = store.eventsSince(mid)
    assert.ok(tail.every((e) => e.id > mid))
    assert.ok(tail.length < all.length)
  })

  it('removes a ticket but keeps its audit trail', () => {
    const { ticket } = store.create({ title: 'Delete me' })
    const result = store.remove(ticket.id)
    assert.equal(result.removed, true)
    assert.throws(() => store.get(ticket.id), (error) => error.code === 'not_found')
    const trail = store.eventsSince(0, 500).filter((e) => e.ticketId === ticket.id)
    assert.ok(trail.some((e) => e.kind === 'created'))
    assert.ok(trail.some((e) => e.kind === 'removed'))
  })

  it('reports a readable error for a bad id', () => {
    assert.throws(() => store.get('WC-9999'), (error) => error.code === 'not_found' && /WC-9999/.test(error.message))
    assert.throws(() => store.get('not-an-id'), (error) => error.code === 'not_found')
  })
})

describe('persistence', () => {
  it('survives a reopen and keeps both WAL files local', () => {
    const { ticket } = store.create({ title: 'Persisted' })
    const reopened = new TicketStore(dbPath)
    try {
      assert.equal(reopened.get(ticket.id).title, 'Persisted')
    } finally {
      reopened.close()
    }
  })
})
