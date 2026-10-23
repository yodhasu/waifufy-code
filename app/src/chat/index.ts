// The chat screen: a Claude Code session played as a visual novel (R10–R30). It owns the session
// lifecycle and wires the link's events to the dialogue, the panels, the choice menus and the input.

import type { Command, HistoryEntry, Image, ModelChoice, PermissionModeName, SessionEvent, Stats } from '../../../link/src/protocol.ts'
import type { ChatParams, Ctx, Gesture, Screen } from '../contracts'
import { addressOf } from '../screens/title'
import { esc, fmtK } from '../ui'
import { createAsks, type Asks } from './asks'
import './chat.css'
import {
  cleanText, createDialogue, createPager, lastEmotion, markdown, pagesForMono, pagesForText, type Dialogue, type DisplayPage,
} from './dialogue'
import { createInput, fromInput, type InputApi, type InputHost } from './input'
import {
  createPanels, doing, isShell, MAX_HEARTS, MODE_LABELS, oneLine, toolIcon, toolLabel, type Panels, type ToolRecord,
} from './panels'

/** A finished turn this long earns her "success" gesture. */
const SUCCESS_MIN_SECONDS = 20
const THUMB_W = 320
const THUMB_H = 180
const TICK_MS = 1000
/** Holding Ctrl alone this long starts skipping (R27). Longer inside a text field, so Ctrl+V, Ctrl+A… never skip. */
const SKIP_ARM_MS = 150
const SKIP_ARM_IN_FIELD_MS = 400
const LAST_LINE_CHARS = 200
/** The stats that follow turn_end are waited for this long before the turn is saved without them. */
const STATS_WAIT_MS = 1500
/** The LOG follows new entries while you are this close to its bottom. */
const LOG_STICK_PX = 40
const LOG_DETAIL_CHARS = 140
const RETRY_NOTE_CHARS = 80
const SHELL_NARRATION_CHARS = 120
/** Overlays stack from this z-index up, in the order they opened. */
const LAYER_Z_BASE = 50
const BASE_CYCLE: PermissionModeName[] = ['default', 'acceptEdits', 'plan']

type LogEntry =
  | { who: 'char' | 'user' | 'system' | 'error'; text: string }
  | { who: 'tool'; tool: ToolRecord }
  | { who: 'shell'; command: string; output: string; code: number | null }

type Phase = Extract<SessionEvent, { t: 'progress' }>['phase']
const PHASE_VERBS: Record<Phase, string> = {
  thinking: 'thinking', writing: 'writing', tool: 'working', compacting: 'compacting the conversation', retrying: 'retrying',
}

type Layer = { el: HTMLElement; close(): void; key?(e: KeyboardEvent): boolean }
type Queued = { id: string; text: string; images: Image[] }
type ModalOptions = {
  test: string
  title: string
  cls?: string
  body: string
  tools?: string
  key?(e: KeyboardEvent): boolean
  onClose?(): void
}

const inField = (el: Element | null) =>
  !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
    || (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'button') || (el as HTMLElement).isContentEditable)

const toolState = (t: ToolRecord) => (t.state === 'run' ? 'running' : t.state === 'ok' ? 'done' : t.state === 'err' ? 'failed' : 'stopped')

