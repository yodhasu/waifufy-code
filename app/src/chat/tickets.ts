// The optional ticket board (plugins/waifufy-tickets) as a read-only card in the chat screen's left column.
// The board itself lives in the plugin folder and reaches the app through the link (`{ t: 'tickets' }`);
// this module only draws it: fetch on mount, on the refresh button, and after every turn. No write ever
// starts here — the agent and the CLI move tickets.

import type { BoardSnapshot, ServerMsg, TicketCard, TicketColumn, TicketStatus } from '../../../link/src/protocol.ts'
import type { Link } from '../contracts'
import type { UiPlugin } from '../plugins'
import { esc, relTime } from '../ui'
import './tickets.css'

/** The link answers at once unless it is mid-restart; past this, say so instead of hanging on a spinner. */
const FETCH_TIMEOUT_MS = 12_000
/** Priority marks: `!` high, `!!` urgent (0 draws nothing). */
const PRIORITY_MARK = ['', '!', '!!']
const PRIORITY_LABEL = ['normal priority', 'high priority', 'urgent']
/** Finished work is not what you look at: `done` starts collapsed. */
const COLLAPSED_BY_DEFAULT: readonly string[] = ['done']
/** The install command the plugin folder documents, for the `available: false` state. */
const INSTALL_CMD = 'node plugins/waifufy-tickets/install.mjs'
/** How to file a ticket when the board is empty. */
const ADD_CMD = 'node plugins/waifufy-tickets/bin/tickets.mjs add "…"'

type TicketsReply = Extract<ServerMsg, { t: 'tickets' }>

/** The app's globals, set by main.ts. The seam mounts by element, so the link comes from here. */
function appLink(): Link | undefined {
  return (window as unknown as { __wc?: { link?: Link } }).__wc?.link
}

/**
 * Mounts the board into `host` (the slot the chat screen places under the mode/model badges) and returns
 * its teardown: the link subscription off, the element gone. Look at the DOM for open/closed groups: the
 * user's last choice survives a re-render, and only the first paint uses the defaults.
 */
