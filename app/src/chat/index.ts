// The chat screen: a Claude Code session played as a visual novel (R10–R30). It owns the session
// lifecycle and wires the link's events to the dialogue, the panels, the choice menus and the input.

import { getCurrentWindow, UserAttentionType } from '@tauri-apps/api/window'
import type { BgTask, Command, HistoryEntry, Image, ModelChoice, PermissionModeName, ServerMsg, SessionEvent, Stats } from '../../../link/src/protocol.ts'
import { AFFECTION_LEVELS, clampPoints, levelOf, levelStart, type Mood } from '../../../link/src/affection.ts'
import type { ChatParams, Ctx, Gesture, Screen } from '../contracts'
import { addressOf } from '../screens/title'
import { esc, fmtK } from '../ui'
import { createAsks, type Asks } from './asks'
import { APP_COMMANDS, findAppCommand, runCli, type CommandHost } from './commands'
import { openPalette, openShortcuts } from './commands/palette'
import { slackCommand } from './commands/slack'
import { phoneTutorial } from './tutorial'
import { control } from './control'
import { doneVerb, duration, pickVerb, SPINNER_VERBS, thinkingStatus, verbList, type SpinnerVerbs } from './spinner'
import './chat.css'
import {
  cleanText, createDialogue, createPager, lastEmotion, markdown, pagesForMono, pagesForText, type Dialogue, type DisplayPage, type VoiceLine,
} from './dialogue'
import { createInput, fromInput, type InputApi, type InputHost } from './input'
import {
  createPanels, doing, isShell, MODE_LABELS, oneLine, toolIcon, toolLabel, type Panels, type ToolRecord,
} from './panels'

/** A finished turn this long earns her "success" gesture. */
const SUCCESS_MIN_SECONDS = 20
/** Remembers Focus mode across launches. */
const FOCUS_KEY = 'wc.focus'
/** A headpat earns a point at most this often, so stroking her nonstop can't fill the hearts. */
const HEADPAT_POINT_MS = 5 * 60_000
/** With the app open this long, her next reply carries a rest reminder; then again every as long. */
const REST_EVERY_MS = 3 * 60 * 60_000
/** When the app (this page) opened: the rest reminder counts from it, across sessions. */
const APP_OPENED_AT = performance.timeOrigin
let lastRestAt = APP_OPENED_AT
/** The E2E harness shortens the rest interval through this global. */
const restEveryMs = () => (window as unknown as { __wcRestEveryMs?: number }).__wcRestEveryMs ?? REST_EVERY_MS
/** Her aside at the top of each CLI panel (menu.ts voice): one short line in her voice, never instructions. */
const PANEL_LINES: Record<string, (you: string) => string> = {
  mcp: (you) => `These are the servers that lend me their tools, ${you}.`,
  settings: (you) => `Everything Claude Code remembers about how you like to work, ${you}.`,
  model: () => 'Which mind shall I think with?',
  effort: () => 'How hard should I think before I answer?',
  fast: () => 'Faster answers, at a higher price.',
  context: (you) => `This is how full my memory of our conversation is, ${you}.`,
  permissions: () => 'What I may do without asking, and what I must never do.',
  hooks: () => 'Commands that run on their own when I use my tools.',
  memory: (you) => `The notes I read every time we start, ${you}.`,
  plugin: () => 'New tools and skills I could learn.',
  skills: () => 'The skills I know, and when I may use them.',
  tasks: () => 'Work still running in the background.',
  diff: (you) => `Everything we changed, ${you}. Leave me a note on any file.`,
  rewind: (you) => `Shall we go back to an earlier moment, ${you}?`,
  palette: () => 'Anything you need, just type it.',
  slack: (you) => `Messages from your colleagues, ${you}. Shall I answer any for you?`,
}
/** Below this much context left, she warns as the CLI does (its footer turns at 20%). */
const CONTEXT_LOW_LEFT = 20
const readFocus = () => {
  try {
    return localStorage.getItem(FOCUS_KEY) === '1'
  } catch {
    return false
  }
}
const DOUBLE_ESC_MS = 800
const THUMB_W = 320
const THUMB_H = 180
const TICK_MS = 1000
/** Holding Ctrl alone this long starts skipping (R27). Longer inside a text field, so Ctrl+V, Ctrl+A… never skip. */
const SKIP_ARM_MS = 150
const SKIP_ARM_IN_FIELD_MS = 400
const LAST_LINE_CHARS = 200
/** The stats that follow turn_end are waited for this long before the turn is saved without them. */
const STATS_WAIT_MS = 1500
const TRUST_WAIT_MS = 15_000
/** After a `!` command's output, how long to wait for her reply turn before running what was queued behind it. */
const SHELL_DRAIN_MS = 1500
/** The LOG follows new entries while you are this close to its bottom. */
const LOG_STICK_PX = 40
const LOG_DETAIL_CHARS = 140
const RETRY_NOTE_CHARS = 80
const SHELL_NARRATION_CHARS = 120
/** Overlays stack from this z-index up, in the order they opened. */
const LAYER_Z_BASE = 50
// A swipe on the text box (a phone): this far (CSS px), this quick, and mostly vertical.
const SWIPE_PX = 50
const SWIPE_MS = 700
const SWIPE_STRAIGHT = 1.5
/** The phone's panel sheet: its tabs (Slack opens the inbox instead). */
const PANEL_TABS = [['status', 'Status'], ['quests', 'Quests'], ['actions', 'Actions'], ['slack', 'Slack']] as const
type PanelTab = 'status' | 'quests' | 'actions'
/** The ⋯ sheet: what the phone's quick menu leaves out. Ids are quick-menu actions, or panel tabs. */
const MORE_ITEMS = [
  ['status', '♥', 'Status'], ['quests', '◇', 'Quests'], ['actions', '⚒', 'Actions'], ['mode', '⇄', 'Mode'],
  ['cmd', '/', 'Commands'], ['costume', '👗', 'Costume'], ['focus', '◎', 'Focus'], ['settings', '⚙', 'Settings'],
  ['menu', '⌂', 'Title'],
] as const
const BASE_CYCLE: PermissionModeName[] = ['default', 'acceptEdits', 'plan']

