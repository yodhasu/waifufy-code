// What REM should do at a given moment, as pure data so it can be tested without the app.
// A "night" is named by the date of its evening; times after midnight belong to the previous evening.

const pad = (n) => String(n).padStart(2, '0')
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

function at(base, hhmm, nextDay) {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date(base)
  d.setHours(h, m, 0, 0)
  if (nextDay) d.setDate(d.getDate() + 1)
  return d
}

/**
 * @param now      Date
 * @param state    { started, wrapped, stopped: night | null, forwarded: ticket ids }
 * @param cfg      { start, wrapUp, stop } as HH:MM
 * @param inbox    open REM tickets in the inbox, oldest first
 * @returns        actions in order, each { t, night, state: the fields to save after it succeeds, ticket? }
 */
export function plan(now, state, cfg, inbox) {
  const evening = new Date(now)
  if (now.getHours() < 12) evening.setDate(evening.getDate() - 1)
  const night = day(evening)
  const start = at(evening, cfg.start ?? '21:00', false)
  const wrap = at(evening, cfg.wrapUp ?? '06:00', true)
  const stop = at(evening, cfg.stop ?? '06:30', true)
  const out = []

  if (now >= start && now < wrap && state.started !== night) {
    // Tickets already waiting are in the brief's list; only later ones are forwarded one by one.
    return [{ t: 'start', night, state: { started: night, forwarded: inbox.map((t) => t.id) } }]
  }
  if (state.started !== night) return out

  if (now < wrap) {
    const forwarded = [...(state.forwarded ?? [])]
    for (const ticket of inbox) {
      if (forwarded.includes(ticket.id)) continue
      forwarded.push(ticket.id)
      out.push({ t: 'forward', night, ticket, state: { forwarded: [...forwarded] } })
    }
  } else if (now < stop) {
    if (state.wrapped !== night) out.push({ t: 'wrap', night, state: { wrapped: night } })
  } else if (state.stopped !== night) {
    if (state.wrapped !== night) out.push({ t: 'wrap', night, state: { wrapped: night } })
    out.push({ t: 'stop', night, state: { stopped: night } })
  }
  return out
}