export function mountTicketsPanel(host: HTMLElement): () => void {
  const link = appLink()
  const el = document.createElement('section')
  el.className = 'tickets'
  el.dataset.test = 'tickets-panel'
  el.dataset.state = 'loading'
  el.innerHTML = `<header class="tickets-head">
      <h4>Tickets <em data-test="tickets-count">—</em></h4>
      <button type="button" class="tickets-refresh" data-test="tickets-refresh" title="Refresh the board" aria-label="Refresh the ticket board">⟳</button>
    </header>
    <div class="tickets-body"></div>`
  host.append(el)
  const body = el.querySelector<HTMLElement>('.tickets-body')!
  const count = el.querySelector<HTMLElement>('[data-test="tickets-count"]')!

  let board: BoardSnapshot | undefined
  let error = ''
  let dead = false
  let busy = false
  let again = false
  let seq = 0
  const open = new Map<string, boolean>()
  /** Cards the user expanded, by id, so a refresh or a turn end does not fold them back. */
  const expanded = new Set<string>()

  // ---------------------------------------------------------------- drawing

  const para = (cls: string, test: string, html: string) => `<p class="${cls}" data-test="${test}">${html}</p>`

  /** The body of an expanded card: plain text, its own line breaks kept. */
  function detailHtml(t: TicketCard) {
    const text = (t.body ?? '').trim()
    return text ? esc(text).replace(/\n/g, '<br>') : '<em>No description.</em>'
  }

  function cardHtml(t: TicketCard) {
    const mark = PRIORITY_MARK[t.priority] ?? ''
    const isOpen = expanded.has(t.id)
    const meta = [t.project, ...t.labels, relTime(t.updatedAt || t.createdAt)]
      .filter((s): s is string => Boolean(s))
      .map(esc)
      .join(' · ')
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

  function colHtml(c: TicketColumn) {
    const shown = open.get(c.status) ?? !COLLAPSED_BY_DEFAULT.includes(c.status)
    // The count is the store's, not the list's: a capped `done` list holds fewer cards than the column counts.
    // (The panel never sends a `project`, so the snapshot's counts are the whole board's either way.)
    const n = board?.counts?.[c.status] ?? c.tickets.length
    return `<details class="tickets-col" data-test="tickets-column" data-status="${esc(c.status)}" data-count="${n}"${shown ? ' open' : ''}>
      <summary class="tickets-col-head"><span class="tickets-col-name">${esc(c.label)}</span><small>${esc(c.hint)}</small><em>${n}</em></summary>
      ${c.tickets.length ? `<ul class="tickets-list">${c.tickets.map(cardHtml).join('')}</ul>` : ''}
    </details>`
  }

  function render() {
    if (dead) return
    // The user's open/closed groups are the DOM's truth; take them before it is replaced.
    for (const d of el.querySelectorAll<HTMLDetailsElement>('.tickets-col')) open.set(d.dataset.status ?? '', d.open)
    const notice = error ? para('tickets-quiet', 'tickets-error', `Not refreshed: ${esc(error)}`) : ''
    if (!board) {
      count.textContent = '—'
      el.dataset.state = error ? 'error' : 'loading'
      body.innerHTML = para('tickets-quiet', 'tickets-error', esc(error || 'Asking the board…'))
      return
    }
    if (!board.available) {
      count.textContent = '—'
      el.dataset.state = 'unavailable'
      body.innerHTML = `<div class="tickets-unavailable" data-test="tickets-unavailable">
        <b>The ticket plugin isn't installed.</b>
        ${board.reason ? `<p>${esc(board.reason)}</p>` : ''}
        <p>Install it with <code>${esc(INSTALL_CMD)}</code>, then refresh.</p>
      </div>`
      return
    }
    count.textContent = String(board.total)
    if (!board.total) {
      // An installed plugin with no tickets yet: link sends no columns in that case, so this is a plain line.
      el.dataset.state = 'empty'
      body.innerHTML = notice
        + para('tickets-quiet', 'tickets-empty', `No tickets yet. The agent files them for you, or add one with <code>${esc(ADD_CMD)}</code>.`)
      return
    }
    el.dataset.state = 'board'
    body.innerHTML = notice + board.columns.map(colHtml).join('')
  }

  // ---------------------------------------------------------------- fetching

  async function fetchOnce() {
    if (dead || !link) return
    const mine = ++seq
    el.dataset.loading = '1'
    try {
      // Subscribe before sending: the answer comes back on the same socket.
      const reply = link.next((m): m is TicketsReply => m.t === 'tickets', FETCH_TIMEOUT_MS)
      link.send({ t: 'tickets' })
      const m = await reply
      if (dead || mine !== seq) return
      board = m.board
      error = ''
    } catch (e) {
      if (dead || mine !== seq) return
      // A reply that never came keeps the last board on screen with a quiet note; with none, it is the body.
      error = e instanceof Error ? e.message : String(e)
    } finally {
      if (!dead && mine === seq) {
        el.removeAttribute('data-loading')
        render()
      }
    }
  }

  /** Refresh, coalescing bursts (a click landing on a turn end sends one request, not two). */
  async function refresh(): Promise<void> {
    if (busy) {
      again = true
      return
    }
    busy = true
    try {
      do {
        again = false
        await fetchOnce()
      } while (again && !dead)
    } finally {
      busy = false
    }
  }

  // ---------------------------------------------------------------- wiring

  function onClick(e: MouseEvent) {
    const target = e.target as HTMLElement | null
    if (target?.closest('[data-test="tickets-refresh"]')) return void refresh()
    // The card head is a button (keyboard included); a click anywhere on the card folds it either way.
    const id = target?.closest<HTMLElement>('.tickets-card')?.dataset.id
    if (!id) return
    if (expanded.has(id)) expanded.delete(id)
    else expanded.add(id)
    render()
  }

  el.addEventListener('click', onClick)
  // A finished turn may have moved a card. The link pushes this to every window, so no epoch is wanted here.
  const offTurn = link?.on((m) => {
    if (m.t === 'turn_end') void refresh()
  })

  render()
  void refresh()

  return () => {
    dead = true
    seq++
    offTurn?.()
    el.removeEventListener('click', onClick)
    el.remove()
  }
}

/** The registry entry (app/src/plugins): off until the user turns it on in Settings → Plugins. */
export const ticketsPlugin: UiPlugin = {
  id: 'tickets',
  name: 'Ticket board',
  description: 'A read-only board of your tickets (plugins/waifufy-tickets) in the chat, under the mode and model badges. '
    + 'The agent files and moves them; you just watch. Takes effect as soon as the chat is shown.',
  defaultEnabled: false,
  mount: mountTicketsPanel,
}
