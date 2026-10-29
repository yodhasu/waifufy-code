// The composer under the dialogue box. It gives Claude Code CLI muscle memory to the VN chat: Enter /
// Shift+Enter, ↑↓ per-project history and Ctrl+R, the / command picker, @ file mentions, ! bash mode,
// pasted or dropped images, and the queued-message chips (R10, R11, R14–R17).

import type { Command, FileHit, Image } from '../../../link/src/protocol.ts'
import type { Ctx } from '../contracts'
import { esc } from '../ui'
import './input.css'
import { APP_COMMANDS } from './commands'
import { hasFence, highlight, planEnter } from './format'

export type InputHost = {
  ctx: Ctx
  /** Slash commands from the SDK (`ready`/`commands` events). */
  commands(): Command[]
  /** Session folder, for the per-project history key and @ search. */
  cwd(): string
  busy(): boolean
  /** A normal message (may contain @paths; the CLI expands them). */
  submit(text: string, images: Image[]): void
  /** Ctrl+Enter while she works: the CLI's "send now", delivered at once instead of after her turn. */
  submitNow(text: string, images: Image[]): void
  /** `!cmd` */
  shell(command: string): void
  /** App-native commands: model, clear, resume, config, costume, help, exit, login. Return true if handled. */
  local(name: string, args: string): boolean
  /** Enter on an empty input: advance the dialogue. */
  advance(): void
  /** The Say button while she works (it reads STOP then): interrupt the turn. */
  stop?(): void
  /** The mode chip in the box: the next permission mode, as Shift+Tab. */
  cycleMode?(): void
  /** The Work / Casual switch left of the box. */
  toggleChat?(): void
  /** Whether there is a draft in the focused box, on each change: her own messages wait while you type. */
  typing?(on: boolean): void
}

/**
 * Keyboard contract with the chat screen, whose shortcuts listen on `window`:
 * - Every key event from the composer (textarea, buttons, history search) passes `fromInput(e)`. The chat never
 *   advances on Space/Enter for those events (Enter on an empty composer calls host.advance() itself).
 * - Holding Ctrl skips (R27) even while the composer has focus, which is almost always: start skip on a bare hold, a
 *   `Control` keydown with `e.repeat` true while `!ctrlCombo()`, and stop it when `ctrlCombo()` turns true or Ctrl
 *   is released. Ctrl+V, Ctrl+A or Ctrl+Backspace while typing therefore never skip her lines.
 * - Keys the composer used (Enter, picker navigation, Esc closing a picker, Ctrl+R, Ctrl+C clearing text) are
 *   `preventDefault()`ed, so the chat should ignore events with `e.defaultPrevented`.
 * - Esc with no picker open bubbles untouched, so the chat can close overlays or interrupt the turn (R12). If nobody
 *   handled it and she is idle, two quick presses clear the composer, as in the CLI.
 * - Shift+Tab, Ctrl+L and Ctrl+C on an empty composer bubble too. The chat should `preventDefault()` Shift+Tab when
 *   it cycles the mode, which also keeps the focus in the textarea.
 */
export type InputApi = {
  focus(): void
  /** Queued messages shown as chips above the input; clicking a chip's × removes it (host.dequeue). */
  setQueued(items: { id: string; text: string }[], onRemove: (id: string) => void): void
  setEnabled(on: boolean, placeholder?: string): void
  /** Puts text back into the input (Esc restores queued messages, as in the CLI). */
  restore(text: string): void
  /** True while the slash / @ picker is open; Esc closes it first. */
  closePopups(): boolean
  /** True while you are typing: a draft in the focused composer and a key in the last TYPING_IDLE_MS. */
  isTyping(): boolean
  /** Runs `fn` once you stop typing (at once if you aren't): toasts and gestures never land mid-sentence. */
  whenIdle(fn: () => void): void
  /** The CLI's greyed next-prompt suggestion on an empty composer; Tab takes it. Typing or sending clears it. */
  suggest(text: string): void
  /** Sends `text` as if typed: the command palette's way to run a command or a message. */
  run(text: string): void
  /** She is working: the Say slot turns into STOP (or QUEUE while you type), as on every screen. */
  setRunning(on: boolean): void
  /** The permission mode chip in the box: its label and the mode it stands for (its colour). */
  setMode(label: string, mode: string): void
  /** Work or casual: the switch's label, and the permission chip only in work mode. */
  setChat(mode: 'work' | 'casual'): void
  /** Her offer to switch modes, as a bar over the composer; gone on either answer or the next message. */
  offer(text: string, onAccept: () => void): void
  /**
   * A question as a bar over the composer, like the offer: one button per choice, Cancel, and a "save as default"
   * box when `remember` names it. `onPick` gets the choice and whether the box was ticked; Cancel calls nothing.
   */
  choose(text: string, choices: { id: string; label: string; primary?: boolean }[], remember: string | undefined, onPick: (id: string, remember: boolean) => void): void
}

/** True for events that come from the composer (see InputApi). */
export const fromInput = (e: Event) => e.target instanceof Element && !!e.target.closest('[data-wc-input]')

let comboHeld = false
/** True while the held Ctrl has been part of a shortcut (another key went down with it): no skip until Ctrl is released. */
export const ctrlCombo = () => comboHeld

/** The letter of a Ctrl shortcut: the typed one on Latin layouts (Dvorak, AZERTY), the physical key on Cyrillic, Greek… */
function shortcutLetter(e: KeyboardEvent) {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase()
  return /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : ''
}
const ctrlOnly = (e: KeyboardEvent, letter: string) => e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && shortcutLetter(e) === letter

/** Windows paths: `C:\Work\x`, `c:/work/x/` and `C:\Work\x\` are one folder, so they share one history. */
const normalizeCwd = (cwd: string) => cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