type LogEntry =
  | { who: 'char' | 'user' | 'system' | 'error'; text: string }
  | { who: 'tool'; tool: ToolRecord }
  | { who: 'shell'; command: string; output: string; code: number | null }

type Phase = Extract<SessionEvent, { t: 'progress' }>['phase']
const PHASE_VERBS: Record<Phase, string> = {
  thinking: 'thinking', writing: 'writing', tool: 'working', compacting: 'compacting the conversation', retrying: 'retrying',
}

/** `close` is Esc (a menu steps back first); `dismiss`, when set, closes it outright (a new session, closing all). */
type Layer = { el: HTMLElement; close(): void; dismiss?(): void; key?(e: KeyboardEvent): boolean }
/** `shell`: a `!` command, queued like the CLI queues one typed while a turn runs. */
type Queued = { id: string; text: string; images: Image[]; shell?: boolean }
type ModalOptions = {
  test: string
  title: string
  cls?: string
  body: string
  tools?: string
  key?(e: KeyboardEvent): boolean
  /** Esc steps back inside the layer (a nested menu screen) while this returns true; otherwise Esc closes it. */
  back?(): boolean
  onClose?(): void
}

/**
 * Flashes the taskbar button while the window is in the background, the desktop version of the CLI's terminal
 * bell: she needs an answer, or she finished. Only in the Tauri shell; a plain browser has no window API.
 */