export function chatScreen(): Screen {
  let ctx: Ctx
  let root: HTMLElement
  let dialogue: Dialogue
  let panels: Panels
  let asks: Asks
  let input: InputApi
  let ribbonEl: HTMLElement
  let spinnerEl: HTMLElement
  let autoBtn: HTMLElement

  // Session state. `epoch` tags every session event; anything from an older start is dropped. Epochs grow
  // across page loads too: after a webview reload the sidecar still reports the old page's session ending.
  let epoch = 0
  let live = false
  let ready = false
  let ended = false
  let running = false
  let visible = false
  let cwd = ''
  let title = ''
  let sessionId: string | undefined
  let commands: Command[] = []
  let models: ModelChoice[] = []
  let stats: Stats | undefined
  /** The model as the CLI reports it (resolved id) or as last picked (alias). */
  let model: string | undefined
  let mode: PermissionModeName = 'default'
  let autoSeen = false
  let affection = 0
  let basePlayMs = 0
  let startedAt = 0
  let turnStart = 0
  let outTokens = 0
  let phase: Phase = 'thinking'
  let note: string | undefined
  let lastLine = ''
  let authFailed = false
  /** The error reported during this turn (or right before a crash), so turn_end and ended don't repeat it. */
  let lastError: string | undefined
  let linkDropped = false
  let queued: Queued[] = []
  let queueSeq = 0
  let auto = false
  let skipTimer: number | undefined
  const tools = new Map<string, ToolRecord>()
  const log: LogEntry[] = []
  const layers: Layer[] = []
  let logView: { el: HTMLElement; add(e: LogEntry): void; refresh(e: LogEntry): void } | undefined
  /** A finished turn waiting for its stats, so the save records the new turn count. */
  let pendingSave: number | undefined

  const settings = () => ctx.store.get()
  const charName = () => settings().waifu.name
  const names = () => ({ char: charName(), user: settings().profile.displayName })
  const playMs = () => basePlayMs + (startedAt ? Date.now() - startedAt : 0)
  const gesture = (g: Gesture) => settings().motion.gestures && ctx.character.gesture(g)
  const placeholder = () => (running
    ? `${charName()} is working… (Enter queues · Esc interrupts)`
    : `Speak to ${charName()}…  ( / commands · @ files · ! shell )`)
  const nextEpoch = () => (epoch = Math.max(epoch + 1, Date.now()))

  const pager = createPager({
    page: (p) => dialogue.push({ kind: 'char', text: p.text, collapsed: p.collapsed }),
    message(full) {
      addLog({ who: 'char', text: full })
      lastLine = clipLine(full)
    },
    emote: (e) => ctx.character.emote(e),
  })

  function clipLine(text: string) {
    const last = text.split(/\n\s*\n/).at(-1)!.replace(/\s+/g, ' ').trim()
    return last.length > LAST_LINE_CHARS ? `${last.slice(0, LAST_LINE_CHARS - 1)}…` : last
  }

  // ---------------------------------------------------------------- layers (overlays and menus)

  function pushLayer(layer: Layer) {
    layers.push(layer)
    // Later layers stack above earlier ones, whatever their DOM order.
    layer.el.style.zIndex = String(LAYER_Z_BASE + layers.length)
  }

  function dropLayer(el: HTMLElement) {
    const i = layers.findIndex((l) => l.el === el)
    if (i >= 0) layers.splice(i, 1)
    if (!layers.length && visible) input.focus()
  }

  function closeAllLayers() {
    for (const l of [...layers].reverse()) if (l.el !== asksRoot()) l.close()
  }

  const asksRoot = () => root.querySelector<HTMLElement>('.chat-ask')!

  function modal(o: ModalOptions) {
    const el = document.createElement('div')
    el.className = 'overlay show chat-modal'
    el.dataset.test = o.test
    el.innerHTML = `<div class="modal ${o.cls ?? ''}"><header><h2>${esc(o.title)}</h2><div class="mtools">${o.tools ?? ''}</div>`
      + `<button class="btn close" type="button">Close · Esc</button></header><div class="mbody">${o.body}</div></div>`
    root.append(el)
    const close = () => {
      el.remove()
      dropLayer(el)
      o.onClose?.()
    }
    el.addEventListener('mousedown', (e) => e.target === el && close())
    el.querySelector<HTMLElement>('.close')!.onclick = close
    pushLayer({ el, close, key: o.key })
    return { el, close }
  }

  /** ↑↓ between the picker's items; Enter clicks the focused one natively. */
  const listKeys = (el: HTMLElement) => (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return false
    const items = [...el.querySelectorAll<HTMLElement>('.pick')]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const step = e.key === 'ArrowDown' ? 1 : -1
    items[at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length]?.focus()
    return true
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      ctx.toast('Copied')
    } catch {
      ctx.toast('Could not copy to the clipboard')
    }
  }

  // ---------------------------------------------------------------- backlog / LOG (R23)

  function entryText(e: LogEntry) {
    if (e.who === 'tool') {
      const t = e.tool
      return `${toolLabel(t.name)} ${t.detail}\n\nInput:\n${t.input}\n\nOutput:\n${t.output ?? ''}`
    }
    if (e.who === 'shell') return `$ ${e.command}\n${e.output}`
    return e.text
  }

  function addLog(e: LogEntry) {
    log.push(e)
    logView?.add(e)
  }

  function refreshLog(e: LogEntry) {
    logView?.refresh(e)
  }

  function entryHtml(e: LogEntry) {
    const n = names()
    const who = e.who === 'char' ? esc(n.char) : e.who === 'user' ? esc(n.user)
      : e.who === 'tool' ? toolIcon(e.tool.name) : e.who === 'shell' ? '$' : ''
    let body: string
    if (e.who === 'tool') {
      const t = e.tool
      body = `<details><summary><b>${esc(toolLabel(t.name))}</b> <code>${esc(oneLine(t.detail, LOG_DETAIL_CHARS))}</code>`
        + ` <em class="${t.state}">${toolState(t)}</em></summary>`
        + (t.input ? `<div class="k">Input</div><pre>${esc(t.input)}</pre>` : '')
        + (t.output !== undefined ? `<div class="k">Output</div><pre>${esc(t.output) || '(empty)'}</pre>` : '')
        + '</details>'
    } else if (e.who === 'shell') {
      body = `<details open><summary><code>${esc(e.command)}</code> <em>${e.code === null ? 'killed' : `exit ${e.code}`}</em></summary>`
        + `<pre>${esc(e.output) || '(no output)'}</pre></details>`
    } else if (e.who === 'system') {
      body = e.text.includes('\n') ? `<pre>${esc(e.text)}</pre>` : esc(e.text)
    } else if (e.who === 'error') {
      body = `✖ ${esc(e.text)}`
    } else {
      body = markdown(e.text)
    }
    return `<div class="who">${who}</div><div class="body">${body}</div><button class="copy" type="button" title="Copy">⧉</button>`
  }

  function openLog() {
    if (logView) return void layers.find((l) => l.el === logView!.el)?.close()
    const m = modal({
      test: 'log',
      title: 'Backlog',
      cls: 'wide',
      tools: '<input class="field search" data-test="log-search" placeholder="Search the log…" spellcheck="false">'
        + '<button class="btn copyall" type="button">Copy all</button>',
      body: '<div class="log"></div>',
      onClose: () => (logView = undefined),
    })
    const list = m.el.querySelector<HTMLElement>('.log')!
    const search = m.el.querySelector<HTMLInputElement>('.search')!
    const els = new Map<LogEntry, HTMLElement>()
    const matches = (e: LogEntry) => {
      const q = search.value.trim().toLowerCase()
      return !q || entryText(e).toLowerCase().includes(q)
    }
    const build = (e: LogEntry) => {
      const el = document.createElement('div')
      el.className = `e ${e.who}${e.who === 'tool' && e.tool.sub ? ' sub' : ''}`
      el.dataset.test = 'log-entry'
      el.dataset.who = e.who
      el.innerHTML = entryHtml(e)
      el.querySelector<HTMLElement>('.copy')!.onclick = () => void copy(entryText(e))
      els.set(e, el)
      return el
    }
    const render = () => {
      els.clear()
      list.replaceChildren(...log.filter(matches).map(build))
      list.scrollTop = list.scrollHeight
    }
    search.addEventListener('input', render)
    m.el.querySelector<HTMLElement>('.copyall')!.onclick = () => void copy(log.filter(matches).map((e) => {
      const n = names()
      const who = e.who === 'char' ? n.char : e.who === 'user' ? n.user : e.who
      return `[${who}] ${entryText(e)}`
    }).join('\n\n'))
    logView = {
      el: m.el,
      add(e) {
        if (!matches(e)) return
        const stick = list.scrollHeight - list.scrollTop - list.clientHeight < LOG_STICK_PX
        list.append(build(e))
        if (stick) list.scrollTop = list.scrollHeight
      },
      refresh(e) {
        const old = els.get(e)
        if (!old) return
        const open = old.querySelector('details')?.open
        old.replaceWith(build(e))
        if (open) els.get(e)!.querySelector('details')!.open = true
      },
    }
    render()
    search.focus()
  }

  // ---------------------------------------------------------------- pickers, details, help

  function openModels() {
    if (!models.length) return ctx.toast(`${charName()} is still getting ready…`)
    const current = model
    const body = `<div class="picks">${models.map((m) => {
      const on = !!current && (m.value === current || m.resolved === current)
      return `<button type="button" class="pick${on ? ' on' : ''}" data-test="model-item" data-v="${esc(m.value)}">`
        + `<b>${esc(m.displayName)}</b><span>${esc(m.description || m.value)}</span><code>${esc(m.value)}</code></button>`
    }).join('')}</div>`
    const m = modal({ test: 'model-picker', title: 'Model', body, key: (e) => listKeys(m.el)(e) })
    m.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('.pick')
      if (!b) return
      m.close()
      setModel(b.dataset.v!)
    })
    ;(m.el.querySelector<HTMLElement>('.pick.on') ?? m.el.querySelector<HTMLElement>('.pick'))?.focus()
  }

  function setModel(id: string) {
    ctx.link.send({ t: 'model', model: id })
    model = id
    panels.model(id)
    ctx.toast(`${charName()} will think with ${panels.modelName(id)}`)
  }

  function openCostumes() {
    const list = ctx.character.costumes()
    const current = settings().appearance.costume
    const item = (c: { id: string; label: string }) =>
      `<button type="button" class="pick${c.id === current ? ' on' : ''}" data-test="costume-item" data-id="${esc(c.id)}">`
        + `<b>${esc(c.label)}</b><code>${esc(c.id)}</code></button>`
    const body = list.length
      ? `<div class="picks grid">${list.map(item).join('')}</div>`
      : '<p class="empty">No costumes were found in your models folder.</p>'
        + '<button class="btn primary to-settings" type="button">Open Settings</button>'
    // Docked to the side without dimming, so she stays in view while you choose.
    const m = modal({ test: 'costume-picker', title: `${charName()}'s wardrobe`, cls: 'side', body, key: (e) => listKeys(m.el)(e) })
    m.el.querySelector<HTMLElement>('.to-settings')?.addEventListener('click', () => (m.close(), ctx.router.go('settings')))
    m.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('.pick')
      if (!b) return
      m.close()
      void wear(b.dataset.id!)
    })
    ;(m.el.querySelector<HTMLElement>('.pick.on') ?? m.el.querySelector<HTMLElement>('.pick'))?.focus()
  }

  async function wear(id: string) {
    if (id === settings().appearance.costume) return
    // Swap first, so a settings subscriber sees the model already matching and does not load it twice.
    try {
      await ctx.character.setCostume(id)
    } catch {
      return ctx.toast(`${charName()} couldn't change into that costume`)
    }
    ctx.store.update((s) => void (s.appearance.costume = id))
    gesture('costume')
    void saveMeta(false)
  }

  function openAction(id: string) {
    const t = tools.get(id)
    if (!t) return
    const state = toolState(t)
    const copyBtn = (which: string) => `<button class="btn mini" type="button" data-copy="${which}">Copy</button>`
    const body = `<div class="detail">
      <div class="dhead"><span class="ai">${toolIcon(t.name)}</span><b>${esc(toolLabel(t.name))}</b>
        <em class="${t.state}">${state[0].toUpperCase()}${state.slice(1)}</em></div>
      ${t.detail ? `<pre class="dline">${esc(t.detail)}</pre>` : ''}
      <div class="k">Input ${copyBtn('input')}</div><pre>${esc(t.input) || '(none)'}</pre>
      <div class="k">Output ${copyBtn('output')}</div>
      <pre>${t.output === undefined ? '(still running)' : esc(t.output) || '(empty)'}</pre>
    </div>`
    const m = modal({ test: 'action-detail', title: 'Action', cls: 'wide', body })
    m.el.addEventListener('click', (e) => {
      const which = (e.target as HTMLElement).closest<HTMLElement>('[data-copy]')?.dataset.copy
      if (which) void copy(which === 'input' ? t.input : t.output ?? '')
    })
  }

  function openHelp() {
    const keys: [string, string][] = [
      ['Enter', 'Send (queues while she works)'], ['Shift+Enter', 'New line'], ['↑ / ↓', 'Input history'],
      ['/', 'Commands'], ['@', 'Mention a file'], ['!', 'Run a shell command'], ['Esc', 'Close a menu · interrupt'],
      ['Shift+Tab', 'Cycle permission mode'], ['Ctrl+L · Ctrl+O', 'Backlog (the full trace)'], ['Click · Space · Enter', 'Next page'],
      ['Hold Ctrl', 'Skip dialogue'], ['1–9 · ↑↓ · Enter', 'Answer a choice menu'],
    ]
    const app: [string, string][] = [
      ['/model', 'Pick the model'], ['/clear', 'Start fresh in this folder'], ['/resume', 'Load another save'],
      ['/config', 'Settings'], ['/costume', 'Change her costume'], ['/login', 'Log in to Claude'], ['/help', 'This page'],
      ['/exit', 'Back to the title'],
    ]
    const row = ([k, v]: [string, string]) => `<div class="hk"><kbd>${esc(k)}</kbd><span>${esc(v)}</span></div>`
    const cli = commands.length ? commands.map((c) => row([`/${c.name}`, c.description])).join('') : '<p class="empty">Loading…</p>'
    const body = `<div class="help">
      <section><h3>Keys</h3>${keys.map(row).join('')}</section>
      <section><h3>App commands</h3>${app.map(row).join('')}<h3>Claude Code commands</h3>${cli}</section>
    </div>`
    modal({ test: 'help', title: 'Help', cls: 'wide', body })
  }

  // ---------------------------------------------------------------- status: ribbon and spinner (R18)

  function updateRibbon() {
    const live = [...tools.values()].reverse()
    const t = live.find((x) => x.state === 'run' && !x.sub) ?? live.find((x) => x.state === 'run')
    ribbonEl.classList.toggle('show', !!t && running)
    if (t) ribbonEl.innerHTML = doing(charName(), t.name, t.detail)
  }

  function updateSpinner() {
    spinnerEl.classList.toggle('show', running)
    if (!running) return
    const secs = Math.floor((Date.now() - turnStart) / 1000)
    const verb = asks.isOpen() ? 'waiting for your answer' : PHASE_VERBS[phase]
    const extra = note ? ` · ${esc(note)}` : ''
    spinnerEl.innerHTML = `<b>${esc(charName())} is ${verb}…</b> <span>${secs}s · ↑ ${fmtK(outTokens)} tokens${extra}</span>`
  }

  function setRunning(on: boolean) {
    if (running === on) return
    running = on
    ctx.character.setBusy(on)
    if (on) {
      turnStart = Date.now()
      outTokens = 0
      phase = 'thinking'
      note = undefined
      lastError = undefined
    }
    if (ready && !ended) input.setEnabled(true, placeholder())
    updateSpinner()
    updateRibbon()
  }

  // ---------------------------------------------------------------- sending, queue, interrupt (R11, R12)

  function renderQueue() {
    input.setQueued(queued.map(({ id, text }) => ({ id, text })), (id) => {
      queued = queued.filter((q) => q.id !== id)
      renderQueue()
    })
  }

  function userPage(text: string): DisplayPage {
    const pages = pagesForText(text)
    const first = pages[0] ?? { text, collapsed: false }
    const more = pages.length > 1 && !first.collapsed
    return { kind: 'user', text: more ? `${first.text} …` : first.text, collapsed: first.collapsed || more }
  }

  /** A queued message waits behind her unread pages; one you just typed replaces them, as a reply does. */
  function say(text: string, images: Image[], fromQueue = false) {
    ctx.link.send({ t: 'say', text, images: images.length ? images : undefined })
    const pics = images.map((_, i) => ` [Image #${i + 1}]`).join('')
    addLog({ who: 'user', text: text + pics })
    const page = userPage((text || '(image)') + pics)
    if (fromQueue) dialogue.push(page)
    else dialogue.show(page)
    setRunning(true)
  }

  function sendNext() {
    const next = queued.shift()
    renderQueue()
    if (next) say(next.text, next.images, true)
  }

  function restoreQueue() {
    if (!queued.length) return false
    input.restore(queued.map((q) => q.text).join('\n'))
    queued = []
    renderQueue()
    return true
  }

  function interrupt() {
    if (!running) return false
    ctx.link.send({ t: 'interrupt' })
    // Like the CLI, messages typed during the turn come back to the input instead of running.
    restoreQueue()
    return true
  }

  function cycleMode() {
    if (!live || ended) return
    const cycle = autoSeen || settings().claude.permissionMode === 'auto' ? [...BASE_CYCLE, 'auto' as const] : BASE_CYCLE
    const next = cycle[(cycle.indexOf(mode) + 1) % cycle.length]
    mode = next
    panels.mode(next)
    ctx.link.send({ t: 'mode', mode: next })
    ctx.toast(`Permission mode · ${MODE_LABELS[next]}`)
  }

  function openSlash() {
    input.focus()
    const ta = root.querySelector<HTMLTextAreaElement>('[data-test="chat-input"]')
    // Never clobber a draft; on an empty composer, type "/" so its picker opens as if typed by hand.
    if (!ta || ta.value || ta.disabled) return
    input.restore('/')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  }

  // ---------------------------------------------------------------- lifecycle

  function start(o: { cwd: string; resume?: string; title?: string }) {
    nextEpoch()
    live = true
    ready = false
    ended = false
    authFailed = false
    lastError = undefined
    linkDropped = false
    cwd = o.cwd
    title = o.title ?? ''
    sessionId = o.resume
    commands = []
    models = []
    stats = undefined
    model = undefined
    mode = settings().claude.permissionMode
    autoSeen = mode === 'auto'
    affection = 0
    basePlayMs = 0
    startedAt = 0
    lastLine = ''
    queued = []
    tools.clear()
    log.length = 0
    pager.reset()
    asks.clear()
    closeAllLayers()
    running = false
    ctx.character.setBusy(false)
    ctx.character.setPlacement('chat')
    panels.reset({ title: title || `A new day with ${charName()}`, cwd, cwdShort: cwd })
    panels.identity(settings())
    panels.hearts(0)
    panels.mode(mode)
    renderQueue()
    updateSpinner()
    updateRibbon()
    dialogue.show({ kind: 'narration', text: `${charName()} is getting ready…` })
    input.setEnabled(false, `${charName()} is getting ready…`)
    ctx.link.send({ t: 'start', epoch, cwd: o.cwd, resume: o.resume })
  }

  function restart() {
    start({ cwd, resume: sessionId, title })
  }

  async function saveMeta(withThumb: boolean) {
    clearTimeout(pendingSave)
    pendingSave = undefined
    const id = sessionId
    if (!id) return
    // Before the first stats of a resumed save the turn count is unknown, so the saved one stays.
    const patch = {
      playMs: playMs(),
      affection,
      costume: settings().appearance.costume,
      ...(stats && { turns: stats.turns }),
      ...(lastLine && { lastLine }),
    }
    const thumb = withThumb ? await ctx.character.snapshot(THUMB_W, THUMB_H).catch(() => undefined) : undefined
    ctx.link.send({ t: 'save_meta', id, patch, thumb })
  }

  /** Saves a finished turn once its stats are in (they follow turn_end), or after STATS_WAIT_MS without them. */
  function saveAfterStats() {
    clearTimeout(pendingSave)
    pendingSave = window.setTimeout(flushSave, STATS_WAIT_MS)
  }

  function flushSave() {
    if (pendingSave === undefined) return
    clearTimeout(pendingSave)
    pendingSave = undefined
    void saveMeta(true)
  }

  async function leave(to: 'title' | 'saves') {
    if (live && running) {
      const why = `${charName()} is still working. Leaving stops the current turn.`
      if (!(await ctx.confirm('Leave this session?', why, 'Leave', 'Stay'))) return
    }
    if (live) {
      await saveMeta(true)
      ctx.link.send({ t: 'end' })
    }
    live = false
    nextEpoch()
    // Whatever she was saying ends quietly, so no last face plays over the title screen.
    dialogue.setMuted(true)
    setRunning(false)
    asks.clear()
    closeAllLayers()
    ctx.router.go(to)
  }

  async function clearSession() {
    const yes = await ctx.confirm(
      'Start fresh?',
      `${charName()} starts a new conversation in this folder. This one stays on disk, and /resume brings it back.`,
      'Start fresh',
      'Cancel',
    )
    if (!yes) return
    await saveMeta(true)
    start({ cwd })
  }

  // ---------------------------------------------------------------- session events

  function onStarted(m: Extract<SessionEvent, { t: 'started' }>) {
    cwd = m.cwd
    title = m.save?.title || title
    affection = Math.min(MAX_HEARTS, m.save?.affection ?? 0)
    basePlayMs = m.save?.playMs ?? 0
    startedAt = Date.now()
    panels.reset({ title: title || `A new day with ${charName()}`, cwd: m.cwd, cwdShort: m.cwdShort })
    panels.hearts(affection)
    panels.mode(mode)
    for (const [i, h] of m.history.entries()) addLog(fromHistory(h, i))
    const last = [...m.history].reverse().find((h): h is Extract<HistoryEntry, { who: 'char' | 'user' }> => h.who === 'char')
    if (last) {
      const pages = pagesForText(last.text)
      const page = pages.at(-1)!
      lastLine = clipLine(cleanText(last.text))
      // Showing the page plays its last face; a face from an earlier page of that line plays here instead.
      dialogue.show({ kind: 'char', text: page.text, collapsed: page.collapsed || pages.length > 1 })
      const face = lastEmotion(page.text) ? undefined : lastEmotion(last.text)
      if (face) ctx.character.emote(face)
    } else {
      const s = settings()
      dialogue.show({ kind: 'narration', text: `${s.waifu.name} is ready in \`${m.cwdShort}\`. What shall we do today, ${addressOf(s)}?` })
    }
    gesture('greet')
  }

  function fromHistory(h: HistoryEntry, i: number): LogEntry {
    if (h.who !== 'tool') return h.who === 'system' ? { who: 'system', text: h.text } : { who: h.who, text: cleanText(h.text) }
    return {
      who: 'tool',
      tool: {
        id: `history-${i}`, name: h.name, detail: h.detail, input: '', sub: false, output: h.output, state: h.ok === false ? 'err' : 'ok',
      },
    }
  }

  function onTurnEnd(m: Extract<SessionEvent, { t: 'turn_end' }>) {
    pager.end()
    setRunning(false)
    for (const t of tools.values()) {
      if (t.state !== 'run') continue
      t.state = 'stopped'
      panels.tool(t)
      refreshLog(log.find((e) => e.who === 'tool' && e.tool === t)!)
    }
    updateRibbon()
    if (m.interrupted) {
      // The user stopped her: not a failure, no sad face (R12). What she had not finished saying is in the LOG.
      gesture('interrupt')
      dialogue.show({ kind: 'narration', text: `Interrupted · What should ${charName()} do instead?` })
      addLog({ who: 'system', text: 'Interrupted by you' })
      // However the turn was stopped (Esc, STOP, or No on a permission), queued messages come back to the input.
      restoreQueue()
    } else if (m.ok) {
      if (affection < MAX_HEARTS) panels.hearts(++affection, true)
      if (m.seconds >= SUCCESS_MIN_SECONDS) gesture('success')
    } else {
      const error = m.error || 'The turn failed'
      // The error event already said it (and an auth failure keeps its Log in page), so it isn't repeated.
      if (!lastError && !authFailed) {
        gesture('fail')
        dialogue.push({ kind: 'error', text: `✖ ${error}` })
      }
      if (error !== lastError) addLog({ who: 'error', text: error })
    }
    lastError = undefined
    saveAfterStats()
    if (!m.interrupted) sendNext()
  }

  function onError(m: Extract<SessionEvent, { t: 'error' }>) {
    addLog({ who: 'error', text: m.message })
    lastError = m.message
    if (m.kind === 'auth') {
      authFailed = true
      gesture('fail')
      return dialogue.show({
        kind: 'error',
        text: `${charName()} can't reach Claude: ${m.message}`,
        actions: [{ label: 'Log in', v: 'login', run: () => ctx.link.send({ t: 'login' }) }],
      })
    }
    if (m.kind !== 'internal') gesture('fail')
    dialogue.push({ kind: 'error', text: `✖ ${m.message}` })
  }

  function onEnded(m: Extract<SessionEvent, { t: 'ended' }>) {
    ended = true
    setRunning(false)
    asks.clear()
    for (const t of tools.values()) if (t.state === 'run') (t.state = 'stopped'), panels.tool(t)
    updateRibbon()
    input.setEnabled(false, 'The session has ended · restart it to continue')
    const text = m.reason === 'crashed' ? 'The Claude Code session stopped unexpectedly.' : 'The Claude Code session was closed.'
    addLog({ who: 'error', text })
    // The reason (already in the LOG) stays on the page that replaces its error page.
    const why = m.reason === 'crashed' && lastError ? `\n${lastError}` : ''
    lastError = undefined
    dialogue.show({ kind: 'error', text: text + why, actions: [{ label: 'Restart session', v: 'restart', run: restart }] })
  }

  function onTool(m: Extract<SessionEvent, { t: 'tool' }>) {
    const t: ToolRecord = { id: m.id, name: m.name, detail: m.detail, input: m.input, sub: m.sub, state: 'run' }
    tools.set(m.id, t)
    panels.tool(t)
    addLog({ who: 'tool', tool: t })
    if (!m.sub) phase = 'tool'
    updateRibbon()
    updateSpinner()
  }

  function onToolDone(m: Extract<SessionEvent, { t: 'tool_done' }>) {
    const t = tools.get(m.id)
    if (!t) return
    t.state = m.ok ? 'ok' : 'err'
    t.output = m.output
    panels.tool(t)
    refreshLog(log.find((e) => e.who === 'tool' && e.tool === t)!)
    if (m.ok && isShell(t.name) && /\bgit\s+push\b/.test(t.detail)) gesture('push')
    updateRibbon()
  }

  function onNotice(m: Extract<SessionEvent, { t: 'notice' }>) {
    addLog({ who: 'system', text: m.text })
    if (m.kind === 'retry') {
      note = oneLine(m.text, RETRY_NOTE_CHARS)
      return updateSpinner()
    }
    if (m.kind === 'command') {
      const page = pagesForMono(m.text)[0]
      return dialogue.push({ kind: 'system', mono: true, text: page.text, collapsed: page.collapsed })
    }
    dialogue.push({ kind: 'narration', text: m.text })
  }

  function onShell(m: Extract<SessionEvent, { t: 'shell_result' }>) {
    const output = m.output.replace(/\s+$/, '')
    addLog({ who: 'shell', command: m.command, output, code: m.code })
    const page = pagesForMono(`$ ${m.command}\n${output || '(no output)'}`)[0]
    dialogue.push({ kind: 'system', mono: true, text: page.text, collapsed: page.collapsed })
  }

  function onSession(m: SessionEvent) {
    switch (m.t) {
      case 'started': return onStarted(m)
      case 'ready':
        ready = true
        sessionId = m.sessionId ?? sessionId
        commands = m.commands
        models = m.models
        mode = m.mode
        autoSeen ||= m.mode === 'auto'
        model = m.model ?? stats?.model ?? model
        panels.models(m.models)
        panels.model(model)
        panels.mode(m.mode)
        input.setEnabled(true, placeholder())
        if (visible && !layers.length) input.focus()
        // Messages typed while she was getting ready go out now.
        if (!running) sendNext()
        return
      case 'session_id':
        sessionId = m.sessionId
        return
      case 'commands':
        commands = m.commands
        return
      case 'face': return pager.face(m.emotion)
      case 'text':
        if (phase !== 'writing') (phase = 'writing'), updateSpinner()
        return pager.text(m.delta)
      case 'text_end': return pager.end()
      case 'progress':
        outTokens = m.outputTokens
        phase = m.phase
        note = m.note
        return updateSpinner()
      case 'tool': return onTool(m)
      case 'tool_done': return onToolDone(m)
      case 'todos': return panels.todos(m.items)
      case 'agent': return panels.agent(m)
      case 'ask_permission':
      case 'ask_question':
      case 'ask_plan':
        asks.push(m)
        if (!visible) ctx.toast(`${charName()} needs your answer in the chat`, 4000)
        return updateSpinner()
      case 'ask_cancel':
        asks.cancel(m.id)
        return updateSpinner()
      case 'state':
        if (m.state === 'running') setRunning(true)
        return updateSpinner()
      case 'stats':
        stats = m.stats
        model = m.stats.model ?? model
        if (m.stats.mode) (mode = m.stats.mode), (autoSeen ||= mode === 'auto')
        panels.stats(m.stats)
        return flushSave()
      case 'notice': return onNotice(m)
      case 'shell_result': return onShell(m)
      case 'turn_end': return onTurnEnd(m)
      case 'error': return onError(m)
      case 'ended': return onEnded(m)
    }
  }

  // ---------------------------------------------------------------- keyboard

  function stopSkip() {
    clearTimeout(skipTimer)
    skipTimer = undefined
    dialogue.setSkip(false)
  }

  /**
   * Holding Ctrl alone skips (R27). Any Ctrl combo (Ctrl+V, Ctrl+A, Ctrl+C…) cancels it before it starts,
   * and while you are typing a message (the composer has text) it never starts at all.
   */
  function armSkip(e: KeyboardEvent) {
    if (e.repeat || layers.length || skipTimer) return
    const field = inField(e.target as Element)
    if (field && (e.target as HTMLTextAreaElement).value) return
    skipTimer = window.setTimeout(() => dialogue.setSkip(true), field || fromInput(e) ? SKIP_ARM_IN_FIELD_MS : SKIP_ARM_MS)
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!visible || document.getElementById('confirm')?.classList.contains('show')) return
    if (e.key === 'Control') armSkip(e)
    else if (e.ctrlKey || e.altKey || e.metaKey) stopSkip()
    // Keys the composer or a menu already used, and Esc (main.ts routes it to onEscape).
    if (e.key === 'Escape' || e.defaultPrevented) return
    const handled = () => (e.preventDefault(), e.stopPropagation())
    const top = layers.at(-1)
    if (top?.key?.(e)) return handled()
    // Ctrl+L opens the backlog; Ctrl+O too, the CLI's key for the full transcript.
    if (e.ctrlKey && !e.shiftKey && !e.altKey && ['l', 'o'].includes(e.key.toLowerCase())) return void (handled(), openLog())
    if (top) return
    if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.altKey) return void (handled(), cycleMode())
    const target = e.target as HTMLElement
    // Ctrl+C interrupts her, as in the CLI. While the composer has text it is the composer's (copy, or clear the
    // draft), and a selection anywhere else is copied instead.
    const ctrlC = e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyC'
    const typing = inField(target) && !!(target as HTMLInputElement).value
    if (ctrlC && !typing && !getSelection()?.toString() && interrupt()) return void handled()
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey
    if ((e.key === ' ' || e.key === 'Enter') && plain && !inField(target) && !fromInput(e) && target.tagName !== 'BUTTON') {
      handled()
      dialogue.advance()
    }
  }

  // ---------------------------------------------------------------- the screen

  return {
    mount(el, c) {
      root = el
      ctx = c
      root.classList.add('chat')
      root.innerHTML = `
        <aside class="panel chat-left"></aside>
        <aside class="panel chat-right"></aside>
        <div class="chat-status"><div class="ribbon" data-test="ribbon"></div><div class="spinner" data-test="spinner"></div></div>
        <div class="dialogue" data-test="dialogue"></div>
        <div class="chat-input"></div>
        <div class="chat-ask"></div>`
      ribbonEl = root.querySelector('.ribbon')!
      spinnerEl = root.querySelector('.spinner')!
      const dlgEl = root.querySelector<HTMLElement>('.dialogue')!
      dialogue = createDialogue(dlgEl, { store: ctx.store, character: ctx.character, names, openLog })
      const qm = document.createElement('nav')
      qm.className = 'quickmenu'
      qm.innerHTML = [
        ['log', 'LOG', 'Backlog (Ctrl+L)'], ['auto', 'AUTO', 'Auto-advance'], ['mode', 'MODE', 'Permission mode (Shift+Tab)'],
        ['cmd', 'CMD', 'Commands (/)'], ['stop', 'STOP', 'Interrupt (Esc)'], ['costume', '👗', 'Costume (/costume)'],
        ['settings', '⚙', 'Settings (/config)'], ['menu', 'MENU', 'Back to the title'],
      ].map(([id, label, tip]) => `<button type="button" data-test="qm-${id}" title="${tip}">${label}</button>`).join('')
      dlgEl.append(qm)
      autoBtn = qm.querySelector('[data-test="qm-auto"]')!
      const qmActions: Record<string, () => void> = {
        log: openLog,
        auto() {
          auto = !auto
          autoBtn.classList.toggle('on', auto)
          dialogue.setAuto(auto)
        },
        mode: cycleMode,
        cmd: openSlash,
        stop: () => void (interrupt() || ctx.toast(`${charName()} isn't working on anything right now`)),
        costume: openCostumes,
        settings: () => ctx.router.go('settings'),
        menu: () => void leave('title'),
      }
      qm.addEventListener('click', (e) => {
        e.stopPropagation()
        const id = (e.target as HTMLElement).closest<HTMLElement>('button')?.dataset.test?.slice(3)
        if (id) qmActions[id]?.()
      })
      // Clicking the box or its buttons leaves the focus in the composer: typing goes on there, and a later
      // Enter or Space never presses AUTO or Restart again.
      dlgEl.addEventListener('mousedown', (e) => (e.target as HTMLElement).closest('button') && e.preventDefault())
      dlgEl.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('button, a, details') || getSelection()?.toString()) return
        dialogue.advance()
        if (!layers.length) input.focus()
      })

      panels = createPanels(root.querySelector('.chat-left')!, root.querySelector('.chat-right')!, { openModels, cycleMode, openAction })
      asks = createAsks(asksRoot(), {
        ctx,
        name: charName,
        log: (line) => addLog({ who: 'system', text: line }),
        gesture,
        markdown,
        onChange(open) {
          const el = asksRoot()
          const has = layers.some((l) => l.el === el)
          if (open && !has) pushLayer({ el, close: () => asks.escape(), key: (e) => asks.key(e) })
          if (!open && has) dropLayer(el)
          updateSpinner()
        },
      })

      const host: InputHost = {
        ctx,
        commands: () => commands,
        cwd: () => cwd,
        busy: () => running,
        submit(text, images) {
          if (!live || ended) {
            input.restore(text)
            const pics = images.length ? ` · attach your image${images.length > 1 ? 's' : ''} again after` : ''
            return ctx.toast(`The session has ended · restart it first${pics}`)
          }
          // Like the CLI, a message typed while she works (or before she is ready) waits for the next turn.
          if (running || !ready) {
            queued.push({ id: String(++queueSeq), text, images })
            return renderQueue()
          }
          say(text, images)
        },
        shell(command) {
          if (!live || ended || !ready) {
            input.restore(`!${command}`)
            return ctx.toast(`${charName()} is not ready yet`)
          }
          ctx.link.send({ t: 'shell', command })
          addLog({ who: 'user', text: `!${command}` })
          // Queued behind anything unread, so her pages are not thrown away.
          dialogue.push({ kind: 'narration', text: `Running \`${oneLine(command, SHELL_NARRATION_CHARS)}\`…` })
        },
        local(name, args) {
          switch (name) {
            case 'model':
              if (args.trim()) setModel(args.trim())
              else openModels()
              return true
            case 'clear':
            case 'reset':
            case 'new':
              void clearSession()
              return true
            case 'resume':
              void leave('saves')
              return true
            case 'config':
            case 'settings':
              ctx.router.go('settings')
              return true
            case 'costume':
              openCostumes()
              return true
            case 'help':
              openHelp()
              return true
            case 'exit':
            case 'quit':
              void leave('title')
              return true
            case 'login':
              ctx.link.send({ t: 'login' })
              ctx.toast('Opening the Claude Code login…')
              return true
          }
          return false
        },
        advance: () => dialogue.advance(),
      }
      input = createInput(root.querySelector('.chat-input')!, host)
      input.setEnabled(false, `${charName()} is getting ready…`)

      ctx.link.on((m) => {
        if (m.t === 'auth') {
          if (live && authFailed && m.auth.loggedIn) {
            authFailed = false
            // Replaces the Log in page, which would otherwise hold this one back.
            dialogue.show({
              kind: 'narration',
              text: `Logged in${m.auth.email ? ` as ${m.auth.email}` : ''}. Restart the session so ${charName()} can reach Claude.`,
              actions: [{ label: 'Restart session', v: 'restart', run: restart }],
            })
          }
          return
        }
        if ('epoch' in m && m.epoch === epoch && live) onSession(m)
      })
      // A dropped link means the sidecar restarted, and the session went with it (R24).
      ctx.link.onStatus((s) => {
        if (s === 'down') return void (linkDropped = live && !ended)
        if (!linkDropped || !live || ended) return
        linkDropped = false
        onEnded({ t: 'ended', reason: 'crashed' })
      })
      ctx.store.subscribe((s) => {
        panels.identity(s)
        updateRibbon()
        updateSpinner()
      })

      // Bubble phase: the composer and the menus handle their keys first and preventDefault what they used.
      addEventListener('keydown', onKeyDown)
      addEventListener('keyup', (e) => e.key === 'Control' && stopSkip(), true)
      addEventListener('blur', stopSkip)
      setInterval(() => {
        if (!live) return
        panels.tick(playMs())
        if (running) updateSpinner()
      }, TICK_MS)
    },

    show(params) {
      visible = true
      dialogue.setMuted(false)
      ctx.character.setPlacement('chat')
      const p = params as ChatParams | undefined
      if (p?.cwd) return start({ cwd: p.cwd, resume: p.resume, title: p.title })
      // Back from Settings: the session is still running.
      if (!live) return ctx.router.go('title')
      panels.identity(settings())
      if (!layers.length) input.focus()
    },

    hide() {
      visible = false
      stopSkip()
      // Pages that keep streaming while Settings is open land silently, so her face and mouth stay still there.
      dialogue.setMuted(true)
    },

    onEscape() {
      if (input.closePopups()) return true
      const top = layers.at(-1)
      if (top) return top.close(), true
      if (interrupt()) return true
      return restoreQueue()
    },
  }
}