const MAX_LINES = 6
const HISTORY_MAX = 200
const HISTORY_KEY = 'wc.history:'
const SEARCH_MAX = 50
const AT_ROWS = 8
const AT_DEBOUNCE_MS = 80
const MAX_IMAGES = 5
const MAX_IMAGE_SIDE = 2000
/** The API rejects images whose base64 payload is over 5 MB. */
const MAX_IMAGE_BASE64 = 5 * 1024 * 1024
const JPEG_QUALITIES = [0.92, 0.85, 0.75, 0.6]
/** JPEG has no alpha; transparent screenshots get a white matte instead of turning black. */
const JPEG_MATTE = '#ffffff'
const ESC_CLEAR_MS = 900
const HINT_MS = 2400
const QUEUE_CHIP_CHARS = 60
const DROP_LINGER_MS = 160
const MAX_FILES = 10
/** The link keeps files up to 25 MB (link/src/attachments.ts). */
const MAX_FILE_BYTES = 25 * 1024 * 1024
const FILE_PUT_TIMEOUT_MS = 120_000

type Attached = { name: string; path?: string }
/** Keys this recent count as still typing: toasts and gestures wait (docs/research/ux-research.md P0-8). */
const TYPING_IDLE_MS = 2000


type SlashItem = { name: string; description: string; hint: string; tag: 'app' | 'built-in' | 'custom'; alias?: string }

const NO_MATCH = Infinity

const EXACT = -1

/**
 * Exact name or alias first (`/cost` runs the SDK's cost, not the app's costume), then name prefix, alias prefix,
 * name substring, fuzzy name, and finally a description hit.
 */
function slashScore(c: { name: string; aliases: string[]; description: string }, q: string) {
  const name = c.name.toLowerCase()
  if (name === q || c.aliases.includes(q)) return EXACT
  if (name.startsWith(q)) return 0
  if (c.aliases.some((a) => a.startsWith(q))) return 1
  if (name.includes(q)) return 2
  if (isSubsequence(q, name)) return 3
  if (c.description.toLowerCase().includes(q)) return 4
  return NO_MATCH
}

function isSubsequence(q: string, s: string) {
  let i = 0
  for (const ch of s) if (ch === q[i]) i++
  return i === q.length
}

/** `<x>` is required; `[x]`, a bare hint, or `<optional …>` is not, so Enter runs the command right away. */
const requiresArg = (hint: string) => /^\s*</.test(hint) && !/optional/i.test(hint)

const SUPPORTED_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const isSupported = (t: string): t is Image['mediaType'] => SUPPORTED_TYPES.includes(t)

function toBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

function encode(bitmap: ImageBitmap, scale: number, type: 'image/png' | 'image/jpeg', quality?: number) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const g = canvas.getContext('2d')!
  if (type === 'image/jpeg') {
    g.fillStyle = JPEG_MATTE
    g.fillRect(0, 0, canvas.width, canvas.height)
  }
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return new Promise<string>((resolve, reject) =>
    canvas.toBlob((b) => (b ? toBase64(b).then(resolve, reject) : reject(new Error('encode failed'))), type, quality),
  )
}

/**
 * Makes an image the API accepts: png/jpeg/gif/webp, at most 2000px on the long side, under the size limit.
 * Images that already fit are sent untouched (animated GIFs stay animated); others are redrawn on a canvas,
 * as PNG when that fits (screenshots stay crisp) and otherwise as JPEG at falling quality.
 */
async function prepareImage(blob: Blob): Promise<Image | undefined> {
  const bitmap = await createImageBitmap(blob).catch(() => undefined)
  if (!bitmap) return undefined
  try {
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height))
    if (scale === 1 && isSupported(blob.type)) {
      const data = await toBase64(blob)
      if (data.length <= MAX_IMAGE_BASE64) return { mediaType: blob.type, data }
    }
    if (blob.type !== 'image/jpeg') {
      const data = await encode(bitmap, scale, 'image/png')
      if (data.length <= MAX_IMAGE_BASE64) return { mediaType: 'image/png', data }
    }
    for (const q of JPEG_QUALITIES) {
      const data = await encode(bitmap, scale, 'image/jpeg', q)
      if (data.length <= MAX_IMAGE_BASE64) return { mediaType: 'image/jpeg', data }
    }
    return undefined
  } catch {
    return undefined
  } finally {
    bitmap.close()
  }
}

