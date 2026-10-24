import { esc } from '../ui'

// The CLI's interactive panels (/mcp, /agents, /hooks, /permissions…) as one VN-styled menu: grouped rows with a
// status icon, a detail line and a right-hand meta column, nested screens with Esc to go back, and the CLI's
// footer of key hints. Each command builds screens; this module only draws them and walks the stack.

export type Tone = 'ok' | 'bad' | 'warn' | 'muted' | 'accent'

export type MenuRow = {
  id: string
  label: string
  /** A status glyph before the label (✔ ✗ ⚠ ○ …), coloured by `tone`. */
  icon?: string
  tone?: Tone
  /** Dimmer text after the label, on the same line ("8 tools", "connected"). */
  meta?: string
  /** A second line under the label. */
  hint?: string
  /** Shown but not pickable (a disabled server's "Reconnect"). */
  disabled?: boolean
  /** Red, for actions that remove or reset something. */
  danger?: boolean
  /** The current choice (the active model, the current mode). */
  on?: boolean
}

export type MenuGroup = { title?: string; note?: string; rows: MenuRow[] }

export type MenuScreen = {
  title: string
  subtitle?: string
  /** Trusted HTML above the groups: a detail block (Status:, Command:, URL:…). Callers escape what they put in. */
  body?: string
  groups: MenuGroup[]
  /** Shown when every group is empty. */
  empty?: string
  /** Extra footer lines above the key hints ("Run claude --debug to see error logs"). */
  notes?: string[]
  /** Type-to-filter rows by label, meta and hint. */
  search?: boolean
  /**
   * What picking a row does. Return a screen to open it on top (Esc comes back here), 'refresh' to redraw this
   * screen from `reload`, 'back' to return to the screen below (rebuilt from its `reload`), 'close' to close the
   * whole menu, or nothing to stay.
   */
  pick?(row: MenuRow): MenuResult | Promise<MenuResult>
  /** Rebuilds this screen (after an action changed what it shows). */
  reload?(): Promise<MenuScreen>
  /** Keys this screen handles itself before the list (a picker's ←/→ for effort, Space to toggle). */
  key?(e: KeyboardEvent, row: MenuRow | undefined): MenuResult | boolean | Promise<MenuResult>
  /**
   * A tab strip above the list (the CLI's Settings and Plugins dialogs): `tab` is the current one. Clicking a tab,
   * Tab / Shift+Tab, or ←/→ outside a text field calls `switchTab`, whose screen replaces this one in place.
   */
  tabs?: { id: string; label: string }[]
  /** Her line about this screen, with her name plate (VN flavour). Hidden in Focus mode. */
  voice?: { name: string; text: string }
  tab?: string
  switchTab?(id: string): MenuScreen | Promise<MenuScreen>
}

export type MenuResult = MenuScreen | 'refresh' | 'back' | 'close' | void

export type MenuHost = {
  modal(o: { test: string; title: string; cls?: string; body: string; key?(e: KeyboardEvent): boolean; back?(): boolean; onClose?(): void }): {
    el: HTMLElement
    close(): void
  }
  toast(text: string): void
  /** Her line for a panel's first screen (by its test id), when the screen brings none of its own. */
  voiceFor?(test: string): MenuScreen['voice']
}

const HINTS = '↑/↓ to navigate · Enter to confirm · Esc to go back'

