// The ticket board panel: today's chat card (app/src/chat/tickets.ts) against the mod bridge. Read-only: the
// agent and the CLI move tickets. Fetches on load, on the refresh button, whenever the backend says `changed`
// (after a write tool or a turn) and after the link reconnects.

/** Priority marks: `!` high, `!!` urgent (0 draws nothing). */
const PRIORITY_MARK = ['', '!', '!!']
const PRIORITY_LABEL = ['normal priority', 'high priority', 'urgent']
/** Finished work is not what you look at: `done` starts collapsed. */
const COLLAPSED_BY_DEFAULT = ['done']
const ADD_CMD = 'node plugins/waifufy-tickets/bin/tickets.mjs add "…"'
/** The slot's cap (it sits in a tall-but-shared column); past it the panel scrolls inside its frame. */
const MAX_HEIGHT = 236

const el = document.querySelector('.tickets')
const body = el.querySelector('.tickets-body')
const count = el.querySelector('[data-test="tickets-count"]')

let board
let error = ''
let busy = false
let again = false
const open = new Map()
/** Cards the user expanded, by id, so a refresh or a turn end does not fold them back. */
const expanded = new Set()

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
function relTime(ms) {
  const s = (Date.now() - ms) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`
  return new Date(ms).toLocaleDateString()
}
const para = (cls, test, html) => `<p class="${cls}" data-test="${test}">${html}</p>`

function detailHtml(t) {
  const text = (t.body ?? '').trim()
  return text ? esc(text).replace(/\n/g, '<br>') : '<em>No description.</em>'
}

function cardHtml(t) {
  const mark = PRIORITY_MARK[t.priority] ?? ''
  const isOpen = expanded.has(t.id)
  const meta = [t.project, ...t.labels, relTime(t.updatedAt || t.createdAt)].filter(Boolean).map(esc).join(' · ')
  return `<li class="tickets-card" data-test="tickets-card" data-id="${esc(t.id)}" data-status="${esc(t.status)}" data-pri="${t.priority}">
    <button type="button" class="tickets-card-head" aria-expanded="${isOpen}" title="${isOpen ? 'Hide the description' : 'Show the description'}">
      <span class="tickets-id">${esc(t.id)}</span>
      <span class="tickets-name">${esc(t.title)}</span>
      ${mark ? `<span class="tickets-pri" data-pri="${t.priority}" title="${PRIORITY_LABEL[t.priority]}">${mark}</span>` : ''}
    </button>
    ${meta ? `<p class="tickets-meta">${meta}</p>` : ''}
    ${t.blockedReason ? `<p class="tickets-blocked">Blocked: ${esc(t.blockedReason)}</p>` : ''}
    ${isOpen ? `<div class="tickets-detail">${detailHtml(t)}</div>` : ''}
  </li>`
}

function colHtml(c) {
  const shown = open.get(c.status) ?? !COLLAPSED_BY_DEFAULT.includes(c.status)
  // The count is the store's, not the list's: a capped `done` list holds fewer cards than the column counts.
  const n = board?.counts?.[c.status] ?? c.tickets.length
  return `<details class="tickets-col" data-test="tickets-column" data-status="${esc(c.status)}" data-count="${n}"${shown ? ' open' : ''}>
    <summary class="tickets-col-head"><span class="tickets-col-name">${esc(c.label)}</span><small>${esc(c.hint)}</small><em>${n}</em></summary>
    ${c.tickets.length ? `<ul class="tickets-list">${c.tickets.map(cardHtml).join('')}</ul>` : ''}
  </details>`
}

function render() {
  // The user's open/closed groups are the DOM's truth; take them before it is replaced.
  for (const d of el.querySelectorAll('.tickets-col')) open.set(d.dataset.status, d.open)
  const notice = error ? para('tickets-quiet', 'tickets-error', `Not refreshed: ${esc(error)}`) : ''
  if (!board) {
    count.textContent = '—'
    el.dataset.state = error ? 'error' : 'loading'
    body.innerHTML = para('tickets-quiet', 'tickets-error', esc(error || 'Asking the board…'))
  } else if (!board.available) {
    count.textContent = '—'
    el.dataset.state = 'unavailable'
    body.innerHTML = `<div class="tickets-unavailable" data-test="tickets-unavailable">
      <b>The ticket board can't be read.</b>
      ${board.reason ? `<p>${esc(board.reason)}</p>` : ''}
      <p>Check the database in <code>%APPDATA%/waifufy-tickets</code>, then refresh.</p>
    </div>`
  } else if (!board.total) {
    count.textContent = '0'
    el.dataset.state = 'empty'
    body.innerHTML = notice
      + para('tickets-quiet', 'tickets-empty', `No tickets yet. The agent files them for you, or add one with <code>${esc(ADD_CMD)}</code>.`)
  } else {
    count.textContent = String(board.total)
    el.dataset.state = 'board'
    body.innerHTML = notice + board.columns.map(colHtml).join('')
  }
  fit()
}

function fit() {
  waifufy.resize(Math.min(MAX_HEIGHT, Math.ceil(el.getBoundingClientRect().height)))
}

async function fetchOnce() {
  el.dataset.loading = '1'
  try {
    board = await waifufy.call('board')
    error = ''
  } catch (e) {
    // A call that failed keeps the last board on screen with a quiet note; with none, it is the body.
    error = e instanceof Error ? e.message : String(e)
  } finally {
    el.removeAttribute('data-loading')
    render()
  }
}

/** Refresh, coalescing bursts (a click landing on a turn end sends one request, not two). */
async function refresh() {
  if (busy) {
    again = true
    return
  }
  busy = true
  try {
    do {
      again = false
      await fetchOnce()
    } while (again)
  } finally {
    busy = false
  }
}

el.addEventListener('click', (e) => {
  const target = e.target
  if (target.closest('[data-test="tickets-refresh"]')) return void refresh()
  // The card head is a button (keyboard included); a click anywhere on the card folds it either way.
  const id = target.closest('.tickets-card')?.dataset.id
  if (!id) return
  if (expanded.has(id)) expanded.delete(id)
  else expanded.add(id)
  render()
})
// Group toggles change the height too.
el.addEventListener('toggle', fit, true)

waifufy.on('changed', refresh)
waifufy.on('reconnected', refresh)
waifufy.ready()
render()
refresh()