export function createInput(root: HTMLElement, host: InputHost): InputApi {
  const { ctx } = host
  root.innerHTML = `
    <div class="wci" data-wc-input>
      <div class="wci-pop wci-slash" data-test="slash-popup" hidden></div>
      <div class="wci-pop wci-at" data-test="at-popup" hidden></div>
      <div class="wci-pop wci-hist" data-test="history-popup" hidden>
        <label class="wci-search"><span>⟲ history</span>
          <input data-test="history-search" spellcheck="false" autocomplete="off" placeholder="type to search · Ctrl+R older · Enter picks"></label>
        <div class="wci-hist-list"></div>
      </div>
      <div class="wci-queue"></div>
      <div class="wci-offer" data-test="mode-offer" hidden><span></span>
        <button type="button" class="btn primary" data-test="mode-offer-yes">Switch</button>
        <button type="button" class="btn" data-test="mode-offer-no">Not now</button></div>
      <div class="wci-offer wci-choice" data-test="mode-choice" hidden><span></span>
        <label class="wci-remember"><input type="checkbox" data-test="mode-choice-remember"><small></small></label>
        <span class="wci-choices"></span>
        <button type="button" class="btn" data-test="mode-choice-cancel">Cancel</button></div>
      <div class="wci-bar">
        <button type="button" class="wci-chat" data-test="chat-mode" data-chat="work" title="Work or casual chat with her"><b>⚙</b><small>WORK</small></button>
        <button type="button" class="wci-attach" data-test="chat-attach" title="Attach files or images (or paste / drop them)" aria-label="Attach files">${ICON_CLIP}</button>
        <input type="file" class="wci-pick" data-test="chat-pick" multiple hidden>
        <div class="wci-box" data-test="input-mode" data-mode="normal">
          <div class="wci-files"></div>
          <div class="wci-images"></div>
          <div class="wci-line">
            <button type="button" class="wci-perm" data-test="input-mode-chip" title="Permission mode (Shift+Tab)" hidden></button>
            <span class="wci-mode">! bash</span>
            <div class="wci-ta"><div class="wci-hl" aria-hidden="true"></div><textarea data-test="chat-input" rows="1" spellcheck="false" autocomplete="off"></textarea></div>
          </div>
          <span class="wci-hint"></span>
        </div>
        <button type="button" class="wci-send" data-test="chat-send"></button>
        <div class="wci-drop"></div>
      </div>
    </div>`
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!
  const wrap = q('.wci')
  const ta = q<HTMLTextAreaElement>('textarea')
  const box = q('.wci-box')
  const sendBtn = q<HTMLButtonElement>('.wci-send')
  const attachBtn = q<HTMLButtonElement>('.wci-attach')
  const permBtn = q<HTMLButtonElement>('.wci-perm')
  const chatBtn = q<HTMLButtonElement>('.wci-chat')
  const offerEl = q('.wci-offer:not(.wci-choice)')
  const choiceEl = q('.wci-choice')
  let chatMode: 'work' | 'casual' = 'work'
  let permShown = false
  const slashPop = q('.wci-slash')
  const atPop = q('.wci-at')
  const histPop = q('.wci-hist')
  const histList = q('.wci-hist-list')
  const searchEl = q<HTMLInputElement>('.wci-search input')
  const queueEl = q('.wci-queue')
  const imagesEl = q('.wci-images')
  const filesEl = q('.wci-files')
  const hlEl = q('.wci-hl')
  const pickEl = q<HTMLInputElement>('.wci-pick')
  const hintEl = q('.wci-hint')
  const dropEl = q('.wci-drop')

  const waifu = () => ctx.store.get().waifu.name.trim() || 'her'

  let enabled = true
  let placeholderOverride: string | undefined
  let suggestion = ''
  let lastKeyAt = 0
  const idleWaiters: (() => void)[] = []
  let idleTimer: number | undefined
  let images: Image[] = []
  /** Any-file attachments: kept by the link under its data folder, mentioned in the message as `@"path"`. */
  let files: Attached[] = []
  let running = false
  let queueRemove: (id: string) => void = () => {}

  // ---------------------------------------------------------------- textarea basics

  function grow() {
    // Hidden (screen not shown yet): scrollHeight is 0, so keep the one-row CSS height until it is visible.
    if (!ta.offsetParent) return void (ta.style.height = '')
    ta.style.height = 'auto'
    const cs = getComputedStyle(ta)
    const max = parseFloat(cs.lineHeight) * MAX_LINES + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
    ta.style.height = `${Math.min(ta.scrollHeight, max)}px`
    ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden'
    // A scrollbar narrows the textarea's text; the layer keeps the same width so its lines wrap at the same place.
    hlEl.style.right = `${ta.offsetWidth - ta.clientWidth}px`
    hlEl.scrollTop = ta.scrollTop
  }

  function refreshMode() {
    const bash = ta.value.startsWith('!')
    box.dataset.mode = bash ? 'bash' : 'normal'
    paint()
    refreshSend()
  }

  /** The highlight layer behind the textarea: fences, `code` and **bold** as you type (format.ts). */
  function paint() {
    const v = ta.value
    box.dataset.fmt = !v.startsWith('!') && hasFence(v) ? 'code' : 'text'
    hlEl.innerHTML = v.startsWith('!') ? '' : highlight(v)
    hlEl.scrollTop = ta.scrollTop
  }

  /** One slot, three jobs: SAY (or RUN for `!`), QUEUE while she works and you type, STOP while she works. */
  function refreshSend() {
    const draft = !!ta.value.trim() || images.length > 0 || files.length > 0
    const job = running ? (draft ? 'queue' : 'stop') : ta.value.startsWith('!') ? 'run' : 'say'
    if (sendBtn.dataset.job === job) return
    sendBtn.dataset.job = job
    sendBtn.innerHTML = SEND_LABELS[job]
    sendBtn.title = SEND_TITLES[job]
    // STOP works even while the box is disabled for typing (she is busy, the link is down).
    sendBtn.disabled = job === 'stop' ? false : !enabled
  }

  function updatePlaceholder() {
    // A suggestion shows on an enabled prompt over the chat's own placeholder; a disabled one keeps its reason.
    const suggesting = enabled && !!suggestion
    ta.placeholder = suggesting ? `${suggestion}   (Tab)` : placeholderOverride ?? `Speak to ${waifu()}…   ( / commands · @ files · ! bash · Shift+Enter newline )`
    box.classList.toggle('suggesting', suggesting)
  }

  // Typing: a draft in the box and a key in the last TYPING_IDLE_MS. Just after Enter sent it, the box is empty, so a
  // menu that opens then takes the keys; a pause ends "typing" even with a draft left in the box.
  const typing = () => document.activeElement === ta && !!ta.value.trim() && performance.now() - lastKeyAt < TYPING_IDLE_MS

  /** Flushes the whenIdle queue once the composer has been quiet (or emptied) for TYPING_IDLE_MS. */
  function checkIdle() {
    clearTimeout(idleTimer)
    if (!idleWaiters.length) return
    if (typing()) return void (idleTimer = window.setTimeout(checkIdle, TYPING_IDLE_MS))
    for (const fn of idleWaiters.splice(0)) fn()
  }

  /** Replaces the whole text programmatically (history, completion, restore): caret at the end. */
  function setValue(text: string) {
    ta.value = text
    ta.setSelectionRange(text.length, text.length)
    grow()
    refreshMode()
    closePopups()
    reportDraft()
  }

  // Her own messages wait while you have a draft in the focused box (casual/initiative.ts). A draft left there for
  // 20 minutes means you've gone away. Only changes are sent, and a slash command isn't a message to her.
  let drafting = false
  function reportDraft() {
    const draft = ta.value.trim()
    const now = document.activeElement === ta && !!draft && !draft.startsWith('/')
    if (now === drafting) return
    drafting = now
    host.typing?.(now)
  }

  /** Types `text` over the selection like the user would, so Ctrl+Z still works; fires `input`. */
  function insertText(text: string) {
    ta.focus()
    if (!document.execCommand('insertText', false, text)) {
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }

  let hintTimer: number | undefined
  function hint(text: string) {
    hintEl.textContent = text
    hintEl.classList.add('show')
    clearTimeout(hintTimer)
    hintTimer = window.setTimeout(() => hintEl.classList.remove('show'), HINT_MS)
  }

  /** Keeps the selected row of a scrolling list in view without scrollIntoView, which would also scroll the stage. */
  function keepInView(list: HTMLElement, row: Element | undefined) {
    if (!(row instanceof HTMLElement)) return
    const bottom = row.offsetTop + row.offsetHeight
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
  }

  // ---------------------------------------------------------------- history (R10)

  const historyKey = () => `${HISTORY_KEY}${normalizeCwd(host.cwd())}`
  let hist: string[] = []
  /** -1 while editing the draft; otherwise the recalled entry in `hist`. */
  let histIdx = -1
  let draft = ''

  function loadHistory(): string[] {
    try {
      const v: unknown = JSON.parse(localStorage.getItem(historyKey()) ?? '[]')
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }

  function remember(text: string) {
    const list = loadHistory()
    if (list.at(-1) !== text) list.push(text)
    try {
      localStorage.setItem(historyKey(), JSON.stringify(list.slice(-HISTORY_MAX)))
    } catch {
      // Storage full or blocked: history is a convenience, sending still works.
    }
    histIdx = -1
  }

  /** ↑ (-1) / ↓ (+1) through history. Returns false when the key should keep its normal caret movement. */
  function recall(dir: -1 | 1) {
    if (histIdx === -1) {
      if (dir === 1) return false
      hist = loadHistory()
      if (!hist.length) return false
      draft = ta.value
      histIdx = hist.length
    }
    const next = histIdx + dir
    if (next < 0) return true
    if (next >= hist.length) {
      histIdx = -1
      setValue(draft)
    } else {
      histIdx = next
      setValue(hist[next])
    }
    return true
  }

  // Ctrl+R: reverse search, newest match first.
  let searchHits: string[] = []
  let searchSel = 0

  function renderSearch() {
    const needle = searchEl.value.toLowerCase()
    const seen = new Set<string>()
    searchHits = loadHistory()
      .reverse()
      .filter((t) => t.toLowerCase().includes(needle) && !seen.has(t) && !!seen.add(t))
      .slice(0, SEARCH_MAX)
    searchSel = Math.min(searchSel, Math.max(0, searchHits.length - 1))
    histList.innerHTML = searchHits.length
      ? searchHits
          .map(
            (t, i) =>
              `<div class="wci-row wci-hrow${i === searchSel ? ' sel' : ''}" data-test="history-item" data-i="${i}">${esc(t.replace(/\n/g, ' ⏎ '))}</div>`,
          )
          .join('')
      : `<div class="wci-empty">${searchEl.value ? 'No earlier message matches' : 'No history in this folder yet'}</div>`
    keepInView(histList, histList.children[searchSel])
  }

  function openSearch() {
    closePopups()
    searchEl.value = ''
    searchSel = 0
    histPop.hidden = false
    renderSearch()
    searchEl.focus()
  }

  function closeSearch(pick?: string) {
    if (histPop.hidden) return false
    histPop.hidden = true
    if (pick !== undefined) {
      histIdx = -1
      setValue(pick)
    }
    ta.focus()
    return true
  }

  searchEl.addEventListener('input', () => ((searchSel = 0), renderSearch()))
  searchEl.addEventListener('blur', () => (histPop.hidden = true))
  searchEl.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return
    const older = e.key === 'ArrowUp' || ctrlOnly(e, 'r')
    if (older || e.key === 'ArrowDown') {
      e.preventDefault()
      searchSel = Math.max(0, Math.min(searchHits.length - 1, searchSel + (older ? 1 : -1)))
      return renderSearch()
    }
    // As in the CLI: Enter runs the match at once, Tab puts it in the prompt to edit first.
    if (e.key === 'Tab') return e.preventDefault(), closeSearch(searchHits[searchSel])
    if (e.key === 'Enter') {
      e.preventDefault()
      const hit = searchHits[searchSel]
      closeSearch(hit)
      if (hit !== undefined) send()
      return
    }
    if (e.key === 'Escape') return e.preventDefault(), e.stopPropagation(), closeSearch()
  })
  histList.addEventListener('mousedown', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.wci-hrow')
    e.preventDefault()
    if (row) closeSearch(searchHits[Number(row.dataset.i)])
  })

  // ---------------------------------------------------------------- pickers (R14, R15)

  let popup: 'slash' | 'at' | undefined
  let sel = 0
  let slashItems: SlashItem[] = []
  let atHits: FileHit[] = []
  /** The @token under the caret whose files were asked for; replies for other queries are stale. */
  let atQuery: string | undefined
  /** The query `atHits` answers, and the last one sent to the link. */
  let atShown: string | undefined
  let atSent: string | undefined
  let atTimer: number | undefined
  /** Enter/Tab pressed while the shown rows still answer an older query: pick once the current one arrives. */
  let atPendingRun: boolean | undefined

  function buildSlash(query: string): SlashItem[] {
    const w = waifu()
    const own = new Set(APP_COMMANDS.flatMap((c) => [c.name, ...c.aliases]))
    const needle = query.toLowerCase()
    const rows: { aliases: string[]; item: SlashItem }[] = [
      ...APP_COMMANDS.map((c) => ({ aliases: c.aliases, item: { name: c.name, description: c.describe(w), hint: c.hint, tag: 'app' as const } })),
      ...host
        .commands()
        .filter((c) => !own.has(c.name))
        .map((c) => ({
          // The CLI's own aliases (/cost runs /usage), so an exact alias outranks a prefix like /costume.
          aliases: (c.aliases ?? []).filter((x) => !own.has(x)),
          item: { name: c.name, description: c.description, hint: c.argumentHint, tag: c.builtin ? ('built-in' as const) : ('custom' as const) },
        })),
    ]
    return rows
      .map(({ aliases, item }) => {
        const score = needle ? slashScore({ ...item, aliases }, needle) : 0
        // Show the alias the user is typing (`/quit` → exit) unless the name itself already matches.
        const viaAlias = score <= 1 && !item.name.toLowerCase().startsWith(needle)
        const alias = viaAlias ? (aliases.find((a) => a === needle) ?? aliases.find((a) => a.startsWith(needle))) : undefined
        return { score, item: alias ? { ...item, alias } : item }
      })
      .filter((r) => r.score !== NO_MATCH)
      .sort((a, b) => a.score - b.score)
      .map((r) => r.item)
  }

  function renderPopup() {
    slashPop.hidden = popup !== 'slash'
    atPop.hidden = popup !== 'at'
    if (popup === 'slash') {
      slashPop.innerHTML = slashItems
        .map(
          (c, i) => `<div class="wci-row wci-srow${i === sel ? ' sel' : ''}" data-test="slash-item" data-name="${esc(c.name)}" data-i="${i}">
            <b>/${esc(c.name)}${c.hint ? ` <small>${esc(c.hint)}</small>` : ''}</b>
            <span>${c.alias ? `<i>/${esc(c.alias)}</i> · ` : ''}${esc(c.description)}</span>
            <em class="tag-${c.tag === 'built-in' ? 'builtin' : c.tag}">${c.tag}</em></div>`,
        )
        .join('')
      keepInView(slashPop, slashPop.children[sel])
    } else if (popup === 'at') {
      atPop.innerHTML = atHits.length
        ? atHits
            .map((h, i) => {
              const path = h.isDir && !/[\\/]$/.test(h.path) ? `${h.path}/` : h.path
              const cut = path.replace(/[\\/]$/, '').search(/[^\\/]*$/)
              return `<div class="wci-row wci-arow${i === sel ? ' sel' : ''}" data-test="at-item" data-path="${esc(h.path)}" data-i="${i}">
                <span class="ico">${h.agent ? '✦' : h.isDir ? '📁' : '📄'}</span>
                <span class="path"><span class="dir">${esc(path.slice(0, cut))}</span><b>${esc(path.slice(cut))}</b></span></div>`
            })
            .join('')
        : `<div class="wci-empty">No files match <code>@${esc(atQuery ?? '')}</code></div>`
    }
  }

  function openSlash(query: string) {
    slashItems = buildSlash(query)
    if (!slashItems.length) return closePickers()
    popup = 'slash'
    sel = 0
    renderPopup()
  }

  function closePickers() {
    const was = popup !== undefined
    popup = undefined
    atQuery = atShown = atSent = atPendingRun = undefined
    clearTimeout(atTimer)
    renderPopup()
    return was
  }

  /** The `@token` ending at the caret: its range (to the end of the word) and the text after `@`. */
  function atToken() {
    if (ta.selectionStart !== ta.selectionEnd) return undefined
    const caret = ta.selectionStart
    const m = /(?:^|\s)@(\S*)$/.exec(ta.value.slice(0, caret))
    if (!m) return undefined
    const tail = /^\S*/.exec(ta.value.slice(caret))![0].length
    return { start: caret - m[1].length - 1, end: caret + tail, query: m[1].replace(/^"/, '') }
  }

  function updatePopups() {
    if (/^\/\S*$/.test(ta.value)) return openSlash(ta.value.slice(1))
    if (popup === 'slash') closePickers()
    const tok = atToken()
    if (!tok) {
      if (popup === 'at' || atQuery !== undefined) closePickers()
      return
    }
    if (tok.query === atQuery) return
    atQuery = tok.query
    clearTimeout(atTimer)
    atTimer = window.setTimeout(() => askFiles(tok.query), AT_DEBOUNCE_MS)
  }

  function askFiles(query: string) {
    clearTimeout(atTimer)
    atSent = query
    ctx.link.send({ t: 'files', query })
  }

  ctx.link.on((m) => {
    if (m.t !== 'files' || atQuery === undefined || m.query !== atQuery) return
    atHits = m.hits.slice(0, AT_ROWS)
    atShown = m.query
    if (popup !== 'at') sel = 0
    sel = Math.min(sel, Math.max(0, atHits.length - 1))
    popup = 'at'
    renderPopup()
    const run = atPendingRun
    atPendingRun = undefined
    if (run !== undefined) choose(run)
  })

  /** Enter / Tab on an open picker. */
  function choose(run: boolean) {
    if (popup === 'at' && atShown !== atQuery) {
      // Still typing faster than the debounce: ask now, and pick from the rows that answer what is typed.
      atPendingRun = run
      if (atSent !== atQuery) askFiles(atQuery!)
      return
    }
    const n = popup === 'slash' ? slashItems.length : atHits.length
    if (n && pick(sel, run)) return
    closePickers()
    if (run) send()
  }

  /** Runs or completes row `i`; false when there was nothing to do (the caret already left the @token). */
  function pick(i: number, run: boolean) {
    if (popup === 'slash') {
      const c = slashItems[i]
      if (!c) return false
      // The alias as typed, when that is what matched: /stats opens the usage panel on its Stats tab.
      const word = c.alias ?? c.name
      if (run && !requiresArg(c.hint)) {
        setValue('')
        runCommand(`/${word}`)
        return true
      }
      setValue(`/${word} `)
      ta.focus()
      if (c.hint) hint(`/${c.name} ${c.hint}`)
      return true
    } else if (popup === 'at') {
      const h = atHits[i]
      const tok = atToken()
      if (!h || !tok) return false
      // A folder completes to `@dir/` and keeps the picker open to go deeper, as the CLI does.
      const path = h.isDir && !/[\\/]$/.test(h.path) ? `${h.path}/` : h.path
      const quoted = /\s/.test(path) ? `"${path}"` : path
      ta.setSelectionRange(tok.start, tok.end)
      insertText(`@${quoted}${h.isDir ? '' : ' '}`)
      return true
    }
    return false
  }

  for (const pop of [slashPop, atPop]) {
    // mousedown, not click: keeps the textarea focused, so blur does not close the picker first.
    pop.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const row = (e.target as HTMLElement).closest<HTMLElement>('.wci-row')
      if (row) pick(Number(row.dataset.i), true)
    })
  }

  // ---------------------------------------------------------------- sending

  function takeImages() {
    const out = images
    images = []
    renderImages()
    return out
  }

  function runCommand(text: string) {
    remember(text)
    const [, word, args] = /^\/(\S+)\s*([\s\S]*)$/.exec(text)!
    const lower = word.toLowerCase()
    const own = APP_COMMANDS.find((c) => c.name === lower || c.aliases.includes(lower))
    // The name as typed: an alias can pick a panel's tab (/cost, /stats), and the chat's own cases list aliases.
    if (own && host.local(lower, args.trim())) return
    if (own?.name === 'login') {
      ctx.link.send({ t: 'login' })
      return ctx.toast('Opening the Claude Code login… come back once you are signed in')
    }
    host.submit(text, takeImages())
  }

  function send(now = false) {
    if (suggestion) (suggestion = ''), updatePlaceholder()
    // Bash mode only when `!` is the very first character, matching the visual mode (refreshMode).
    const bash = ta.value.startsWith('!')
    if (!bash && files.some((f) => !f.path)) return hint('Wait a moment: the files are still on their way')
    const typed = ta.value.trim()
    if (!typed && !images.length && !files.length) return host.advance()
    // Commands and `!` keep the files for the next real message.
    const text = bash || /^\/\S/.test(typed) ? typed : withFiles(typed)
    setValue('')
    if (bash) {
      // Images stay attached for the next real message.
      const command = text.slice(1).trim()
      if (!command) return
      remember(text)
      return host.shell(command)
    }
    if (/^\/\S/.test(text)) return runCommand(text)
    if (text) remember(text)
    if (now && host.busy()) return host.submitNow(text, takeImages())
    host.submit(text, takeImages())
  }

  let lastEsc = 0
  /** Runs after the whole dispatch: only when no overlay or interrupt claimed the Esc. */
  function escToClear(e: KeyboardEvent) {
    setTimeout(() => {
      if (e.defaultPrevented || host.busy() || (!ta.value && !images.length && !files.length)) return
      const now = performance.now()
      if (now - lastEsc > ESC_CLEAR_MS) return void ((lastEsc = now), hint('Esc again to clear'))
      lastEsc = 0
      setValue('')
      takeImages()
      files = []
      renderFiles()
    })
  }

  ta.addEventListener('keydown', (e) => {
    // IME: Enter, arrows and Esc pick kana/kanji candidates; never treat them as ours.
    if (e.isComposing || e.keyCode === 229) return
    const plain = !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey
    if (popup && plain) {
      const n = popup === 'slash' ? slashItems.length : atHits.length
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (n) sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n
        return renderPopup()
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        return choose(e.key === 'Enter')
      }
    }
    if (e.key === 'Escape') {
      if (closePopups()) return e.preventDefault(), e.stopPropagation()
      return escToClear(e)
    }
    lastKeyAt = performance.now()
    if (suggestion && e.key === 'Tab' && plain && !ta.value) {
      e.preventDefault()
      const s = suggestion
      suggestion = ''
      updatePlaceholder()
      return setValue(s)
    }
    if (ctrlOnly(e, 'r')) return e.preventDefault(), openSearch()
    // Ctrl+J is the CLI's newline; WebView2 would open the downloads otherwise.
    if (ctrlOnly(e, 'j')) return e.preventDefault(), insertText('\n')
    // Ctrl+L is the CLI's "clear the prompt".
    if (ctrlOnly(e, 'l')) return e.preventDefault(), setValue('')
    // Alt+V is the CLI's image paste on Windows.
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && shortcutLetter(e) === 'v') {
      e.preventDefault()
      return void pasteClipboardImage()
    }
    if (ctrlOnly(e, 'c') && ta.selectionStart === ta.selectionEnd && ta.value) {
      e.preventDefault()
      return setValue('')
    }
    if (e.key === 'Enter') {
      // Shift+Enter is the textarea's own newline; Alt/Meta+Enter get one too. Ctrl+Enter is the CLI's "send now".
      if (e.shiftKey) return
      e.preventDefault()
      if (e.altKey || e.metaKey) return insertText('\n')
      if (e.ctrlKey) return send(true)
      // `\` + Enter is the CLI's portable newline.
      const caret = ta.selectionStart
      if (caret === ta.selectionEnd && ta.value[caret - 1] === '\\') {
        ta.setSelectionRange(caret - 1, caret)
        return insertText('\n')
      }
      // Code blocks: ``` + Enter closes the block for you, and Enter inside one is a new line.
      if (caret === ta.selectionEnd && !ta.value.startsWith('!')) {
        const plan = planEnter(ta.value, caret)
        if (plan.kind === 'newline') return insertText('\n')
        if (plan.kind === 'close') {
          insertText(plan.text)
          return ta.setSelectionRange(caret + plan.caret, caret + plan.caret)
        }
      }
      return send()
    }
    if (plain && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const onFirst = !ta.value.slice(0, ta.selectionStart).includes('\n')
      const onLast = !ta.value.slice(ta.selectionEnd).includes('\n')
      if ((e.key === 'ArrowUp' ? onFirst : onLast) && recall(e.key === 'ArrowUp' ? -1 : 1)) e.preventDefault()
      return
    }
    // Plain Tab would move the focus to the buttons; the CLI keeps you in the prompt.
    if (plain && e.key === 'Tab') e.preventDefault()
  })

  ta.addEventListener('input', () => {
    histIdx = -1
    if (suggestion && ta.value) (suggestion = ''), updatePlaceholder()
    grow()
    refreshMode()
    updatePopups()
    reportDraft()
  })
  ta.addEventListener('click', () => {
    if (popup) updatePopups()
  })
  // Caret moves that fire no input event: leaving the @token closes its picker.
  ta.addEventListener('keyup', (e) => {
    if (popup && /^(Arrow(Left|Right)|Home|End)$/.test(e.key)) updatePopups()
  })
  ta.addEventListener('scroll', () => (hlEl.scrollTop = ta.scrollTop))
  ta.addEventListener('blur', () => (closePickers(), reportDraft()))
  ta.addEventListener('focus', () => (grow(), reportDraft()))
  sendBtn.addEventListener('click', () => {
    if (sendBtn.dataset.job === 'stop') return host.stop?.()
    send()
    ta.focus()
  })
  permBtn.addEventListener('click', () => (host.cycleMode?.(), ta.focus()))
  chatBtn.addEventListener('click', () => (host.toggleChat?.(), ta.focus()))
  let offerYes: (() => void) | undefined
  const hideOffer = () => ((offerEl.hidden = true), (offerYes = undefined))
  offerEl.querySelector('[data-test="mode-offer-yes"]')!.addEventListener('click', () => {
    const yes = offerYes
    hideOffer()
    yes?.()
    ta.focus()
  })
  offerEl.querySelector('[data-test="mode-offer-no"]')!.addEventListener('click', () => (hideOffer(), ta.focus()))
  let onChoice: ((id: string, remember: boolean) => void) | undefined
  const rememberBox = choiceEl.querySelector<HTMLInputElement>('[data-test="mode-choice-remember"]')!
  const hideChoice = () => ((choiceEl.hidden = true), (onChoice = undefined))
  choiceEl.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button')
    if (!b) return
    const pick = onChoice
    hideChoice()
    if (b.dataset.choice) pick?.(b.dataset.choice, rememberBox.checked)
    ta.focus()
  })
  refreshSend()

  // ---------------------------------------------------------------- images (R17)

  function renderImages() {
    queueMicrotask(refreshSend)
    imagesEl.innerHTML = images
      .map(
        (im, i) => `<div class="wci-img" data-test="image-chip" data-i="${i}">
          <img src="data:${im.mediaType};base64,${im.data}" alt="Image #${i + 1}">
          <button type="button" title="Remove" aria-label="Remove image">×</button></div>`,
      )
      .join('')
    imagesEl.classList.toggle('show', images.length > 0)
  }

  imagesEl.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('.wci-img')
    if (!chip || !(e.target as HTMLElement).closest('button')) return
    images.splice(Number(chip.dataset.i), 1)
    renderImages()
    ta.focus()
  })

  /** Alt+V: the clipboard's image, if it holds one (the same path as Ctrl+V paste). */
  async function pasteClipboardImage() {
    try {
      const items = await navigator.clipboard.read()
      const blobs: Blob[] = []
      for (const it of items) for (const type of it.types) if (type.startsWith('image/')) blobs.push(await it.getType(type))
      if (!blobs.length) return ctx.toast('No image on the clipboard')
      await addImages(blobs)
    } catch {
      ctx.toast('Could not read the clipboard')
    }
  }

  async function addImages(files: Blob[]) {
    if (!enabled) return
    const pics = files.filter((f) => f.type.startsWith('image/'))
    if (pics.length < files.length) ctx.toast(`${waifu()} can only look at images here (png, jpeg, gif, webp)`)
    for (const f of pics) {
      if (images.length >= MAX_IMAGES) return hint(`Up to ${MAX_IMAGES} images per message`)
      const image = await prepareImage(f)
      if (!image) {
        ctx.toast(`${waifu()} couldn't read that image`)
        continue
      }
      // Re-check: several pastes or drops may be converting at once.
      if (images.length >= MAX_IMAGES) return hint(`Up to ${MAX_IMAGES} images per message`)
      images.push(image)
      renderImages()
    }
  }

  ta.addEventListener('paste', (e) => {
    const data = e.clipboardData
    const pasted = [...(data?.files ?? [])]
    if (!pasted.length) return
    // Word, Excel or OneNote put a bitmap of the copied text next to it: text on the clipboard means a text paste.
    // A browser's "Copy image" carries no text/plain.
    if (data!.types.includes('text/plain') && data!.getData('text/plain').trim()) return
    e.preventDefault()
    void addAny(pasted)
  })

  // Any kind of file: the system picker with no type filter (images still go as images).
  attachBtn.addEventListener('click', () => {
    pickEl.value = ''
    pickEl.click()
  })
  pickEl.addEventListener('change', () => {
    void addAny([...(pickEl.files ?? [])]).finally(() => ta.focus())
  })

  /** Images she can look at go as images; everything else is kept by the link and mentioned by path. */
  function addAny(list: File[]) {
    const pics = list.filter((f) => isSupported(f.type))
    const rest = list.filter((f) => !isSupported(f.type))
    return Promise.all([pics.length ? addImages(pics) : undefined, rest.length ? addFiles(rest) : undefined])
  }

  // ---------------------------------------------------------------- any-file attachments

  let fileSeq = 0
  function renderFiles() {
    queueMicrotask(refreshSend)
    filesEl.innerHTML = files
      .map(
        (f, i) => `<div class="wci-file${f.path ? '' : ' loading'}" data-test="file-chip" data-i="${i}" title="${esc(f.path ?? `${f.name} (sending…)`)}">
          ${ICON_FILE}<span>${esc(f.name)}</span>
          <button type="button" title="Remove" aria-label="Remove file">×</button></div>`,
      )
      .join('')
    filesEl.classList.toggle('show', files.length > 0)
  }
  filesEl.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('.wci-file')
    if (!chip || !(e.target as HTMLElement).closest('button')) return
    files.splice(Number(chip.dataset.i), 1)
    renderFiles()
    ta.focus()
  })

  /** The typed text with a mention of every attached file; the files are taken (cleared) with it. */
  function withFiles(typed: string) {
    if (!files.length) return typed
    const mentions = files.map((f) => `@"${f.path}"`).join(' ')
    files = []
    renderFiles()
    return typed ? `${typed}\n\n${mentions}` : mentions
  }

  function put(name: string, data: string) {
    const id = `f${Date.now().toString(36)}${++fileSeq}`
    return new Promise<string>((resolve, reject) => {
      const timer = window.setTimeout(() => (off(), reject(new Error('no answer from the link'))), FILE_PUT_TIMEOUT_MS)
      const off = ctx.link.on((m) => {
        if (m.t !== 'file_put' || m.id !== id) return
        off()
        clearTimeout(timer)
        if (m.path) resolve(m.path)
        else reject(new Error(m.error ?? 'not kept'))
      })
      ctx.link.send({ t: 'file_put', id, name, data })
    })
  }

  async function addFiles(list: File[]) {
    if (!enabled) return
    await Promise.all(
      list.map(async (f) => {
        if (files.length >= MAX_FILES) return hint(`Up to ${MAX_FILES} files per message`)
        if (f.size > MAX_FILE_BYTES) return ctx.toast(`${f.name} is over ${MAX_FILE_BYTES / 1024 / 1024} MB`)
        const entry: Attached = { name: f.name || 'file' }
        files.push(entry)
        renderFiles()
        try {
          entry.path = await put(entry.name, await toBase64(f))
        } catch (e) {
          files = files.filter((x) => x !== entry)
          ctx.toast(`${waifu()} couldn't take ${entry.name}: ${(e as Error).message}`)
        }
        renderFiles()
      }),
    )
  }

  // Drops anywhere on the chat screen land here, including on her canvas (which lies outside the screen root).
  // HTML drop events only reach the page when Tauri's own drag-drop handler is off (dragDropEnabled: false). Then an
  // uncancelled file drop navigates the webview to the file, so the chat cancels it even while the input is disabled.
  let dropTimer: number | undefined
  const chatVisible = () => {
    const screen = root.closest('.screen')
    return !screen || screen.classList.contains('active')
  }
  const carriesFiles = (e: DragEvent) => chatVisible() && !!e.dataTransfer?.types.includes('Files')
  window.addEventListener('dragover', (e) => {
    if (!carriesFiles(e)) return
    e.preventDefault()
    e.dataTransfer!.dropEffect = enabled ? 'copy' : 'none'
    if (!enabled) return
    wrap.classList.add('drop')
    clearTimeout(dropTimer)
    dropTimer = window.setTimeout(() => wrap.classList.remove('drop'), DROP_LINGER_MS)
  })
  window.addEventListener('drop', (e) => {
    if (!carriesFiles(e) || e.defaultPrevented) return
    e.preventDefault()
    wrap.classList.remove('drop')
    if (enabled) void addAny([...e.dataTransfer!.files]).then(() => ta.focus())
  })

  // ---------------------------------------------------------------- queue chips (R11)

  queueEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('button')
    const chip = btn?.closest<HTMLElement>('.wci-qchip')
    if (chip) queueRemove(chip.dataset.id!)
  })

  // ---------------------------------------------------------------- live name and placeholder

  function applyNames() {
    updatePlaceholder()
    dropEl.textContent = `Drop files for ${waifu()} ❀`
  }
  applyNames()
  ctx.store.subscribe(applyNames)

  // ---------------------------------------------------------------- Ctrl hold vs Ctrl shortcuts (see InputApi)

  // Capture phase: the flag is set before the chat's own window listener sees the same keydown.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Control') {
        if (!e.repeat) comboHeld = false
      } else if (e.ctrlKey) comboHeld = true
    },
    true,
  )
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Control') comboHeld = false
  })
  window.addEventListener('blur', () => (comboHeld = false))

  function closePopups() {
    const pickers = closePickers()
    return closeSearch() || pickers
  }

  return {
    focus: () => ta.focus(),
    setQueued(items, onRemove) {
      queueRemove = onRemove
      queueEl.innerHTML = items
        .map((it) => {
          const one = it.text.replace(/\s+/g, ' ').trim()
          const short = one.length > QUEUE_CHIP_CHARS ? `${one.slice(0, QUEUE_CHIP_CHARS - 1)}…` : one
          return `<div class="wci-qchip" data-test="queue-chip" data-id="${esc(it.id)}" title="${esc(it.text)}">
            <span class="ico">⏳</span><span class="txt">${esc(short)}</span><button type="button" aria-label="Remove from queue">×</button></div>`
        })
        .join('')
      queueEl.classList.toggle('show', items.length > 0)
    },
    setEnabled(on, placeholder) {
      enabled = on
      placeholderOverride = placeholder
      ta.disabled = !on
      attachBtn.disabled = !on
      sendBtn.dataset.job = ''
      refreshSend()
      wrap.classList.toggle('off', !on)
      if (!on) closePopups()
      updatePlaceholder()
    },
    restore(text) {
      const cur = ta.value.replace(/\s+$/, '')
      histIdx = -1
      setValue(cur ? `${cur}\n${text}` : text)
      ta.focus()
    },
    closePopups,
    isTyping: typing,
    whenIdle(fn) {
      idleWaiters.push(fn)
      checkIdle()
    },
    suggest(text) {
      suggestion = text.trim()
      updatePlaceholder()
    },
    run(text) {
      setValue(text)
      send()
    },
    setRunning(on) {
      running = on
      refreshSend()
    },
    setMode(label, mode) {
      permShown = true
      permBtn.hidden = chatMode === 'casual'
      permBtn.textContent = label
      permBtn.dataset.mode = mode
    },
    setChat(mode) {
      chatMode = mode
      chatBtn.dataset.chat = mode
      chatBtn.innerHTML = mode === 'casual' ? '<b>♡</b><small>CASUAL</small>' : '<b>⚙</b><small>WORK</small>'
      chatBtn.setAttribute('aria-label', mode === 'casual' ? 'Casual chat: switch to work' : 'Work: switch to casual chat')
      permBtn.hidden = mode === 'casual' || !permShown
      wrap.dataset.chat = mode
      hideOffer()
      hideChoice()
    },
    offer(text, onAccept) {
      offerEl.querySelector('span')!.textContent = text
      offerYes = onAccept
      offerEl.hidden = false
    },
    choose(text, choices, label, onPick) {
      choiceEl.querySelector('span')!.textContent = text
      choiceEl.querySelector('.wci-choices')!.innerHTML = choices
        .map((c) => `<button type="button" class="btn${c.primary ? ' primary' : ''}" data-choice="${c.id}" data-test="mode-choice-${c.id}"></button>`)
        .join('')
      choices.forEach((c, i) => (choiceEl.querySelectorAll<HTMLButtonElement>('[data-choice]')[i].textContent = c.label))
      const box = choiceEl.querySelector<HTMLElement>('.wci-remember')!
      box.hidden = !label
      box.querySelector('small')!.textContent = label ?? ''
      rememberBox.checked = false
      onChoice = onPick
      hideOffer()
      choiceEl.hidden = false
    },
  }
}

const ICON_FILE = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4V20.5H6z"/><path d="M14 3.5v4h4"/></svg>'
const ICON_CLIP = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5l-7.8 7.8a5 5 0 01-7.1-7.1l8.3-8.3a3.4 3.4 0 014.8 4.8l-8.3 8.3a1.7 1.7 0 01-2.4-2.4l7.6-7.6"/></svg>'
const ICON_SEND = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l16-7-6.5 15-2.5-6z"/></svg>'
const ICON_STOP = '<svg class="ic fill" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>'
const SEND_LABELS: Record<string, string> = {
  say: `<span>SAY</span>${ICON_SEND}`,
  run: '<span>RUN</span><b>❯</b>',
  queue: `<span>QUEUE</span>${ICON_SEND}`,
  stop: `<span>STOP</span>${ICON_STOP}`,
}
const SEND_TITLES: Record<string, string> = {
  say: 'Send (Enter)',
  run: 'Run in the session folder (Enter)',
  queue: 'Queue for her next step (Enter) · Ctrl+Enter sends now',
  stop: 'Interrupt her (Esc)',
}