/** Opens a menu at `first` (a screen, or a promise of one while it loads). Resolves when the menu closes. */
export function openMenu(host: MenuHost, test: string, first: MenuScreen | Promise<MenuScreen>, loadingTitle = 'Loading…') {
  const stack: { screen: MenuScreen; focus: string | undefined; query: string }[] = []
  let busy = false
  /** refresh(): one is running, and another came in meanwhile. */
  let refreshing = false
  let stale = false
  let done!: () => void
  const closed = new Promise<void>((r) => (done = r))

  const m = host.modal({
    test,
    title: loadingTitle,
    cls: 'menu',
    body: '<div class="mvoice" data-test="menu-voice" hidden></div><nav class="mtabs" role="tablist" data-test="menu-tabs"></nav><div class="menu-sub"></div><div class="menu-body"></div><div class="menu-list" role="listbox"></div><footer class="menu-foot"></footer>',
    key: onKey,
    back,
    onClose: () => done(),
  })
  const el = m.el
  const titleEl = el.querySelector<HTMLElement>('header h2')!
  const tabsEl = el.querySelector<HTMLElement>('.mtabs')!
  const voiceEl = el.querySelector<HTMLElement>('.mvoice')!
  const sub = el.querySelector<HTMLElement>('.menu-sub')!
  const body = el.querySelector<HTMLElement>('.menu-body')!
  const list = el.querySelector<HTMLElement>('.menu-list')!
  const foot = el.querySelector<HTMLElement>('.menu-foot')!
  let search: HTMLInputElement | undefined

  const top = () => stack.at(-1)
  const rowsOf = (s: MenuScreen) => s.groups.flatMap((g) => g.rows)
  const visible = () => [...list.querySelectorAll<HTMLElement>('.mrow')]
  const rowById = (id: string | undefined) => (id === undefined ? undefined : rowsOf(top()!.screen).find((r) => r.id === id))
  const focused = () => (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.mrow')?.dataset.id

  /** A substring of the label, meta or hint; else the letters in order in the label ("mcpre" → "mcp reconnect"). */
  function matches(r: MenuRow, q: string) {
    if (!q || [r.label, r.meta ?? '', r.hint ?? ''].some((t) => t.toLowerCase().includes(q))) return true
    let i = 0
    for (const ch of r.label.toLowerCase()) if (ch === q[i]) i++
    return i === q.length
  }

  function draw() {
    const t = top()
    if (!t) return
    const s = t.screen
    titleEl.textContent = s.title
    tabsEl.hidden = !s.tabs?.length
    tabsEl.innerHTML = (s.tabs ?? [])
      .map((x) => `<button type="button" role="tab" class="mtab${x.id === s.tab ? ' on' : ''}" data-test="menu-tab" data-tab="${esc(x.id)}" aria-selected="${x.id === s.tab}" tabindex="-1">${esc(x.label)}</button>`)
      .join('')
    voiceEl.hidden = !s.voice
    voiceEl.innerHTML = s.voice ? `<b>${esc(s.voice.name)}</b><span>${esc(s.voice.text)}</span>` : ''
    sub.textContent = s.subtitle ?? ''
    sub.hidden = !s.subtitle
    body.innerHTML = s.body ?? ''
    body.hidden = !s.body
    const q = t.query.trim().toLowerCase()
    const groups = s.groups.map((g) => ({ ...g, rows: g.rows.filter((r) => matches(r, q)) })).filter((g) => g.rows.length || g.note)
    list.innerHTML = groups.length
      ? groups.map((g) => `<section class="mgroup">${g.title ? `<h3>${esc(g.title)}${g.note ? ` <small>${esc(g.note)}</small>` : ''}</h3>` : ''}`
        + g.rows.map(rowHtml).join('') + '</section>').join('')
      : `<p class="empty">${esc(q ? `Nothing matches “${t.query.trim()}”.` : s.empty ?? 'Nothing here yet.')}</p>`
    const notes = (s.notes ?? []).map((n) => `<div class="mnote">${esc(n)}</div>`).join('')
    foot.innerHTML = `${notes}<div class="mkeys">${s.search ? 'Type to search · ' : ''}${stack.length > 1 ? HINTS : HINTS.replace('go back', 'close')}</div>`
    if (s.search) {
      if (!search) {
        search = document.createElement('input')
        search.className = 'field msearch'
        search.placeholder = 'Search…'
        search.spellcheck = false
        search.dataset.test = 'menu-search'
        search.addEventListener('input', () => {
          top()!.query = search!.value
          draw()
        })
        el.querySelector('header .mtools')!.append(search)
      }
      search.hidden = false
      search.value = t.query
    } else if (search) search.hidden = true
    const want = visible().find((r) => r.dataset.id === t.focus && !r.classList.contains('off')) ?? visible().find((r) => !r.classList.contains('off'))
    if (document.activeElement !== search) want?.focus({ preventScroll: false })
  }

  function rowHtml(r: MenuRow) {
    const cls = ['mrow', r.on ? 'on' : '', r.disabled ? 'off' : '', r.danger ? 'danger' : ''].filter(Boolean).join(' ')
    return `<button type="button" class="${cls}" role="option" data-test="menu-row" data-id="${esc(r.id)}"${r.disabled ? ' aria-disabled="true"' : ''}>`
      + `<span class="mi ${r.tone ?? ''}">${r.icon ? esc(r.icon) : ''}</span>`
      + `<span class="ml"><b>${esc(r.label)}</b>${r.hint ? `<small>${esc(r.hint)}</small>` : ''}</span>`
      + `<span class="mm">${r.meta ? esc(r.meta) : ''}</span></button>`
  }

  function push(s: MenuScreen) {
    if (!stack.length && !s.voice) s.voice = host.voiceFor?.(test)
    if (top()) top()!.focus = focused() ?? top()!.focus
    stack.push({ screen: s, focus: undefined, query: '' })
    draw()
  }

  async function apply(r: MenuResult) {
    if (!r) return
    if (r === 'close') return m.close()
    if (r === 'back') {
      if (stack.length > 1) stack.pop()
      const t = top()!
      if (t.screen.reload) t.screen = await t.screen.reload()
      return draw()
    }
    if (r === 'refresh') {
      const t = top()!
      if (!t.screen.reload) return draw()
      t.focus = focused() ?? t.focus
      t.screen = await t.screen.reload()
      return draw()
    }
    push(r)
  }

  /** Runs an action with the menu locked, so a double Enter doesn't fire it twice. */
  async function run(fn: () => MenuResult | Promise<MenuResult> | boolean) {
    if (busy) return
    busy = true
    el.classList.add('busy')
    try {
      const r = await fn()
      if (typeof r !== 'boolean') await apply(r)
    } catch (e) {
      host.toast(e instanceof Error ? e.message : String(e))
    } finally {
      busy = false
      el.classList.remove('busy')
    }
  }

  /**
   * Live data changed under the menu (/tasks): rebuilds every open screen from its `reload` and redraws. It doesn't
   * take the action lock, so a row can show "stopping…" while its action runs; calls during a refresh coalesce.
   */
  async function refresh() {
    if (refreshing) return void (stale = true)
    refreshing = true
    try {
      do {
        stale = false
        const t = top()
        if (t) t.focus = focused() ?? t.focus
        for (const s of [...stack]) if (s.screen.reload) s.screen = await s.screen.reload()
        draw()
      } while (stale)
    } catch (e) {
      host.toast(e instanceof Error ? e.message : String(e))
    } finally {
      refreshing = false
    }
  }

  function pickRow(id: string | undefined) {
    const t = top()
    const r = rowById(id)
    if (!t || !r || r.disabled || !t.screen.pick) return
    t.focus = r.id
    void run(() => t.screen.pick!(r))
  }

  /** Esc: one screen back, or close at the first screen. Returns true while the menu stays open. */
  function back() {
    if (search && document.activeElement === search && search.value) {
      search.value = ''
      top()!.query = ''
      draw()
      return true
    }
    if (stack.length <= 1) return false
    stack.pop()
    draw()
    return true
  }

  function move(step: number) {
    const rows = visible().filter((r) => !r.classList.contains('off'))
    if (!rows.length) return
    const at = rows.findIndex((r) => r === document.activeElement)
    rows[at < 0 ? (step > 0 ? 0 : rows.length - 1) : (at + step + rows.length) % rows.length].focus()
  }

  function onKey(e: KeyboardEvent) {
    const t = top()
    if (!t) return false
    if (t.screen.key) {
      // true: handled here; false or nothing: not this screen's key; anything else is a result to apply.
      const r = t.screen.key(e, rowById(focused()))
      if (r === true) return true
      if (r) return void run(() => r), true
    }
    // Tabs: Tab / Shift+Tab always, ←/→ unless the caret is in a text field.
    const typing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement
    if (t.screen.tabs?.length && t.screen.switchTab && (e.key === 'Tab' || (!typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')))) {
      const ids = t.screen.tabs.map((x) => x.id)
      const step = e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1
      const at = Math.max(0, ids.indexOf(t.screen.tab ?? ids[0]))
      return void switchTo(ids[(at + step + ids.length) % ids.length]), true
    }
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) return move(1), true
    if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) return move(-1), true
    if (e.key === 'Home' || e.key === 'End') {
      const rows = visible().filter((r) => !r.classList.contains('off'))
      ;(e.key === 'Home' ? rows[0] : rows.at(-1))?.focus()
      return true
    }
    if (e.key === 'Enter' && !e.repeat) {
      pickRow(focused() ?? visible().find((r) => !r.classList.contains('off'))?.dataset.id)
      return true
    }
    // Typing a letter while a searchable screen has the focus on a row starts the search, as in the CLI pickers.
    if (t.screen.search && search && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && document.activeElement !== search) {
      search.focus()
      return false
    }
    return false
  }

  /** Replaces the top screen with its `switchTab` screen, keeping the stack below. */
  function switchTo(id: string) {
    const t = top()
    if (!t?.screen.switchTab || id === t.screen.tab) return
    const fn = t.screen.switchTab
    void run(async () => {
      t.screen = await fn(id)
      t.focus = undefined
      t.query = ''
      draw()
    })
  }

  tabsEl.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.mtab')
    if (b) switchTo(b.dataset.tab!)
  })

  list.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.mrow')
    if (b) pickRow(b.dataset.id)
  })

  body.innerHTML = '<p class="empty">Loading…</p>'
  void Promise.resolve(first).then(push, (e) => {
    body.innerHTML = `<p class="empty bad">${esc(e instanceof Error ? e.message : String(e))}</p>`
    body.hidden = false
  })

  return { close: m.close, closed, el, refresh }
}

/** A "Label: value" detail block, the CLI's server/agent/hook detail header. Values are escaped. */
export function detailRows(rows: [string, string | undefined][]) {
  const shown = rows.filter(([, v]) => v !== undefined && v !== '')
  return shown.length
    ? `<dl class="mdetail">${shown.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v!)}</dd>`).join('')}</dl>`
    : ''
}
