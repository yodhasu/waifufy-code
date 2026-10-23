import { invoke } from '@tauri-apps/api/core'
import type { Auth, Relationship, Save, Settings } from '../../../link/src/protocol.ts'
import type { ChatParams, Ctx, Screen } from '../contracts'
import { esc } from '../ui'
import './screens.css'

// ---------------------------------------------------------------- helpers shared by the screens

const RELATION_WORDS: Record<Relationship, string> = {
  maid: 'maid',
  childhood: 'childhood friend',
  senpai: 'senpai',
  kouhai: 'kouhai',
  partner: 'partner',
  rival: 'rival',
  custom: 'companion',
}

/** "maid", "childhood friend", or the user's own word for a custom dynamic. */
export function relationWord(s: Settings) {
  const w = s.waifu
  return w.relationship === 'custom' ? w.relationshipCustom.trim() || RELATION_WORDS.custom : RELATION_WORDS[w.relationship]
}

/** "Yodha" + kun → "Yodha-kun". Mirrors addressOf in link/src/settings.ts, which can't be bundled (node:fs). */
export function addressOf(s: Settings) {
  const p = s.profile
  const name = p.callMe.trim() || p.displayName.trim() || 'Master'
  const h = p.honorific === 'custom' ? p.customHonorific.trim() : p.honorific === 'none' ? '' : p.honorific
  return h ? `${name}-${h.replace(/^-/, '')}` : name
}

export const waifuName = (s: Settings) => s.waifu.name.trim() || 'Rem'

// The UI is English, so relative times are too; absolute dates follow the system locale.
const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86400e3],
  ['month', 30 * 86400e3],
  ['week', 7 * 86400e3],
  ['day', 86400e3],
  ['hour', 3600e3],
  ['minute', 60e3],
]

/** "5 minutes ago", "yesterday", "just now". */
export function timeAgo(ms: number) {
  const diff = ms - Date.now()
  for (const [unit, size] of UNITS) if (Math.abs(diff) >= size) return RELATIVE.format(Math.round(diff / size), unit)
  return 'just now'
}

/** True while a confirm dialog or any other overlay is open; screen key handlers stand aside then. */
export const overlayOpen = () => document.querySelector('#stage .overlay.show') !== null

// ---------------------------------------------------------------- title screen

type ItemId = 'continue' | 'load' | 'new' | 'settings' | 'exit'

const ITEMS: { id: ItemId; label: string }[] = [
  { id: 'continue', label: 'Continue' },
  { id: 'load', label: 'Load' },
  { id: 'new', label: 'New Game' },
  { id: 'settings', label: 'Settings' },
  { id: 'exit', label: 'Exit' },
]

const MORNING = 5
const AFTERNOON = 12
const EVENING = 18
const NIGHT = 23

