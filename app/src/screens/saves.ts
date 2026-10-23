import type { Save } from '../../../link/src/protocol.ts'
import type { ChatParams, Ctx, Screen } from '../contracts'
import { esc } from '../ui'
import { overlayOpen, timeAgo, waifuName } from './title'
import './screens.css'

const COLS = 4
const ROWS = 2
const PER_PAGE = COLS * ROWS
const MIN_PAGES = 3
const MAX_HEARTS = 5

const DATE = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

const two = (n: number) => String(n).padStart(2, '0')

/** hh:mm:ss, hours unbounded. */
function playTime(ms: number) {
  const s = Math.floor(ms / 1000)
  return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`
}

const hearts = (n: number) => {
  const full = Math.max(0, Math.min(MAX_HEARTS, Math.round(n)))
  return `<span class="sv-hearts" title="Affection ${full}/${MAX_HEARTS}">${'♥'.repeat(full)}<i>${'♥'.repeat(MAX_HEARTS - full)}</i></span>`
}

/** The VN Save/Load page (R6–R9): 8 slots per page, numbered tabs, Return / Title. */
export function savesScreen(): Screen {
  let ctx: Ctx
  let root: HTMLElement
  let grid: HTMLElement
  let tabs: HTMLElement
  let saves: Save[] = []
  let page = 0
  /** Selected slot on the current page, 0–7. */
  let slot = 0
  let active = false
  let loaded = false
  let renaming: { id: string; finish(commit: boolean): void } | undefined
  /** A render was skipped while renaming; the rename's end catches up. */
  let stale = false

  const pages = () => Math.max(MIN_PAGES, Math.ceil(saves.length / PER_PAGE))
  const saveAt = (i: number) => saves[page * PER_PAGE + i] as Save | undefined
  const card = (i: number) => grid.querySelector<HTMLElement>(`.sv-slot[data-i="${i}"]`)

  function costumeLabel(s: Save) {
    const c = s.costume ? ctx.character.costumes().find((x) => x.id === s.costume) : undefined
    return c?.label ?? s.costume ?? waifuName(ctx.store.get())
  }

  function slotHtml(i: number) {
    const s = saveAt(i)
    const n = two(page * PER_PAGE + i + 1)
    if (!s) {
      return `<div class="sv-slot empty" data-test="save-slot" data-id="" data-i="${i}" tabindex="-1" role="button" aria-label="Slot ${n}, no data">
        <div class="sv-thumb"><div class="sv-nodata">NO DATA</div></div>
        <div class="sv-info"><div class="sv-date">No.${n}</div><div class="sv-title">—</div></div>
      </div>`
    }
    const art = `<div class="sv-art"><b>✦</b><span>${esc(costumeLabel(s))}</span>${s.lastLine ? `<q>${esc(s.lastLine)}</q>` : ''}</div>`
    const thumb = s.thumb ? `<img src="${esc(ctx.link.base + s.thumb)}" alt="" draggable="false">` : art
    const where = `${esc(s.cwdShort)}${s.branch && s.branch !== 'HEAD' ? ` · ⎇ ${esc(s.branch)}` : ''}`
    return `<div class="sv-slot" data-test="save-slot" data-id="${esc(s.id)}" data-i="${i}" tabindex="-1" role="button"
        aria-label="Slot ${n}: ${esc(s.title)}" title="${esc(s.lastLine ?? s.title)}">
      <div class="sv-thumb">${thumb}<template>${art}</template>
        <div class="sv-actions">
          <button data-act="load" data-test="save-load" title="Load (Enter)">▶</button>
          <button data-act="rename" data-test="save-rename" title="Rename (F2)">✎</button>
          <button data-act="delete" data-test="save-delete" title="Delete (Del)">🗑</button>
        </div>
      </div>
      <div class="sv-info">
        <div class="sv-date">No.${n} · ${esc(DATE.format(s.lastModified))} <small>${esc(timeAgo(s.lastModified))}</small></div>
        <div class="sv-title">${esc(s.title)}</div>
        <div class="sv-where mono">${where}</div>
        <div class="sv-meta"><span>⏱ ${playTime(s.playMs)}</span><span>✦ ${s.turns} turn${s.turns === 1 ? '' : 's'}</span>${hearts(s.affection)}</div>
      </div>
    </div>`
  }

  function render(focus = active) {
    if (renaming) return void (stale = true)
    stale = false
    page = Math.min(page, pages() - 1)
    tabs.innerHTML =
      `<button class="sv-arrow" data-step="-1" title="Previous page (Q / PageUp)" ${page === 0 ? 'disabled' : ''}>◀</button>` +
      Array.from(
        { length: pages() },
        (_, p) =>
          `<button class="sv-tab${p === page ? ' on' : ''}" data-test="save-page" data-page="${p + 1}" aria-pressed="${p === page}">${p + 1}</button>`,
      ).join('') +
      `<button class="sv-arrow" data-step="1" title="Next page (E / PageDown)" ${page === pages() - 1 ? 'disabled' : ''}>▶</button>`
    grid.innerHTML = Array.from({ length: PER_PAGE }, (_, i) => slotHtml(i)).join('')
    grid.classList.toggle('loading', !loaded)
    root.querySelector('.sv-count')!.textContent = loaded ? `${saves.length} save${saves.length === 1 ? '' : 's'}` : 'Looking for your saves…'
    select(slot, focus)
  }

  function select(i: number, focus = true) {
    slot = Math.max(0, Math.min(PER_PAGE - 1, i))
    for (const c of grid.querySelectorAll<HTMLElement>('.sv-slot')) {
      const on = Number(c.dataset.i) === slot
      c.classList.toggle('on', on)
      c.tabIndex = on ? 0 : -1
    }
    if (focus) card(slot)?.focus({ preventScroll: true })
  }

  function setPage(p: number, keepSlot = true) {
    const next = Math.max(0, Math.min(pages() - 1, p))
    if (next === page) return false
    page = next
    if (!keepSlot) slot = 0
    root.querySelector('.sv-grid-wrap')!.classList.remove('flip')
    void grid.offsetWidth
    root.querySelector('.sv-grid-wrap')!.classList.add('flip')
    render()
    return true
  }

  // Arrows walk the 4×2 grid; walking off the left or right edge turns the page.
  function move(dx: number, dy: number) {
    const row = Math.floor(slot / COLS) + dy
    let col = (slot % COLS) + dx
    if (row < 0 || row >= ROWS) return
    if (col < 0) {
      if (!setPage(page - 1)) return
      col = COLS - 1
    } else if (col >= COLS) {
      if (!setPage(page + 1)) return
      col = 0
    }
    select(row * COLS + col)
  }

  function load(i: number) {
    const s = saveAt(i)
    if (!s) return
    ctx.router.go('chat', { cwd: s.cwd, resume: s.id, title: s.title } satisfies ChatParams)
  }

  function rename(i: number) {
    const s = saveAt(i)
    const c = card(i)
    if (!s || !c || renaming) return
    select(i, false)
    const titleEl = c.querySelector<HTMLElement>('.sv-title')!
    titleEl.innerHTML = `<input class="field sv-rename" data-test="save-rename-input" maxlength="120" spellcheck="false">`
    const input = titleEl.querySelector<HTMLInputElement>('input')!
    input.value = s.title
    c.classList.add('renaming')
    renaming = {
      id: s.id,
      finish(commit) {
        if (renaming?.id !== s.id) return
        renaming = undefined
        const title = input.value.trim()
        if (commit && title && title !== s.title) {
          s.title = title
          ctx.link.send({ t: 'save_rename', id: s.id, title })
          ctx.toast(`Renamed to “${title}”`)
        }
        // Patch this card in place: a full render here would detach the slot buttons a blurring click is about to land on.
        if (stale) return render(false)
        titleEl.textContent = s.title
        c.classList.remove('renaming')
        c.setAttribute('aria-label', `Slot ${two(page * PER_PAGE + i + 1)}: ${s.title}`)
      },
    }
    // Keys stay inside the input: Esc cancels the rename instead of leaving the page.
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key !== 'Enter' && e.key !== 'Escape') return
      e.preventDefault()
      renaming?.finish(e.key === 'Enter')
      select(i)
    })
    input.addEventListener('blur', () => renaming?.finish(true))
    input.focus()
    input.select()
  }

  async function remove(i: number) {
    const s = saveAt(i)
    if (!s) return
    const yes = await ctx.confirm(
      'Delete this save?',
      `${waifuName(ctx.store.get())} will take “${s.title}” off this list.\nThe transcript stays on disk, so “claude --resume” can still find it.`,
      'Delete',
      'Keep it',
    )
    if (yes) {
      saves = saves.filter((x) => x.id !== s.id)
      ctx.link.send({ t: 'save_delete', id: s.id })
    }
    if (!active) return
    render()
  }

  return {
    mount(el, c) {
      root = el
      ctx = c
      root.innerHTML = `
        <div class="sv-page">
          <header class="sv-head">
            <div class="sv-heading"><h2 class="title-text">LOAD</h2><span class="sv-kana">ロード</span><span class="sv-count"></span></div>
            <nav class="sv-tabs" aria-label="Pages"></nav>
          </header>
          <div class="sv-grid-wrap"><div class="sv-grid"></div></div>
          <div class="sv-hint"><span class="sv-hint-icon">✦</span><span class="sv-hint-text">Load a save and continue from there.</span>
            <span class="sv-keys">←→↑↓ select · Enter load · F2 rename · Del delete · Q / E page · Esc return</span></div>
          <footer class="sv-bar">
            <button class="sv-bar-btn" data-test="saves-return">Return</button>
            <button class="sv-bar-btn" data-test="saves-title">Title</button>
          </footer>
        </div>`
      grid = root.querySelector('.sv-grid')!
      tabs = root.querySelector('.sv-tabs')!

      tabs.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button')
        if (!b) return
        if (b.dataset.page) setPage(Number(b.dataset.page) - 1, false)
        else setPage(page + Number(b.dataset.step))
      })
      grid.addEventListener('click', (e) => {
        const t = e.target as HTMLElement
        if (t.closest('input')) return
        const c = t.closest<HTMLElement>('.sv-slot')
        if (!c) return
        const i = Number(c.dataset.i)
        const act = t.closest<HTMLElement>('[data-act]')?.dataset.act
        if (act === 'rename') return rename(i)
        if (act === 'delete') return void remove(i)
        select(i)
        load(i)
      })
      grid.addEventListener('pointerover', (e) => {
        const c = (e.target as HTMLElement).closest<HTMLElement>('.sv-slot')
        if (c && !renaming && Number(c.dataset.i) !== slot) select(Number(c.dataset.i), false)
      })
      // Thumbnails that fail to load (deleted file, sidecar restarted) fall back to the costume art.
      grid.addEventListener(
        'error',
        (e) => {
          const img = e.target
          if (!(img instanceof HTMLImageElement)) return
          const art = img.parentElement?.querySelector('template')
          if (art) img.replaceWith(art.content.cloneNode(true))
        },
        true,
      )
      root.querySelector<HTMLElement>('[data-test="saves-return"]')!.onclick = () => ctx.router.back()
      root.querySelector<HTMLElement>('[data-test="saves-title"]')!.onclick = () => ctx.router.go('title')

      addEventListener('keydown', (e) => {
        if (!active || renaming || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || overlayOpen()) return
        const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
        const moves: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
        if (moves[key]) move(...moves[key])
        else if (key === 'PageUp' || key === 'q') setPage(page - 1)
        else if (key === 'PageDown' || key === 'e') setPage(page + 1)
        else if (/^[1-9]$/.test(key) && Number(key) <= pages()) setPage(Number(key) - 1, false)
        else if (key === 'F2') rename(slot)
        else if (key === 'Delete') void remove(slot)
        else if (key === 'Enter') {
          // Focused buttons (tabs, actions, Return) click themselves.
          if (e.target instanceof HTMLButtonElement && root.contains(e.target)) return
          if (e.repeat) return
          load(slot)
        } else return
        e.preventDefault()
      })

      ctx.link.on((m) => {
        if (m.t !== 'saves') return
        saves = [...m.list].sort((a, b) => b.lastModified - a.lastModified)
        loaded = true
        if (active) render()
      })
      render(false)
    },
    show() {
      active = true
      page = 0
      slot = 0
      ctx.character.setPlacement('hidden')
      render()
      ctx.link.send({ t: 'saves' })
    },
    hide() {
      active = false
      renaming?.finish(false)
    },
    onEscape() {
      if (renaming) renaming.finish(false)
      else ctx.router.back()
      return true
    },
  }
}
