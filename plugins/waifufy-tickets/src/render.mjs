// Rendering for the waifufy-tickets plugin: terminal board, ticket detail, list table,
// and a static self-contained HTML board (no server, no JS — just a file you can open).

import { STATUSES, STATUS_LABELS, STATUS_HINTS } from './store.mjs'

const AGES = [
  [60_000, 'now'],
  [3_600_000, (ms) => `${Math.floor(ms / 60_000)}m`],
  [86_400_000, (ms) => `${Math.floor(ms / 3_600_000)}h`],
  [Infinity, (ms) => `${Math.floor(ms / 86_400_000)}d`],
]

/** `2d`, `4h`, `12m` — how long ago something happened. */
export function formatAge(timestamp, from = Date.now()) {
  const ms = Math.max(0, from - timestamp)
  for (const [limit, fn] of AGES) {
    if (ms < limit) return typeof fn === 'string' ? fn : fn(ms)
  }
  return '?'
}

const PRIORITY_MARK = { 0: '', 1: '!', 2: '!!' }

function clip(value, width) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (s.length <= width) return s
  return width <= 1 ? s.slice(0, width) : `${s.slice(0, width - 1)}…`
}

function wrap(value, width) {
  const words = String(value ?? '').replace(/\s+/g, ' ').trim().split(' ')
  const lines = []
  let line = ''
  for (const word of words) {
    if (!line.length) {
      line = word
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`
    } else {
      lines.push(line)
      line = word
    }
    while (line.length > width) {
      lines.push(line.slice(0, width))
      line = line.slice(width)
    }
  }
  if (line.length) lines.push(line)
  return lines.length ? lines : ['']
}

function pad(value, width) {
  const s = String(value)
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length)
}

/** One card, as board lines: wrapped title then a muted meta line. */
function cardLines(ticket, width, nowTs) {
  const mark = PRIORITY_MARK[ticket.priority] ?? ''
  const title = `${ticket.id}${mark ? ` ${mark}` : ''} ${ticket.title}`
  const lines = wrap(title, width)
  const meta = [ticket.project, ticket.labels?.length ? ticket.labels.join('/') : null, formatAge(ticket.updatedAt, nowTs)]
    .filter(Boolean)
    .join(' · ')
  lines.push(`  ${clip(meta, Math.max(1, width - 2))}`)
  if (ticket.status === 'blocked' && ticket.blockedReason) {
    lines.push(`  ${clip(`waiting: ${ticket.blockedReason}`, Math.max(1, width - 2))}`)
  }
  return lines
}

/**
 * Side-by-side columns, like a real board. Fits the terminal when it can, falls back
 * to a readable width otherwise. `maxPerColumn` keeps a long Done column from pushing
 * the whole board off screen.
 */
export function renderBoard(board, { width, maxPerColumn = 8 } = {}) {
  const terminal = width ?? (process.stdout.isTTY ? process.stdout.columns : 0) ?? 0
  const colWidth = terminal >= 110 ? Math.min(34, Math.max(18, Math.floor((terminal - 8) / STATUSES.length))) : 30
  const nowTs = board.generatedAt ?? Date.now()
  const rendered = board.columns.map((column) => {
    const shown = column.tickets.slice(0, maxPerColumn)
    const lines = [`${STATUS_LABELS[column.status]} (${column.tickets.length})`, '─'.repeat(colWidth)]
    if (!shown.length) lines.push('·')
    for (const ticket of shown) lines.push(...cardLines(ticket, colWidth, nowTs))
    const hidden = column.tickets.length - shown.length
    if (hidden > 0) lines.push(`  +${hidden} more`)
    return lines
  })
  const height = Math.max(...rendered.map((lines) => lines.length))
  const rows = []
  for (let i = 0; i < height; i += 1) {
    rows.push(rendered.map((lines) => pad(lines[i] ?? '', colWidth)).join('  ').trimEnd())
  }
  const header = [
    `${board.total} ticket${board.total === 1 ? '' : 's'}`,
    board.project ? `project: ${board.project}` : null,
    board.projects.length ? `projects: ${board.projects.map((p) => `${p.project}(${p.count})`).join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('  ·  ')
  const hints = board.columns.map((c) => `${STATUS_LABELS[c.status]}: ${STATUS_HINTS[c.status]}`).join(' · ')
  return [header, '', ...rows, '', hints].join('\n')
}

/** Full detail for one ticket. */
export function renderTicket(ticket) {
  const out = [
    `${ticket.id}  ${ticket.title}`,
    `status: ${ticket.status}  priority: ${ticket.priority}${ticket.project ? `  project: ${ticket.project}` : ''}`,
  ]
  if (ticket.labels?.length) out.push(`labels: ${ticket.labels.join(', ')}`)
  out.push(`created: ${new Date(ticket.createdAt).toISOString()} (${formatAge(ticket.createdAt)} ago)`)
  if (ticket.startedAt) out.push(`started: ${new Date(ticket.startedAt).toISOString()}`)
  if (ticket.doneAt) out.push(`done:    ${new Date(ticket.doneAt).toISOString()}`)
  if (ticket.blockedReason) out.push(`blocked: ${ticket.blockedReason}`)
  if (ticket.sourceRef) out.push(`source:  ${ticket.sourceRef}`)
  if (ticket.body) out.push('', ticket.body)
  if (ticket.source) out.push('', '--- raw input (verbatim) ---', ticket.source)
  if (ticket.comments?.length) {
    out.push('', `--- comments (${ticket.comments.length}) ---`)
    for (const c of ticket.comments) out.push(`[${new Date(c.createdAt).toISOString()}] ${c.author}: ${c.body}`)
  }
  if (ticket.events?.length) {
    out.push('', `--- events (${ticket.events.length}) ---`)
    for (const e of ticket.events) {
      out.push(`${e.id}  ${new Date(e.createdAt).toISOString()}  ${e.kind}${e.payload ? ` ${JSON.stringify(e.payload)}` : ''}`)
    }
  }
  return out.join('\n')
}

/** Compact table for `list`. */
export function renderList(tickets) {
  if (!tickets.length) return 'no tickets'
  const idWidth = Math.max(4, ...tickets.map((t) => t.id.length))
  const statusWidth = Math.max(7, ...tickets.map((t) => t.status.length))
  const rows = tickets.map((t) => {
    const project = t.project ? ` ${t.project}` : ''
    return `${pad(t.id, idWidth)}  ${pad(t.status, statusWidth)}  p${t.priority}  ${formatAge(t.updatedAt)}  ${clip(t.title, 70)}${project}`
  })
  return [`${pad('ID', idWidth)}  ${pad('STATUS', statusWidth)}  P   AGE  TITLE`, ...rows].join('\n')
}

/** Standalone HTML snapshot. Open it in a browser; regenerate to refresh. */
export function renderBoardHtml(board, { title = 'Waifufy Tickets' } = {}) {
  const escape = (s) =>
    String(s ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
  const nowTs = board.generatedAt ?? Date.now()
  const columns = board.columns
    .map((column) => {
      const cards = column.tickets
        .map((ticket) => {
          const mark = PRIORITY_MARK[ticket.priority] ?? ''
          const meta = [ticket.project, ticket.labels?.length ? ticket.labels.join('/') : null, formatAge(ticket.updatedAt, nowTs)]
            .filter(Boolean)
            .map(escape)
            .join(' · ')
          const blocked =
            ticket.status === 'blocked' && ticket.blockedReason
              ? `<p class="blocked">waiting: ${escape(ticket.blockedReason)}</p>`
              : ''
          const body = ticket.body ? `<p class="body">${escape(clip(ticket.body, 240))}</p>` : ''
          return `<article class="card${ticket.status === 'done' ? ' done' : ''}">
  <h3><span class="id">${escape(ticket.id)}</span>${mark ? `<span class="pri">${escape(mark)}</span>` : ''} ${escape(ticket.title)}</h3>
  ${body}${blocked}
  <p class="meta">${meta}</p>
</article>`
        })
        .join('\n')
      return `<section class="col">
  <header><h2>${escape(STATUS_LABELS[column.status])}</h2><span class="count">${column.tickets.length}</span></header>
  <p class="hint">${escape(STATUS_HINTS[column.status])}</p>
  ${cards || '<p class="empty">—</p>'}
</section>`
    })
    .join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f6f7; --card:#fff; --line:#dcdce0; --ink:#18181b; --muted:#6b6b74; --accent:#7c5cff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161619; --card:#1f1f24; --line:#33333a; --ink:#f2f2f4; --muted:#9a9aa5; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:var(--bg); color:var(--ink);
         font:14px/1.45 ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { color:var(--muted); margin:0 0 20px; font-size:12px; }
  .board { display:flex; gap:12px; align-items:flex-start; overflow-x:auto; padding-bottom:8px; }
  .col { flex:1 0 220px; max-width:320px; background:transparent; }
  .col header { display:flex; align-items:baseline; justify-content:space-between; }
  .col h2 { font-size:12px; letter-spacing:.08em; text-transform:uppercase; margin:0; color:var(--muted); }
  .count { font-size:12px; color:var(--muted); }
  .hint { margin:2px 0 10px; font-size:11px; color:var(--muted); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 12px; margin-bottom:8px; }
  .card.done h3 { text-decoration:line-through; color:var(--muted); }
  .card h3 { font-size:13px; font-weight:600; margin:0 0 4px; }
  .id { color:var(--accent); font-variant-numeric:tabular-nums; margin-right:6px; }
  .pri { color:#c2410c; margin-right:6px; }
  .body { margin:4px 0; color:var(--muted); font-size:12px; }
  .blocked { margin:4px 0; font-size:12px; color:#b45309; }
  .meta { margin:4px 0 0; font-size:11px; color:var(--muted); }
  .empty { color:var(--muted); font-size:12px; }
</style>
</head>
<body>
<h1>${escape(title)}</h1>
<p class="sub">${board.total} ticket${board.total === 1 ? '' : 's'} · ${new Date(nowTs).toISOString()} · ${escape(board.dbPath)}</p>
<div class="board">
${columns}
</div>
</body>
</html>
`
}