/** Title screen (R1–R5): Continue / Load / New Game / Settings / Exit, with a login banner when logged out. */
export function titleScreen(): Screen {
  let ctx: Ctx
  let root: HTMLElement
  let saves: Save[] = []
  let auth: Auth | undefined
  let version = ''
  let selected: ItemId = 'new'
  // Once the user picks an item, late-arriving saves no longer move the selection to Continue.
  let touched = false
  let active = false
  let turnRunning = false
  let loginOpened = false

  const item = (id: ItemId) => root.querySelector<HTMLButtonElement>(`.ttl-item[data-id="${id}"]`)!
  const visible = () => ITEMS.map((i) => i.id).filter((id) => !item(id).hidden)

  function select(id: ItemId, focus = true) {
    selected = id
    for (const b of root.querySelectorAll<HTMLElement>('.ttl-item')) b.classList.toggle('on', b.dataset.id === id)
    if (focus) item(id).focus({ preventScroll: true })
  }

  function render() {
    const s = ctx.store.get()
    const name = waifuName(s)
    const latest = saves[0]
    root.querySelector('.ttl-sub')!.textContent = `${name} · your Claude Code ${relationWord(s)}`

    const cont = item('continue')
    cont.hidden = !latest
    if (latest) {
      cont.querySelector('.ttl-hint')!.innerHTML =
        `<b>${esc(latest.title)}</b><span>${esc(timeAgo(latest.lastModified))}</span><span class="mono">${esc(latest.cwdShort)}</span>`
    }
    const count = saves.length
    item('load').querySelector('.ttl-hint')!.textContent = count ? `${count} save${count === 1 ? '' : 's'} · pick up any of them` : 'No saves yet'
    item('new').querySelector('.ttl-hint')!.textContent = `Choose a folder for ${name} to work in`
    item('settings').querySelector('.ttl-hint')!.textContent = `You, ${name}, her looks and her voice`
    item('exit').querySelector('.ttl-hint')!.textContent = 'See you next time'

    const loggedOut = auth?.loggedIn === false
    const banner = root.querySelector<HTMLElement>('.ttl-banner')!
    banner.hidden = !loggedOut
    if (loggedOut) {
      banner.querySelector('.ttl-banner-text')!.textContent = loginOpened
        ? 'A login window opened. Finish signing in there, and I will check again when you come back.'
        : auth?.error
          ? `Claude Code can't confirm your login: ${auth.error}`
          : `You're not logged in to Claude Code yet, so ${name} can't reach Claude.`
    }

    root.querySelector('.ttl-name')!.textContent = name
    root.querySelector('.ttl-line')!.textContent = greeting(s, count > 0, auth)
    root.querySelector('.ttl-ver')!.textContent = version ? `Waifufy Code ${/^\d/.test(version) ? 'v' : ''}${version}` : 'Waifufy Code'

    if (!visible().includes(selected)) select(latest ? 'continue' : 'new', active)
    else if (!touched && latest && selected !== 'continue') select('continue', active)
  }

  function greeting(s: Settings, hasSaves: boolean, a?: Auth) {
    const addr = addressOf(s)
    const h = new Date().getHours()
    const hello =
      h >= NIGHT || h < MORNING
        ? `Still awake, ${addr}?`
        : h < AFTERNOON
          ? `Good morning, ${addr}.`
          : h < EVENING
            ? `Welcome back, ${addr}.`
            : `Good evening, ${addr}.`
    const ask = a?.loggedIn === false
      ? "I can't reach Claude until you log in, though…"
      : hasSaves
        ? 'Shall we pick up where we left off?'
        : 'What shall we build together today?'
    return `${hello} ${ask}`
  }

  function refresh() {
    ctx.link.send({ t: 'saves' })
  }

  function run(id: ItemId) {
    touched = true
    select(id, false)
    if (id === 'continue') return void (saves[0] && ctx.router.go('chat', chatParams(saves[0])))
    if (id === 'load') return void ctx.router.go('saves')
    if (id === 'settings') return void ctx.router.go('settings')
    if (id === 'new') return void newGame()
    void exit()
  }

  async function newGame() {
    const s = ctx.store.get()
    const cwd = await ctx.pickFolder(`Where should ${waifuName(s)} work?`, s.claude.defaultDir || s.lastDir)
    if (!cwd || !active) return
    ctx.store.update((n) => {
      n.lastDir = cwd
    })
    ctx.router.go('chat', { cwd } satisfies ChatParams)
  }

  async function exit() {
    const name = waifuName(ctx.store.get())
    if (turnRunning && !(await ctx.confirm('Quit now?', `${name} is still in the middle of a turn. Quitting stops it.`, 'Quit', 'Stay'))) return
    await invoke('quit').catch(() => window.close())
  }

  function login() {
    loginOpened = true
    ctx.link.send({ t: 'login' })
    render()
  }

  return {
    mount(el, c) {
      root = el
      ctx = c
      root.innerHTML = `
        <div class="ttl-banner panel" hidden>
          <span class="ttl-banner-icon">✦</span>
          <span class="ttl-banner-text"></span>
          <button class="btn primary" data-test="title-login">Log in</button>
        </div>
        <header class="ttl-logo">
          <div class="ttl-kana">ワイフファイ・コード</div>
          <h1><span class="ttl-w">Waifufy</span><span class="ttl-c">Code</span></h1>
          <p class="ttl-sub"></p>
        </header>
        <nav class="ttl-menu">
          ${ITEMS.map(
            (i, k) => `<button class="ttl-item" data-id="${i.id}" data-test="title-${i.id}" style="--i:${k}">
              <span class="ttl-label">${i.label}</span><small class="ttl-hint"></small>
            </button>`,
          ).join('')}
        </nav>
        <figure class="ttl-quote"><figcaption class="ttl-name"></figcaption><blockquote class="ttl-line"></blockquote></figure>
        <footer class="ttl-foot"><span>↑↓ choose · Enter select · Esc → Exit</span><span class="ttl-ver"></span></footer>`

      const menu = root.querySelector<HTMLElement>('.ttl-menu')!
      menu.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('.ttl-item')
        if (b) run(b.dataset.id as ItemId)
      })
      // Hover and focus both move the VN selection marker, so mouse and keyboard never disagree.
      menu.addEventListener('pointerover', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('.ttl-item')
        if (!b || b.dataset.id === selected) return
        // A real pointer counts as a choice, so the saves reply arriving later doesn't drag the marker away from it.
        if (e.pointerType) touched = true
        select(b.dataset.id as ItemId)
      })
      menu.addEventListener('focusin', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('.ttl-item')
        if (b && b.dataset.id !== selected) select(b.dataset.id as ItemId, false)
      })
      root.querySelector<HTMLElement>('[data-test="title-login"]')!.onclick = login

      addEventListener('keydown', (e) => {
        if (!active || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || overlayOpen()) return
        const ids = visible()
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          touched = true
          const at = Math.max(0, ids.indexOf(selected))
          select(ids[(at + (e.key === 'ArrowDown' ? 1 : -1) + ids.length) % ids.length])
        } else if (e.key === 'Home' || e.key === 'End') {
          e.preventDefault()
          touched = true
          select(e.key === 'Home' ? ids[0] : ids[ids.length - 1])
        } else if (e.key === 'Enter' && !e.repeat) {
          // A focused button clicks itself on Enter; only act for focus elsewhere (body, the stage).
          if (e.target instanceof HTMLButtonElement && root.contains(e.target)) return
          e.preventDefault()
          run(selected)
        }
      })
      // Coming back from the login console window: check whether it worked.
      addEventListener('focus', () => {
        if (loginOpened && auth?.loggedIn === false) ctx.link.send({ t: 'auth_check' })
      })

      ctx.link.on((m) => {
        if (m.t === 'saves') saves = [...m.list].sort((a, b) => b.lastModified - a.lastModified)
        else if (m.t === 'hello') {
          version = m.version
          auth = m.auth
        } else if (m.t === 'auth') auth = m.auth
        else if (m.t === 'state') return void (turnRunning = m.state !== 'idle')
        else if (m.t === 'turn_end' || m.t === 'ended') return void (turnRunning = false)
        else return
        if (auth?.loggedIn) loginOpened = false
        render()
      })
      ctx.link.onStatus((s) => {
        // A sidecar that died mid-turn never sends `ended`; whatever comes back up is idle.
        if (s === 'down') turnRunning = false
        else if (active) refresh()
      })
      ctx.store.subscribe(() => active && render())
      // main.ts keeps the boot hello to itself; ask again for the version and login state.
      ctx.link.send({ t: 'hello' })
      render()
    },
    show() {
      active = true
      touched = false
      ctx.character.setPlacement('title')
      ctx.character.gesture('greet')
      root.classList.remove('enter')
      void root.offsetWidth
      root.classList.add('enter')
      render()
      select(saves.length ? 'continue' : 'new')
      refresh()
    },
    hide() {
      active = false
    },
    onEscape() {
      // The title is the hub: Esc walks the marker to Exit, like a game's main menu.
      touched = true
      select('exit')
      return true
    },
  }
}

const chatParams = (s: Save): ChatParams => ({ cwd: s.cwd, resume: s.id, title: s.title })
