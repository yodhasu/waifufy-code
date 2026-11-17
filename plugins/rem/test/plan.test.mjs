import assert from 'node:assert/strict'
import { test } from 'node:test'
import { plan } from '../plan.mjs'

const cfg = { start: '21:00', wrapUp: '06:00', stop: '06:30' }
const t = (s) => new Date(s)
const empty = { started: null, wrapped: null, stopped: null, forwarded: [] }
const A = { id: 'WC-1', title: 'a' }
const B = { id: 'WC-2', title: 'b' }

test('nothing before the start time', () => {
  assert.deepEqual(plan(t('2026-11-08T20:59:00'), empty, cfg, [A]), [])
})

test('starts once at 21:00 and counts waiting tickets as briefed', () => {
  const [a, ...rest] = plan(t('2026-11-08T21:00:30'), empty, cfg, [A])
  assert.equal(rest.length, 0)
  assert.equal(a.t, 'start')
  assert.deepEqual(a.state, { started: '2026-11-08', forwarded: ['WC-1'] })
})

test('a late start after midnight belongs to the previous evening', () => {
  assert.equal(plan(t('2026-11-09T02:00:00'), empty, cfg, [])[0].state.started, '2026-11-08')
})

test('forwards only tickets not seen yet', () => {
  const s = { ...empty, started: '2026-11-08', forwarded: ['WC-1'] }
  const out = plan(t('2026-11-08T23:00:00'), s, cfg, [A, B])
  assert.deepEqual(out.map((a) => [a.t, a.ticket.id]), [['forward', 'WC-2']])
})

test('wrap up at 06:00 once, then stop at 06:30 once', () => {
  const s = { ...empty, started: '2026-11-08' }
  assert.deepEqual(plan(t('2026-11-09T06:00:00'), s, cfg, [B]).map((a) => a.t), ['wrap'])
  const wrapped = { ...s, wrapped: '2026-11-08' }
  assert.deepEqual(plan(t('2026-11-09T06:10:00'), wrapped, cfg, []), [])
  assert.deepEqual(plan(t('2026-11-09T06:31:00'), wrapped, cfg, []).map((a) => a.t), ['stop'])
  assert.deepEqual(plan(t('2026-11-09T06:40:00'), { ...wrapped, stopped: '2026-11-08' }, cfg, []), [])
})

test('no session started tonight: no wrap or stop into someone else\'s chat', () => {
  assert.deepEqual(plan(t('2026-11-09T06:31:00'), { ...empty, started: '2026-11-07' }, cfg, []), [])
})

test('daytime does nothing', () => {
  assert.deepEqual(plan(t('2026-11-09T14:00:00'), { ...empty, started: '2026-11-08', wrapped: '2026-11-08', stopped: '2026-11-08' }, cfg, [A]), [])
})