function callForAttention() {
  if (document.hasFocus()) return
  try {
    getCurrentWindow().requestUserAttention(UserAttentionType.Informational).catch(() => {})
  } catch {
    // Not in Tauri (the E2E browser target, `vite` alone).
  }
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
  /** A phone's `attach` is out: the link answers with the running session's epoch, or none. */
  let attaching = false
  let live = false
  let ready = false
  let ended = false
  let running = false
  let visible = false
  let cwd = ''
  let title = ''
  let sessionId: string | undefined
  /** The first Esc of an Esc Esc (rewind). */
  let lastEscAt = 0
  /** The CLI's background tasks (shells, agents, monitors), as the last bg_tasks listed them. */
  let bgTasks: BgTask[] = []
  let commands: Command[] = []
  let models: ModelChoice[] = []
  let stats: Stats | undefined
  /** The model as the CLI reports it (resolved id) or as last picked (alias). */
  let model: string | undefined
  let mode: PermissionModeName = 'default'
  let autoSeen = false
  let bypassAvailable = false
  /** `!` commands sent and not yet answered with their output. */
  let shellsRunning = 0
  /** Affection points (link/src/affection.ts); the hearts show their level. */
  let affection = 0
  /** A voice failure was already toasted this session. */
  let voiceWarned = false
  /** The level moved since the last message she got: the next one tells her. */
  let moodChange: 'up' | 'down' | undefined
  let lastPatPointAt = 0
  let basePlayMs = 0
  let startedAt = 0
  let turnStart = 0
  let outTokens = 0
  let phase: Phase = 'thinking'
  /** When the current phase began: the thinking status escalates from it, as in the CLI. */
  let phaseStart = 0
  /** This turn's spinner verb, and the list it is picked from (the user's spinnerVerbs setting applies). */
  let turnVerb = 'Working'
  let verbs = SPINNER_VERBS
  let note: string | undefined
  /** A hook running right now, for the spinner. */
  let hookNote: string | undefined
  /** The context-low warning was given for this crossing. */
  let contextWarned = false
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
  // Focus mode keeps her still: no gestures while you work (docs/research/ux-research.md §5).
  const gesture = (g: Gesture) => settings().motion.gestures && !focusOn && ctx.character.gesture(g)
  let focusOn = readFocus()

  /**
   * Focus mode, the CLI's /focus ("just your prompt, summary, and response") in VN terms: her lines appear whole,
   * the tool ribbon and petals go, and she stays still and faded. Remembered between launches.
   */
  function setFocus(on: boolean) {
    focusOn = on
    try {
      localStorage.setItem(FOCUS_KEY, on ? '1' : '0')
    } catch {
      // Private window or blocked storage: it lasts until the app closes.
    }
    applyFocus()
    ctx.toast(on ? 'Focus mode on · just your prompt, her summary and her reply' : 'Focus mode off')
  }

  function applyFocus() {
    if (focusOn) document.documentElement.dataset.focus = '1'
    else delete document.documentElement.dataset.focus
    dialogue?.setFocus(focusOn)
    root?.querySelector('[data-test="qm-focus"]')?.classList.toggle('on', focusOn)
  }
  const placeholder = () => (running
    ? `${charName()} is working… (Enter queues · Esc interrupts)`
    : `Speak to ${charName()}…  ( / commands · @ files · ! shell )`)
  const nextEpoch = () => (epoch = Math.max(epoch + 1, Date.now()))

  const pager = createPager({
    page(p) {
      // Asked for as soon as the paragraph is complete, so the clip is usually there when its page shows.
      if (p.voice && ctx.voice.active()) p.voice.line.clip ??= voiceClip(p.voice.line)
      // A getter: a <ja> line written after its paragraph's blank line still reaches these pages.
      dialogue.push({ kind: 'char', text: p.text, collapsed: p.collapsed, get voice() { return p.voice } })
    },
    readAloud: () => ctx.voice.active() && settings().voice.language === 'en',
    message(full) {
      addLog({ who: 'char', text: full })
      lastLine = clipLine(full)
    },
    emote: (e) => ctx.character.emote(e),
  })

  /** Her clip for a line; a failure is told once per session and the text goes on unvoiced. */
  function voiceClip(line: VoiceLine) {
    return ctx.voice.clip(line.text).catch((e: unknown) => {
      const why = e instanceof Error ? e.message : String(e)
      if (!voiceWarned) {
        voiceWarned = true
        ctx.toast(`${charName()}'s voice is unavailable: ${why}`, 6000)
      }
      addLog({ who: 'system', text: `Voice: ${why}` })
      return undefined
    })
  }

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
    for (const l of [...layers].reverse()) if (l.el !== asksRoot()) (l.dismiss ?? l.close)()
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
    pushLayer({ el, close: () => (o.back?.() ? undefined : close()), dismiss: close, key: o.key })
    return { el, close }
  }

  /** What the CLI-style menus (/mcp…) need from the chat: its modal layer, toasts, the link and the session folder. */
  const menuHost = (): CommandHost => ({
    modal,
    voiceFor: (test) => {
      const line = PANEL_LINES[test]?.(addressOf(settings()))
      return line ? { name: charName(), text: line } : undefined
    },
    toast: ctx.toast,
    ctx,
    link: ctx.link,
    cwd: () => cwd,
    charName,
    cli: (text) => runCli(ctx.link, text),
    sessionId: () => sessionId,
    tasks: () => bgTasks,
    onTasks(fn) {
      taskWatchers.add(fn)
      return () => void taskWatchers.delete(fn)
    },
    rewind(o) {
      // The conversation restarts from the save, cut at the kept entry; the dropped prompt comes back as the draft.
      if (!sessionId) return
      start({ cwd, resume: sessionId, title, ...o })
      if (o.draft) pendingDraft = o.draft
    },
    setDraft: (text) => input.restore(text),
    run: (text) => input.run(text),
    commands: () => commands,
    toolRecords: () => [...tools.values()],
    transcript: () => {
      const n = names()
      return log.map((e) => ({ who: e.who === 'char' ? n.char : e.who === 'user' ? n.user : e.who, text: entryText(e) }))
    },
    replies: () => log.flatMap((e) => (e.who === 'char' ? [e.text] : [])).reverse(),
    copy: (text) => copy(text, false),
  })
  const taskWatchers = new Set<(t: BgTask[]) => void>()
  /** A rewound prompt, put back in the composer once the restarted session is ready. */
  let pendingDraft: string | undefined


  /** ↑↓ between the picker's items; Enter clicks the focused one natively. */
  const listKeys = (el: HTMLElement) => (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return false
    const items = [...el.querySelectorAll<HTMLElement>('.pick')]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const step = e.key === 'ArrowDown' ? 1 : -1
    items[at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length]?.focus()
    return true
  }

  /** Copies with the app's toast; true when it worked. */
  async function copy(text: string, toast = true) {
    try {
      await navigator.clipboard.writeText(text)
      if (toast) ctx.toast('Copied')
      return true
    } catch {
      ctx.toast('Could not copy to the clipboard')
      return false
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
      ['Enter', 'Send (queues while she works)'], ['Ctrl+Enter', 'Send now, into her running turn'],
      ['Shift+Enter · Ctrl+J · \\+Enter', 'New line'], ['↑ / ↓', 'Input history'], ['Ctrl+R', 'Search history'],
      ['/', 'Commands'], ['@', 'Mention a file'], ['!', 'Run a shell command'], ['Ctrl+V · Alt+V', 'Paste an image'],
      ['Esc', 'Close a menu · interrupt'], ['Esc Esc', 'Rewind to an earlier message'], ['Shift+Tab', 'Cycle permission mode'],
      ['Ctrl+O', 'Backlog (the full trace)'], ['Ctrl+B', 'Send the running command to the background'],
      ['Ctrl+L', 'Clear the prompt'], ['Ctrl+C', 'Clear the prompt · interrupt'], ['Tab', 'Take her suggestion'],
      ['Click · Space · Enter', 'Next page'], ['Hold Ctrl', 'Skip dialogue'], ['1–9 · ↑↓ · Enter', 'Answer a choice menu'],
    ]
    // Every command the app answers itself, from the registry: the CLI's panels and the app's own.
    const app: [string, string][] = APP_COMMANDS.map((c) => [`/${c.name}${c.aliases.length ? ` (/${c.aliases.join(', /')})` : ''}`, c.describe(charName())])
    const row = ([k, v]: [string, string]) => `<div class="hk"><kbd>${esc(k)}</kbd><span>${esc(v)}</span></div>`
    const own = new Set(APP_COMMANDS.flatMap((c) => [c.name, ...c.aliases]))
    const rest = commands.filter((c) => !own.has(c.name))
    const cli = rest.length ? rest.map((c) => row([`/${c.name}`, c.description])).join('') : '<p class="empty">Loading…</p>'
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

  /**
   * A CLI notification: always in the LOG; medium and above also as a toast, held back while you are typing so it
   * never lands mid-sentence (the CLI shows them in its footer).
   */
  function onNotify(m: Extract<SessionEvent, { t: 'notify' }>) {
    addLog({ who: 'system', text: m.text })
    if (m.priority === 'low') return
    const show = () => ctx.toast(m.text, m.priority === 'high' || m.priority === 'immediate' ? 6000 : 3500)
    if (m.priority === 'immediate' || !input.isTyping()) return show()
    input.whenIdle(show)
  }

  /** A hook: the spinner names it while it runs, and a failed one is logged with its output. */
  function onHook(m: Extract<SessionEvent, { t: 'hook' }>) {
    if (m.state === 'running') {
      hookNote = `running ${m.event} hook${m.name && m.name !== m.event ? ` · ${m.name}` : ''}`
      return updateSpinner()
    }
    hookNote = undefined
    updateSpinner()
    if (m.state === 'error') addLog({ who: 'error', text: `${m.event} hook ${m.name} failed${m.output ? `:\n${m.output}` : ''}` })
  }

  /** The user's `spinnerVerbs` setting, later files winning as the CLI merges them (user, project, local). */
  function loadSpinnerVerbs() {
    void control<{ json: { spinnerVerbs?: SpinnerVerbs } }[]>(ctx.link, 'settingsFiles')
      .then((files) => {
        const own = files.map((f) => f.json.spinnerVerbs).filter(Boolean).at(-1)
        verbs = verbList(own)
      })
      .catch(() => undefined)
  }

  /**
   * The CLI's footer warning when the context is nearly full: "Context low (N% remaining) · Run /compact to compact
   * & continue". Said once per crossing, in the LOG and as a toast.
   */
  function warnContext(s: Stats) {
    const c = s.context
    if (!c?.max) return
    const left = Math.max(0, Math.round(100 - (c.used / c.max) * 100))
    if (left > CONTEXT_LOW_LEFT) return void (contextWarned = false)
    if (contextWarned) return
    contextWarned = true
    const text = `Context low (${left}% remaining) · Run /compact to compact & continue`
    addLog({ who: 'system', text })
    input.whenIdle(() => ctx.toast(text, 6000))
  }

  function updateSpinner() {
    spinnerEl.classList.toggle('show', running)
    if (!running) return
    // The CLI's line: "✻ Schlepping… (13s · ↓ 332 tokens · thinking with high effort)", with her name and phase.
    const ms = Date.now() - turnStart
    const status = asks.isOpen() ? 'waiting for your answer'
      : phase === 'thinking' ? thinkingStatus(Math.floor((Date.now() - phaseStart) / 1000), stats?.effort)
      : PHASE_VERBS[phase]
    const parts = [duration(ms), `↓ ${fmtK(outTokens)} tokens`, status, note, hookNote].filter(Boolean).map((p) => esc(p!))
    spinnerEl.innerHTML = `<b>✻ ${esc(turnVerb)}…</b> <span>(${parts.join(' · ')})</span> <em>${esc(charName())}</em>`
  }

  function setRunning(on: boolean) {
    if (running === on) return
    running = on
    // The phone's STOP button lights up while she works (chat.css).
    root.classList.toggle('running', on)
    ctx.character.setBusy(on)
    if (on) {
      turnStart = Date.now()
      phaseStart = turnStart
      turnVerb = pickVerb(verbs)
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
    input.setQueued(queued.map(({ id, text, shell }) => ({ id, text: shell ? `!${text}` : text })), (id) => {
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

  // ---------------------------------------------------------------- affection and rest

  /** Points from her verdict on your words (±1) or a headpat (+1); each heart costs more than the last. */
  function addAffection(delta: number, from: 'words' | 'pat') {
    const next = clampPoints(affection + delta)
    if (next === affection) return
    const before = levelOf(affection)
    affection = next
    const level = levelOf(next)
    const change = level > before ? 'up' : level < before ? 'down' : undefined
    if (change) moodChange = change
    panels.hearts(affection, change)
    const name = charName()
    addLog({ who: 'system', text: from === 'pat' ? `♥ Headpat · ${name} +1` : delta > 0 ? `♥ ${name} liked that · +1` : `♡ That stung ${name} · −1` })
    if (change === 'up') ctx.toast(`♥ ${name}'s affection rose to ${level}/${AFFECTION_LEVELS}`)
    if (change === 'down') ctx.toast(`♡ ${name}'s affection fell to ${level}/${AFFECTION_LEVELS}`)
    // Only the points: a full save now would cancel the thumbnail save a finished turn has pending.
    if (sessionId) ctx.link.send({ t: 'save_meta', id: sessionId, patch: { affectionPts: affection } })
  }

  function onHeadpat() {
    if (!live || Date.now() - lastPatPointAt < HEADPAT_POINT_MS) return
    lastPatPointAt = Date.now()
    addAffection(1, 'pat')
  }

  /** What rides along with a message: her level, whether it just moved, and a rest reminder when one is due. */
  function mood(): Mood {
    const now = Date.now()
    const due = now - APP_OPENED_AT >= restEveryMs() && now - lastRestAt >= restEveryMs()
    if (due) lastRestAt = now
    const m: Mood = { level: levelOf(affection), ...(moodChange && { change: moodChange }), ...(due && { restAfterMs: now - APP_OPENED_AT }) }
    moodChange = undefined
    return m
  }

  /** A queued message waits behind her unread pages; one you just typed replaces them, as a reply does. */
  function say(text: string, images: Image[], fromQueue = false) {
    ctx.link.send({ t: 'say', text, images: images.length ? images : undefined, mood: mood() })
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
    if (next?.shell) runShell(next.text)
    else if (next) say(next.text, next.images, true)
  }

  /** `!cmd`: runs in the session folder. Until its output is back, Esc, Ctrl+C and STOP stop it (R16). */
  function runShell(command: string) {
    shellsRunning++
    ctx.link.send({ t: 'shell', command })
    addLog({ who: 'user', text: `!${command}` })
    // Queued behind anything unread, so her pages are not thrown away.
    dialogue.push({ kind: 'narration', text: `Running \`${oneLine(command, SHELL_NARRATION_CHARS)}\`… (Esc stops it)` })
  }

  function restoreQueue() {
    if (!queued.length) return false
    input.restore(queued.map((q) => (q.shell ? `!${q.text}` : q.text)).join('\n'))
    queued = []
    renderQueue()
    return true
  }

  function interrupt() {
    if (!running && !shellsRunning) return false
    ctx.link.send({ t: 'interrupt' })
    // Like the CLI, messages typed during the turn come back to the input instead of running.
    restoreQueue()
    return true
  }

  function cycleMode() {
    if (!live || ended) return
    // The CLI's cycle: bypass only when the session started with it, auto only when the model offers it.
    const current = models.find((x) => x.value === model || x.resolved === model)
    const auto = current?.supportsAuto ?? (autoSeen || settings().claude.permissionMode === 'auto')
    const cycle: PermissionModeName[] = [
      ...BASE_CYCLE,
      ...(bypassAvailable ? ['bypassPermissions' as const] : []),
      ...(auto ? ['auto' as const] : []),
    ]
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

  /** `checkTrust`: a folder opened from the title or Load; a restart or /clear reuses a folder already trusted. */
  function start(o: { cwd: string; resume?: string; title?: string; resumeAt?: string; dropsTurn?: string }, checkTrust = false) {
    reset(o, nextEpoch())
    const send = () => ctx.link.send({ t: 'start', epoch, cwd: o.cwd, resume: o.resume, ...(o.resumeAt ? { resumeAt: o.resumeAt } : {}), ...(o.dropsTurn ? { dropsTurn: o.dropsTurn } : {}) })
    if (checkTrust) void trustThen(o.cwd, send)
    else send()
  }

  /**
   * Picks up a session this window didn't start: the one running when a phone asks to `attach`, or one another
   * window (the desktop, or a phone) just started. Its state follows as ordinary session events under its epoch.
   */
  function follow(e: number, o: { cwd: string; title?: string }) {
    attaching = false
    reset(o, e)
    dialogue.show({ kind: 'narration', text: `Joining ${charName()}…` })
  }

  /** The phone's "join": asks the link for the running session (answered by `attached`). */
  function attach() {
    attaching = true
    ctx.link.send({ t: 'attach' })
  }

  /** Clears the screen for a session under epoch `e`, before its events come in. */
  function reset(o: { cwd: string; resume?: string; title?: string }, e: number) {
    epoch = e
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
    moodChange = undefined
    voiceWarned = false
    basePlayMs = 0
    startedAt = 0
    lastLine = ''
    queued = []
    shellsRunning = 0
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
    bgTasks = []
  }

  /**
   * The terminal's "Quick safety check": a folder's own hooks, MCP servers and pre-approved rules apply only
   * once you trust it. Declining goes back to the title, as "No, exit" leaves the CLI.
   */
  async function trustThen(folder: string, go: () => void) {
    const my = epoch
    const ask = (t: 'trust_check' | 'trust_accept') => {
      const reply = ctx.link.next((m): m is Extract<ServerMsg, { t: 'trust' }> => m.t === 'trust' && m.cwd === folder, TRUST_WAIT_MS)
      ctx.link.send({ t, cwd: folder })
      return reply
    }
    try {
      let r = await ask('trust_check')
      if (!r.trusted) {
        const extra = r.concerns.length ? `\n\nThis folder's own settings ${r.concerns.join('; ')}. These apply without asking.` : ''
        const yes = await ctx.confirm(
          'Accessing workspace',
          `${folder}\n\nQuick safety check: Is this a project you created or one you trust? (Like your own code, a well-known ` +
            `open source project, or work from your team.) If not, take a moment to review what's in this folder first.\n\n` +
            `${charName()} will be able to read, edit, and execute files here.${extra}`,
          'Yes, I trust this folder',
          'No, exit',
        )
        if (epoch !== my) return
        if (!yes) {
          live = false
          return ctx.router.go('title')
        }
        r = await ask('trust_accept')
      }
      if (epoch === my && r.trusted) go()
    } catch {
      if (epoch !== my) return
      live = false
      ctx.toast(`${charName()} couldn't check this folder. Try again in a moment.`)
      ctx.router.go('title')
    }
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
      affectionPts: affection,
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
    // A phone only watches the computer's session: leaving detaches it, and Join picks it up again.
    if (ctx.link.remote) {
      live = false
      nextEpoch()
      dialogue.setMuted(true)
      setRunning(false)
      asks.clear()
      closeAllLayers()
      return ctx.router.go(to)
    }
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
    // A save from before points carries only its hearts: it starts at the first point of that level.
    affection = clampPoints(m.save?.affectionPts ?? levelStart(m.save?.affection ?? 0))
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
    // A phone's first chat starts with the touch tutorial (once), over the session it opened on.
    if (ctx.link.remote && document.getElementById('stage')?.dataset.orient === 'portrait') phoneTutorial({ modal })
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
      // The CLI's completion line: "Baked for 1m 3s".
      if (m.seconds >= 1) addLog({ who: 'system', text: `✻ ${doneVerb(turnStart)} for ${duration(m.seconds * 1000)}` })
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
    if (m.interrupted) return
    // She is waiting for you now, unless a queued message goes out next.
    if (!queued.length) callForAttention()
    sendNext()
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
    // What she had streamed of an unfinished reply still goes to the LOG.
    pager.end()
    shellsRunning = 0
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
    if (!m.sub && phase !== 'tool') (phase = 'tool'), (phaseStart = Date.now())
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
    shellsRunning = Math.max(0, shellsRunning - 1)
    // She usually answers the output in a turn of her own; when she doesn't (stopped, or respondToBashCommands
    // off), what was queued behind the command goes out now.
    window.setTimeout(() => !running && !shellsRunning && sendNext(), SHELL_DRAIN_MS)
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
        bypassAvailable = m.bypassAvailable === true
        model = m.model ?? stats?.model ?? model
        panels.models(m.models)
        panels.model(model)
        panels.mode(m.mode)
        input.setEnabled(true, placeholder())
        if (pendingDraft) input.restore(pendingDraft)
        pendingDraft = undefined
        loadSpinnerVerbs()
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
      case 'affection': return addAffection(m.delta, 'words')
      case 'voice': return pager.voice(m.text)
      case 'text':
        if (phase !== 'writing') (phase = 'writing'), (phaseStart = Date.now()), updateSpinner()
        return pager.text(m.delta)
      case 'text_end': return pager.end()
      case 'progress':
        outTokens = m.outputTokens
        if (phase !== m.phase) phaseStart = Date.now()
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
      case 'ask_elicit':
        asks.push(m)
        if (!visible) ctx.toast(`${charName()} needs your answer in the chat`, 4000)
        callForAttention()
        return updateSpinner()
      case 'ask_cancel':
        asks.cancel(m.id)
        return updateSpinner()
      case 'bg_tasks':
        bgTasks = m.tasks
        for (const fn of taskWatchers) fn(bgTasks)
        return
      case 'notify':
        return onNotify(m)
      case 'suggestion':
        return input.suggest(m.text)
      case 'hook':
        return onHook(m)
      case 'state':
        if (m.state === 'running') setRunning(true)
        return updateSpinner()
      case 'stats':
        stats = m.stats
        model = m.stats.model ?? model
        if (m.stats.mode) (mode = m.stats.mode), (autoSeen ||= mode === 'auto')
        panels.stats(m.stats)
        warnContext(m.stats)
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
    // Ctrl+O opens the backlog, the CLI's key for the full transcript (Ctrl+L clears the prompt, as in the CLI).
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') return void (handled(), openLog())
    if (top) return
    if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.altKey) return void (handled(), cycleMode())
    if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') return void (handled(), setFocus(!focusOn))
    // Ctrl+K: the command palette, every command and action with its key.
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') return void (handled(), openPalette(menuHost()))
    // `?` on an empty prompt: the shortcut sheet, as in the CLI.
    if (e.key === '?' && !e.ctrlKey && !e.altKey && fromInput(e) && !(e.target as HTMLTextAreaElement).value) return void (handled(), openShortcuts(menuHost()))
    // Ctrl+B: the CLI's "run in background" for the Bash command or agent she is waiting on.
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b' && running) {
      handled()
      void control<boolean>(ctx.link, 'backgroundTasks')
        .then((moved) => ctx.toast(moved ? 'Moved to the background · /tasks to manage' : 'Nothing to send to the background'))
        .catch((x: Error) => ctx.toast(x.message))
      return
    }
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
      ctx.character.onHeadpat(onHeadpat)
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
      dialogue = createDialogue(dlgEl, {
        store: ctx.store,
        character: ctx.character,
        names,
        openLog,
        voiceOn: () => ctx.voice.active(),
        clip: voiceClip,
        play: (clip) => ctx.voice.play(clip),
      })
      const qm = document.createElement('nav')
      qm.className = 'quickmenu'
      // On a phone only LOG, AUTO, SLACK, STOP and ⋯ show (chat.css): fewer, bigger buttons; ⋯ opens the rest.
      qm.innerHTML = [
        ['log', 'LOG', 'Backlog (Ctrl+O)'], ['auto', 'AUTO', 'Auto-advance'], ['mode', 'MODE', 'Permission mode (Shift+Tab)'],
        ['cmd', 'CMD', 'Commands (/)'], ['stop', 'STOP', 'Interrupt (Esc)'], ['slack', 'SLACK', 'Slack inbox (/slack)'], ['costume', '👗', 'Costume (/costume)'],
        ['focus', 'FOCUS', 'Focus mode: just the prompt and replies (/focus · Ctrl+Shift+F)'], ['settings', '⚙', 'Settings (/config)'],
        ['menu', 'MENU', 'Back to the title'], ['more', '⋯', 'More'],
      ].map(([id, label, tip]) => `<button type="button" data-test="qm-${id}" title="${tip}">${label}</button>`).join('')
      dlgEl.append(qm)
      autoBtn = qm.querySelector('[data-test="qm-auto"]')!
      // SLACK carries how many conversations have unread messages, as the link's scan finds them.
      const slackBtn = qm.querySelector<HTMLElement>('[data-test="qm-slack"]')!
      const slackBadge = () => {
        const n = ctx.slack.status().signedIn ? ctx.slack.unreadCount() : 0
        slackBtn.dataset.badge = n ? String(n) : ''
        slackBtn.title = n ? `Slack inbox (/slack): ${n} conversation${n === 1 ? '' : 's'} unread` : 'Slack inbox (/slack)'
      }
      ctx.slack.onChange(slackBadge)
      slackBadge()
      applyFocus()
      const qmActions: Record<string, () => void> = {
        more: openMore,
        log: openLog,
        auto() {
          auto = !auto
          autoBtn.classList.toggle('on', auto)
          dialogue.setAuto(auto)
        },
        mode: cycleMode,
        cmd: openSlash,
        stop: () => void (interrupt() || ctx.toast(`${charName()} isn't working on anything right now`)),
        slack: () => slackCommand(menuHost()),
        costume: openCostumes,
        focus: () => setFocus(!focusOn),
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
        // A swipe on the box (below) is not a tap.
        if (swiped) return void (swiped = false)
        if ((e.target as HTMLElement).closest('button, a, details') || getSelection()?.toString()) return
        dialogue.advance()
        // On a touch screen focusing the composer would bring the keyboard up at every tap.
        if (!layers.length && !touched) input.focus()
      })

      // ---------------------------------------------------------------- phone: the ⋯ sheet, panel tabs, gestures
      // On a phone (portrait) the side panels don't fit beside her: Status, Quests and Actions are tabs of one
      // sheet over her, ⋯ holds what the quick menu leaves out, and the text box takes two swipes.

      let touched = false
      let swiped = false
      let swipeFrom: { x: number; y: number; t: number } | undefined
      const isPortrait = () => document.getElementById('stage')?.dataset.orient === 'portrait'
      dlgEl.addEventListener('pointerdown', (e) => (touched = e.pointerType !== 'mouse'))
      // Touch events, not pointer events: a vertical finger move starts a scroll, which cancels the pointer events.
      dlgEl.addEventListener('touchstart', (e) => {
        swiped = false
        const t = e.touches[0]
        swipeFrom = t && e.touches.length === 1 && isPortrait() && !(e.target as HTMLElement).closest('button, a')
          ? { x: t.clientX, y: t.clientY, t: performance.now() }
          : undefined
      }, { passive: true })
      dlgEl.addEventListener('touchend', (e) => {
        const from = swipeFrom
        swipeFrom = undefined
        const t = e.changedTouches[0]
        if (!from || !t) return
        const dx = t.clientX - from.x
        const dy = t.clientY - from.y
        if (performance.now() - from.t > SWIPE_MS || Math.abs(dy) < SWIPE_PX || Math.abs(dy) < Math.abs(dx) * SWIPE_STRAIGHT) return
        // A long page scrolls first: a swipe only counts once the text is at that end.
        const text = dlgEl.querySelector<HTMLElement>('.dlg-text')
        if (text && (dy < 0 ? text.scrollTop + text.clientHeight < text.scrollHeight - 2 : text.scrollTop > 2)) return
        swiped = true
        if (dy < 0) openLog()
        else hideUi(true)
      })

      // Swipe down hides everything but her; a tap anywhere brings it back without advancing the text.
      const unhide = document.createElement('div')
      unhide.className = 'unhide'
      unhide.dataset.test = 'unhide'
      root.append(unhide)
      unhide.addEventListener('click', (e) => (e.stopPropagation(), hideUi(false)))
      function hideUi(on: boolean) {
        if (on === (root.dataset.hidden === 'on')) return
        root.dataset.hidden = on ? 'on' : ''
        if (on) pushLayer({ el: unhide, close: () => hideUi(false) })
        else dropLayer(unhide)
      }

      const panelTabs = document.createElement('nav')
      panelTabs.className = 'ptabs'
      panelTabs.dataset.test = 'panel-tabs'
      panelTabs.innerHTML = PANEL_TABS.map(([id, label]) => `<button type="button" data-tab="${id}" data-test="ptab-${id}">${label}</button>`).join('')
        + '<button type="button" class="pclose" data-tab="close" data-test="ptab-close" aria-label="Close">✕</button>'
      root.append(panelTabs)
      panelTabs.addEventListener('click', (e) => {
        const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]')?.dataset.tab
        if (tab === 'close') return closePanels()
        if (tab === 'slack') return closePanels(), slackCommand(menuHost())
        if (tab) openPanels(tab as PanelTab)
      })
      function openPanels(tab: PanelTab) {
        const wasOpen = !!root.dataset.panels
        root.dataset.panels = tab
        for (const b of panelTabs.querySelectorAll<HTMLElement>('[data-tab]')) b.classList.toggle('on', b.dataset.tab === tab)
        if (!wasOpen) pushLayer({ el: panelTabs, close: closePanels })
      }
      function closePanels() {
        if (!root.dataset.panels) return
        root.dataset.panels = ''
        dropLayer(panelTabs)
      }

      function openMore() {
        const m = modal({
          test: 'qm-sheet',
          title: 'More',
          cls: 'sheet',
          body: `<div class="sheet-grid">${MORE_ITEMS.map(([id, icon, label]) =>
            `<button type="button" class="btn" data-id="${id}" data-test="more-${id}"><span>${icon}</span>${label}</button>`).join('')}</div>`,
        })
        m.el.querySelector('.sheet-grid')!.addEventListener('click', (e) => {
          const id = (e.target as HTMLElement).closest<HTMLElement>('[data-id]')?.dataset.id
          if (!id) return
          m.close()
          if (id === 'status' || id === 'quests' || id === 'actions') openPanels(id)
          else qmActions[id]?.()
        })
      }

      panels = createPanels(root.querySelector('.chat-left')!, root.querySelector('.chat-right')!, {
        openModels,
        // Focus goes back to the composer, so typing goes there instead of re-pressing the badge with Space/Enter.
        cycleMode: () => (cycleMode(), input.focus()),
        openAction,
      })
      asks = createAsks(asksRoot(), {
        ctx,
        name: charName,
        log: (line) => addLog({ who: 'system', text: line }),
        gesture,
        markdown,
        typing: () => input?.isTyping() ?? false,
        onChange(open) {
          // Skipping never runs through a question: it stops at every choice menu.
          if (open) stopSkip()
          // Opened mid-sentence, it waits; once you stop typing it takes the keys.
          if (open) input?.whenIdle(() => asks.focus())
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
        submitNow(text, images) {
          if (!live || ended || !ready || !running) return say(text, images)
          ctx.link.send({ t: 'say', text, images, now: true, mood: mood() })
          addLog({ who: 'user', text })
          ctx.toast(`Sent now · ${charName()} reads it at her next step`)
        },
        submit(text, images) {
          if (!live || ended) {
            input.restore(text)
            const pics = images.length ? ` · attach your image${images.length > 1 ? 's' : ''} again after` : ''
            return ctx.toast(`The session has ended · restart it first${pics}`)
          }
          // Like the CLI, a message typed while she works (or before she is ready) waits for the next turn.
          if (running || !ready || shellsRunning) {
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
          // As in the CLI, a `!` line typed while she works runs when the turn is over, not alongside her edits.
          if (running || shellsRunning) {
            queued.push({ id: String(++queueSeq), text: command, images: [], shell: true })
            return renderQueue()
          }
          runShell(command)
        },
        local(name, args) {
          const own = findAppCommand(name)
          if (own?.run) return own.run(menuHost(), args, name), true
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
            case 'focus': {
              const want = args.trim().toLowerCase()
              setFocus(want === 'on' ? true : want === 'off' ? false : !focusOn)
              return true
            }
            case 'theme':
              ctx.router.go('settings', { tab: 'appearance' })
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
        if (m.t === 'attached') {
          if (!attaching) return
          if (m.epoch !== undefined) return follow(m.epoch, { cwd: '' })
          attaching = false
          ctx.toast(`Nothing is running on your computer. Start or load a session.`)
          return ctx.router.go('title')
        }
        if (!('epoch' in m)) return
        if (m.epoch === epoch && live) return onSession(m)
        // Another window started a session (a phone, or the desktop while a phone watches): the link runs one at a
        // time, so this chat follows it rather than showing one that just ended.
        if (m.t === 'started' && live && !attaching) {
          follow(m.epoch, { cwd: m.cwd, title: m.save?.title })
          onSession(m)
        }
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
      if (p && 'attach' in p) return attach()
      if (p?.cwd) return start({ cwd: p.cwd, resume: p.resume, title: p.title }, true)
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
      if (restoreQueue()) return true
      // Esc Esc on an idle, empty prompt opens the rewind menu, as in the CLI.
      if (ready && !running && !input.isTyping()) {
        const now = performance.now()
        if (now - lastEscAt < DOUBLE_ESC_MS) {
          lastEscAt = 0
          findAppCommand('rewind')?.run?.(menuHost(), '', 'rewind')
          return true
        }
        lastEscAt = now
      }
      return false
    },

    onBack() {
      // Popups and menus close first, as with Esc. An open prompt stays: it waits for an answer from either
      // device, and joining again brings it back.
      if (input.closePopups()) return true
      const top = layers.at(-1)
      if (top && top.el !== asksRoot()) return top.close(), true
      void leave('title')
      return true
    },
  }
}
