// Launches Waifufy Code for E2E tests and drives its page over the Chrome DevTools Protocol.
//
// Two targets (WC_E2E_TARGET):
//   app      the real Tauri debug build (default). The shell opens WebView2's CDP port from WC_CDP_PORT and starts
//            the sidecar, which inherits WC_MOCK. A dev-config build (plain `cargo build`) loads the page from
//            Vite on 1430, so it always tests the current frontend; `tauri build` embeds a dist snapshot instead.
//   browser  Vite + the sidecar + Chrome/Edge, with the link port and token in the URL (link.ts supports
//            `?link=&token=`). No Tauri: the OS folder/file pickers and `quit` are unavailable.
// Every launch gets a fresh WC_DATA_DIR (and WebView2 profile), so the user's real settings and saves are
// never touched.

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EMOTIONS } from '../../link/src/protocol.ts'
import { defaultModelsDir } from '../../link/src/settings.ts'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const OUT = join(ROOT, 'tests', 'e2e', 'out')
/** Where lib.mjs makeProject() puts projects. The app is told this folder is trusted (WC_TRUST_FOLDERS). */
export const PROJECTS_ROOT = join(tmpdir(), 'wc-e2e-projects')
const APP_DIR = join(ROOT, 'app')
const LINK_DIR = join(ROOT, 'link')
const EXE = process.env.WC_E2E_EXE || join(APP_DIR, 'src-tauri', 'target', 'debug', 'waifufy-code.exe')
const VITE_PORT = 1430
const VITE_URL = `http://localhost:${VITE_PORT}/`
export const CDP_PORT = Number(process.env.WC_CDP_PORT) || 9333
const TAURI_CONF = join(APP_DIR, 'src-tauri', 'tauri.conf.json')
const BROWSERS = [
  process.env.WC_E2E_BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)

const VITE_BOOT_MS = 30_000
const CDP_BOOT_MS = 60_000
const APP_BOOT_MS = 90_000
const PORT_FREE_MS = 8000
const POLL_MS = 50
const PROBE_MS = 600
const DEFAULT_WAIT_MS = 10_000
const MAX_PAGE_ERRORS = 20
const CDP_CALL_MS = 30_000
/** The WebView2 or Chrome profile in a data dir can stay locked for a moment after its process is killed. */
const RM_RETRIES = 10
const RM_RETRY_MS = 200
const EXIT_WAIT_MS = 5000
/** Client messages the harness never forwards to the sidecar: they would open a console, Explorer, or spend plan budget. */
const BLOCKED = ['login', 'research', 'reveal', 'open']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The window's additionalBrowserArgs from tauri.conf.json, so browser mode runs Chrome with the app's switches. */
function webviewArgs() {
  const conf = JSON.parse(readFileSync(TAURI_CONF, 'utf8'))
  return (conf.app?.windows?.[0]?.additionalBrowserArgs ?? '').split(/\s+/).filter(Boolean)
}

export function killTree(proc) {
  if (!proc?.pid || proc.exitCode !== null) return
  if (process.platform === 'win32') killPid(proc.pid)
  else proc.kill('SIGKILL')
}

/**
 * Deletes a launch's data dir once its processes are gone. Each holds a browser profile of tens of MB, so
 * repeated runs would pile them up in %TEMP%; a dir still locked by a lingering child is left with a warning.
 */
async function removeDataDir(dir, procs) {
  const deadline = Date.now() + EXIT_WAIT_MS
  while (procs.some((p) => p.exitCode === null && p.signalCode === null) && Date.now() < deadline) await sleep(POLL_MS)
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: RM_RETRIES, retryDelay: RM_RETRY_MS })
  } catch (e) {
    console.log(`    warning: could not delete ${dir} (${e.code ?? e.message})`)
  }
}

/** Kills a process and everything it started (Windows). */
export function killPid(pid) {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
}

async function probe(url, ms = PROBE_MS) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) })
    return r.ok ? r : undefined
  } catch {
    return undefined
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function logFile(name) {
  mkdirSync(OUT, { recursive: true })
  return openSync(join(OUT, name), 'w')
}

// ---------------------------------------------------------------- Vite (shared by every launch of a run)

let vite
export async function ensureVite() {
  if (await probe(VITE_URL)) return
  const bin = join(APP_DIR, 'node_modules', 'vite', 'bin', 'vite.js')
  const log = logFile('vite.log')
  const config = join(ROOT, 'tests', 'e2e', 'vite.e2e.config.mjs')
  vite = spawn(process.execPath, [bin, '--config', config, '--port', String(VITE_PORT), '--strictPort'], { cwd: APP_DIR, stdio: ['ignore', log, log] })
  const deadline = Date.now() + VITE_BOOT_MS
  while (Date.now() < deadline) {
    if (await probe(VITE_URL)) return
    if (vite.exitCode !== null) throw new Error(`vite exited with ${vite.exitCode}; see tests/e2e/out/vite.log`)
    await sleep(POLL_MS * 4)
  }
  throw new Error(`vite did not answer on ${VITE_URL} within ${VITE_BOOT_MS / 1000}s`)
}

export function stopVite() {
  killTree(vite)
  vite = undefined
}

// ---------------------------------------------------------------- CDP client

class Cdp {
  #ws
  #seq = 0
  #pending = new Map()
  #listeners = new Map()

  static async connect(url) {
    const cdp = new Cdp()
    cdp.#ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      cdp.#ws.addEventListener('open', resolve, { once: true })
      cdp.#ws.addEventListener('error', () => reject(new Error(`cannot open CDP socket ${url}`)), { once: true })
    })
    cdp.#ws.addEventListener('message', (e) => cdp.#onMessage(JSON.parse(String(e.data))))
    cdp.#ws.addEventListener('close', () => {
      for (const p of cdp.#pending.values()) p.reject(new Error('CDP socket closed (did the app exit?)'))
      cdp.#pending.clear()
    })
    return cdp
  }

  #onMessage(m) {
    if (m.id !== undefined) {
      const p = this.#pending.get(m.id)
      this.#pending.delete(m.id)
      if (m.error) p?.reject(new Error(`${p.method}: ${m.error.message}`))
      else p?.resolve(m.result)
      return
    }
    for (const fn of this.#listeners.get(m.method) ?? []) fn(m.params)
  }

  send(method, params = {}) {
    const id = ++this.#seq
    return new Promise((resolve, reject) => {
      // A WebView whose host exited can keep the socket open without ever answering.
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`CDP ${method} got no answer in ${CDP_CALL_MS / 1000}s (did the app hang or exit?)`))
      }, CDP_CALL_MS)
      const done = (fn) => (v) => (clearTimeout(timer), fn(v))
      this.#pending.set(id, { resolve: done(resolve), reject: done(reject), method })
      this.#ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method, fn) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, new Set())
    this.#listeners.get(method).add(fn)
    return () => this.#listeners.get(method).delete(fn)
  }

  close() {
    this.#ws.close()
  }
}

async function pageTarget(port, deadline, accept) {
  while (Date.now() < deadline) {
    const r = await probe(`http://127.0.0.1:${port}/json`)
    const list = r ? await r.json().catch(() => []) : []
    const page = list.find((t) => t.type === 'page' && accept(t.url))
    if (page) return page
    await sleep(POLL_MS * 4)
  }
  throw new Error(`no page target on CDP port ${port}; is WC_CDP_PORT/WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS honored by the build?`)
}

// ---------------------------------------------------------------- in-page recorder

/**
 * Runs in the page before its own scripts: keeps the link's WebSocket so tests can inject server
 * messages, and once `window.__wc` exists records every server message, every sent client message,
 * the #chara data-* attributes and every dialogue text change, each with a timestamp.
 */
const PRELUDE = `(() => {
  if (window.__e2e) return
  const TAG = new RegExp('\\\\[(' + ${JSON.stringify(EMOTIONS.join('|'))} + ')\\\\]')
  const MAX_LOG = 20000
  const ATTRS = ['data-model', 'data-costume', 'data-emotion', 'data-talking', 'data-busy', 'data-gesture', 'data-placement', 'data-focus']
  const Native = window.WebSocket
  const sockets = []
  window.WebSocket = class extends Native {
    constructor(...a) {
      super(...a)
      sockets.push(this)
    }
  }
  const e2e = (window.__e2e = { events: [], sent: [], attrs: [], dialogue: [], leaks: [], block: new Set(${JSON.stringify(BLOCKED)}), installed: false })
  const push = (list, v) => (list.push(v), list.length > MAX_LOG && list.shift())
  e2e.inject = (m) => {
    const s = sockets.filter((x) => x.url.includes('token=') && x.readyState === 1).at(-1)
    if (!s) throw new Error('no open link socket to inject into')
    s.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m) }))
  }
  // Closes the link's sockets the way Android does to an app in the background (the page stays, the connection goes).
  e2e.dropLinks = () => sockets.filter((x) => x.url.includes('token=') && x.readyState === 1).forEach((x) => x.close())
  e2e.isVisible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return false
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n)
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false
    }
    return true
  }
  e2e.visible = (sel) => {
    const el = document.querySelector(sel)
    return Boolean(el && e2e.isVisible(el))
  }
  e2e.mark = () => ({ events: e2e.events.length, sent: e2e.sent.length, attrs: e2e.attrs.length, dialogue: e2e.dialogue.length })
  const install = () => {
    const wc = window.__wc
    if (!wc || e2e.installed) return Boolean(wc)
    e2e.installed = true
    wc.link.on((m) => push(e2e.events, { ...m, at: performance.now() }))
    const send = wc.link.send
    wc.link.send = (m) => {
      push(e2e.sent, { ...m, at: performance.now() })
      if (!e2e.block.has(m.t)) send(m)
    }
    const chara = document.getElementById('chara')
    new MutationObserver((ms) => {
      for (const m of ms) push(e2e.attrs, { name: m.attributeName, value: chara.getAttribute(m.attributeName), at: performance.now() })
    }).observe(chara, { attributes: true, attributeFilter: ATTRS })
    let last = ''
    new MutationObserver(() => {
      const el = document.querySelector('[data-test="dialogue-text"]')
      const text = el ? el.textContent : ''
      if (text === last) return
      last = text
      const name = document.querySelector('[data-test="dialogue-name"]')?.textContent ?? ''
      push(e2e.dialogue, { text, html: el ? el.innerHTML : '', name, at: performance.now() })
      if (TAG.test(text)) e2e.leaks.push(text)
    }).observe(document.getElementById('stage'), { subtree: true, childList: true, characterData: true })
    return true
  }
  const timer = setInterval(() => install() && clearInterval(timer), 20)
})()`

// ---------------------------------------------------------------- keys

const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 }
const KEYS = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Escape: { code: 'Escape', vk: 27 },
  Tab: { code: 'Tab', vk: 9 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
  Control: { code: 'ControlLeft', vk: 17, mod: 'ctrl' },
  Shift: { code: 'ShiftLeft', vk: 16, mod: 'shift' },
  Alt: { code: 'AltLeft', vk: 18, mod: 'alt' },
  ' ': { code: 'Space', vk: 32, text: ' ' },
}
const PUNCT = { '/': ['Slash', 191], '@': ['Digit2', 50], '!': ['Digit1', 49], '.': ['Period', 190], '-': ['Minus', 189], '~': ['Backquote', 192] }

function keyInfo(key) {
  if (KEYS[key]) return { key, ...KEYS[key] }
  if (/^[a-z]$/i.test(key)) return { key, code: `Key${key.toUpperCase()}`, vk: key.toUpperCase().charCodeAt(0), text: key }
  if (/^\d$/.test(key)) return { key, code: `Digit${key}`, vk: key.charCodeAt(0), text: key }
  if (PUNCT[key]) return { key, code: PUNCT[key][0], vk: PUNCT[key][1], text: key }
  return { key, code: '', vk: 0, text: key }
}

/** "Shift+Tab", "Ctrl+L", "Enter" → key info + modifier bits. */
function parseCombo(combo) {
  const parts = combo === '+' ? ['+'] : combo.split('+')
  const key = parts.pop()
  let modifiers = 0
  for (const p of parts) modifiers |= MOD[p.toLowerCase().replace('control', 'ctrl')] ?? 0
  return { info: keyInfo(key.length === 1 && parts.length ? key.toLowerCase() : key), modifiers }
}

// ---------------------------------------------------------------- the app handle

export class App {
  constructor({ cdp, dataDir, procs, target, sidecarPort }) {
    this.cdp = cdp
    this.dataDir = dataDir
    this.procs = procs
    this.target = target
    this.sidecarPort = sidecarPort
    /** Modifier bits held down with keyDown('Control') etc., applied to every mouse and key event. */
    this.held = 0
    this.mouse = {
      move: (x, y) => this.#mouse('mouseMoved', x, y),
      down: (x, y) => this.#mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 }),
      up: (x, y) => this.#mouse('mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 1 }),
      /** Presses at the first point, moves through the rest over `ms`, and releases at the last. */
      drag: async (points, ms = 600) => {
        const [first, ...rest] = points
        await this.mouse.move(first.x, first.y)
        await this.mouse.down(first.x, first.y)
        for (const p of rest) {
          await this.#mouse('mouseMoved', p.x, p.y, { button: 'left', buttons: 1 })
          await sleep(ms / Math.max(1, rest.length))
        }
        const last = points.at(-1)
        await this.mouse.up(last.x, last.y)
      },
    }
  }

  /** A finger swipe from the center of `sel` by (dx, dy) CSS px over `ms` (a phone: openPhone emulates touch). */
  async swipe(sel, dx, dy, ms = 220) {
    const { x, y } = await this.center(sel)
    const steps = 8
    const touch = (type, px, py) => this.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: px, y: py }] })
    await touch('touchStart', x, y)
    for (let k = 1; k <= steps; k++) {
      await sleep(ms / steps)
      await touch('touchMove', x + (dx * k) / steps, y + (dy * k) / steps)
    }
    await touch('touchEnd', x + dx, y + dy)
  }

  #mouse(type, x, y, extra = {}) {
    return this.cdp.send('Input.dispatchMouseEvent', { type, x, y, modifiers: this.held, button: 'none', ...extra })
  }

  // -------------------------------------------------------------- evaluation

  /** Evaluates `fn(...args)` (a function or an expression string) in the page and returns its JSON value. */
  async eval(fn, ...args) {
    const expression = typeof fn === 'function' ? `(${fn.toString()})(...${JSON.stringify(args)})` : fn
    const r = await this.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error(`page: ${d.exception?.description ?? d.text}`.split('\n')[0])
    }
    return r.result.value
  }

  /** Polls `fn(...args)` in the page until it returns a truthy value, which it resolves with. */
  async waitFor(fn, { timeout = DEFAULT_WAIT_MS, label, args = [] } = {}) {
    const deadline = Date.now() + timeout
    let lastError
    while (Date.now() < deadline) {
      try {
        const v = await this.eval(fn, ...args)
        if (v) return v
      } catch (e) {
        lastError = e
        if (/socket closed/.test(e.message)) throw e
      }
      await sleep(POLL_MS)
    }
    const what = label ?? (typeof fn === 'function' ? fn.toString().slice(0, 120) : fn)
    throw new Error(`timed out after ${timeout}ms waiting for ${what}${lastError ? ` (last error: ${lastError.message})` : ''}`)
  }

  // -------------------------------------------------------------- DOM queries (selectors, usually from T())

  exists(sel) {
    return this.eval((s) => Boolean(document.querySelector(s)), sel)
  }

  visible(sel) {
    return this.eval((s) => window.__e2e.visible(s), sel)
  }

  waitVisible(sel, timeout) {
    return this.waitFor((s) => window.__e2e.visible(s), { args: [sel], timeout, label: `${sel} to be visible` })
  }

  /** Waits until the element's text contains `needle` (a string) or matches it (a RegExp). */
  waitText(sel, needle, { timeout, label } = {}) {
    const [src, flags] = needle instanceof RegExp ? [needle.source, needle.flags] : [needle, null]
    return this.waitFor(
      (s, n, f) => {
        const text = document.querySelector(s)?.textContent ?? ''
        return f === null ? text.includes(n) : new RegExp(n, f).test(text)
      },
      { args: [sel, src, flags], timeout, label: label ?? `${sel} to show ${needle}` },
    )
  }

  waitHidden(sel, timeout) {
    return this.waitFor((s) => !window.__e2e.visible(s), { args: [sel], timeout, label: `${sel} to be hidden` })
  }

  /** Number of matching elements, by default only the visible ones. */
  count(sel, { visibleOnly = true } = {}) {
    return this.eval((s, v) => [...document.querySelectorAll(s)].filter((el) => !v || window.__e2e.isVisible(el)).length, sel, visibleOnly)
  }

  text(sel) {
    return this.eval((s) => document.querySelector(s)?.textContent ?? null, sel)
  }

  texts(sel) {
    return this.eval((s) => [...document.querySelectorAll(s)].map((el) => el.textContent), sel)
  }

  attr(sel, name) {
    return this.eval((s, n) => document.querySelector(s)?.getAttribute(n) ?? null, sel, name)
  }

  attrs(sel, name) {
    return this.eval((s, n) => [...document.querySelectorAll(s)].map((el) => el.getAttribute(n)), sel, name)
  }

  value(sel) {
    return this.eval((s) => document.querySelector(s)?.value ?? null, sel)
  }

  /** Visible text of the whole stage, for "is this shown anywhere" checks. */
  stageText() {
    return this.eval(() => document.getElementById('stage').innerText)
  }

  // -------------------------------------------------------------- input

  /** Center of the element in CSS pixels, after scrolling it into view; throws when it is not visible. */
  async center(sel) {
    const c = await this.eval((s) => {
      const el = document.querySelector(s)
      if (!el) return { error: 'not found' }
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return { error: 'has no size (hidden?)' }
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }, sel)
    if (c.error) throw new Error(`${sel}: ${c.error}`)
    return c
  }

  /**
   * Clicks like a user: real mouse events at the element's center. Fails when another element covers
   * that point or the element is not hit-testable (unless `force`, which falls back to element.click()).
   */
  async click(sel, { force = false } = {}) {
    // Choice menus ignore clicks in their first moments (asks.ts ARM_MS), as they ignore keys.
    if (sel.includes('ask-option')) await this.waitFor(() => document.querySelector('[data-test="ask"][data-armed]'), { label: 'the menu to take input' })
    if (force) return this.eval((s) => document.querySelector(s).click(), sel)
    const { x, y } = await this.center(sel)
    const cover = await this.eval(
      (s, px, py) => {
        const el = document.querySelector(s)
        const hit = document.elementFromPoint(px, py)
        if (hit && (el === hit || el.contains(hit))) return ''
        if (!hit) return 'not hit-testable: nothing is at its center'
        const test = hit.dataset.test ? `[data-test=${hit.dataset.test}]` : ''
        const what = `${hit.tagName.toLowerCase()}${hit.id ? '#' + hit.id : ''}${test}${[...hit.classList].map((c) => '.' + c).join('')}`
        // An ancestor at the point means the element itself ignores the pointer, so the click would land on that ancestor.
        return hit.contains(el) ? `not hit-testable (pointer-events: none?); the click would land on ${what}` : `covered by ${what}`
      },
      sel,
      x,
      y,
    )
    if (cover) throw new Error(`click ${sel}: ${cover}`)
    await this.clickAt(x, y)
  }

  async clickAt(x, y) {
    await this.mouse.move(x, y)
    await this.mouse.down(x, y)
    await this.mouse.up(x, y)
  }

  /** Inserts text at the caret like an IME commit (one `input` event). */
  type(text) {
    return this.cdp.send('Input.insertText', { text })
  }

  /** Types character by character with real key events (keydown, keypress, input, keyup). */
  async typeKeys(text) {
    for (const ch of text) await this.key(ch)
  }

  /** Presses and releases a key or combo: 'Enter', 'Escape', 'Shift+Tab', 'Ctrl+L', '1', '/'. */
  async key(combo) {
    const { info, modifiers } = parseCombo(combo)
    const mods = modifiers | this.held
    const text = mods & (MOD.ctrl | MOD.alt | MOD.meta) ? undefined : info.text
    const base = { key: info.key, code: info.code, windowsVirtualKeyCode: info.vk, nativeVirtualKeyCode: info.vk, modifiers: mods }
    await this.cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, text, unmodifiedText: text })
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  /** Holds a key (e.g. 'Control' to skip text) until keyUp. */
  async keyDown(name) {
    const info = keyInfo(name)
    if (info.mod) this.held |= MOD[info.mod]
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.vk,
      nativeVirtualKeyCode: info.vk,
      modifiers: this.held,
      autoRepeat: false,
    })
  }

  async keyUp(name) {
    const info = keyInfo(name)
    if (info.mod) this.held &= ~MOD[info.mod]
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.vk,
      nativeVirtualKeyCode: info.vk,
      modifiers: this.held,
    })
  }

  /** Sets a form control's value as typing would (native setter + input + change), for fields tests don't type into. */
  setValue(sel, value) {
    return this.eval(
      (s, v) => {
        const el = document.querySelector(s)
        if (!el) throw new Error(`${s} not found`)
        const proto = Object.getPrototypeOf(el)
        const setter = Object.getOwnPropertyDescriptor(proto, el.type === 'checkbox' ? 'checked' : 'value')?.set
        setter ? setter.call(el, v) : (el[el.type === 'checkbox' ? 'checked' : 'value'] = v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      },
      sel,
      value,
    )
  }

  /** Pastes a generated PNG into the element as a clipboard paste carrying a File. */
  pasteImage(sel, { width = 48, height = 32, kind = 'paste' } = {}) {
    return this.eval(
      async (s, w, h, how) => {
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        const g = c.getContext('2d')
        g.fillStyle = '#5b8de0'
        g.fillRect(0, 0, w, h)
        g.fillStyle = '#f29bb8'
        g.fillRect(w / 4, h / 4, w / 2, h / 2)
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
        const dt = new DataTransfer()
        dt.items.add(new File([blob], 'e2e.png', { type: 'image/png' }))
        const el = document.querySelector(s)
        if (how === 'paste') return el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
        el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }))
        el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
        return el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
      },
      sel,
      width,
      height,
      kind,
    )
  }

  /** A PNG of the page, or of `clip` ({ x, y, width, height } in CSS pixels), as base64. */
  async capture(clip) {
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })
    return data
  }

  async screenshot(name) {
    mkdirSync(OUT, { recursive: true })
    const data = await this.capture()
    const file = join(OUT, `${name.replace(/[^\w.-]+/g, '_')}.png`)
    writeFileSync(file, Buffer.from(data, 'base64'))
    return file
  }

  // -------------------------------------------------------------- the recorder and app hooks

  /** Positions in the recorder's lists; pass to events()/sent()/waitEvent() to look only at what came after. */
  mark() {
    return this.eval(() => window.__e2e.mark())
  }

  /** Server messages since `from` (a mark or an index), optionally of one type. Big outputs make this heavy, so filter. */
  events(from = 0, t) {
    return this.eval((f, type) => window.__e2e.events.slice(f).filter((m) => !type || m.t === type), from.events ?? from, t ?? null)
  }

  sent(from = 0, t) {
    return this.eval((f, type) => window.__e2e.sent.slice(f).filter((m) => !type || m.t === type), from.sent ?? from, t ?? null)
  }

  attrLog(from = 0, name) {
    return this.eval((f, n) => window.__e2e.attrs.slice(f).filter((a) => !n || a.name === n), from.attrs ?? from, name ?? null)
  }

  dialogueLog(from = 0) {
    return this.eval((f) => window.__e2e.dialogue.slice(f), from.dialogue ?? from)
  }

  /** Waits for a server message of type `t` after `from` whose fields include `match` (shallow equality). */
  waitEvent(t, match = {}, from = 0, timeout) {
    return this.waitFor(
      (type, m, f) => window.__e2e.events.slice(f).find((e) => e.t === type && Object.entries(m).every(([k, v]) => JSON.stringify(e[k]) === JSON.stringify(v))),
      { args: [t, match, from.events ?? from], timeout, label: `server message ${t} ${JSON.stringify(match)}` },
    )
  }

  /** Waits for a client message of type `t` after `from` whose fields include `match`. */
  waitSent(t, match = {}, from = 0, timeout) {
    return this.waitFor(
      (type, m, f) => window.__e2e.sent.slice(f).find((e) => e.t === type && Object.entries(m).every(([k, v]) => JSON.stringify(e[k]) === JSON.stringify(v))),
      { args: [t, match, from.sent ?? from], timeout, label: `client message ${t} ${JSON.stringify(match)}` },
    )
  }

  /** Delivers a fake server message to the app, as if the sidecar had sent it. */
  inject(m) {
    return this.eval((msg) => window.__e2e.inject(msg), m)
  }

  screen() {
    return this.eval(() => window.__wc.router.current())
  }

  go(screen, params) {
    return this.eval((s, p) => window.__wc.router.go(s, p ?? undefined), screen, params ?? null)
  }

  settings() {
    return this.eval(() => window.__wc.store.get())
  }

  /** Deep-merges `patch` into the settings through the store, as a settings screen would. */
  updateSettings(patch) {
    return this.eval((p) => {
      const assign = (dst, src) => {
        for (const [k, v] of Object.entries(src)) {
          if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object') assign(dst[k], v)
          else dst[k] = v
        }
      }
      window.__wc.store.update((s) => assign(s, p))
    }, patch)
  }

  chara(name) {
    return this.eval((n) => document.getElementById('chara').getAttribute(n), name)
  }

  readSettingsFile() {
    const file = join(this.dataDir, 'settings.json')
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
  }

  /** How many times the page (re)loaded since launch; more than 1 mid-test means something reloaded it. */
  navigations() {
    return this.cdp.navigations
  }

  /** Uncaught exceptions the page threw since launch (newest last). */
  pageErrors() {
    return [...this.cdp.errors]
  }

  alive() {
    return this.procs.every((p) => p.exitCode === null)
  }

  /** Process ids of the link sidecar: the Tauri shell's node.exe children. Only the app target has a shell. */
  sidecarPids() {
    const shell = this.procs[0]?.pid
    if (this.target !== 'app' || !shell) return []
    const query = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${shell} AND Name='node.exe'" | ForEach-Object ProcessId`
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8' })
    return (r.stdout ?? '').split(/\s+/).filter(Boolean).map(Number)
  }

  async close() {
    try {
      this.cdp.close()
    } catch {}
    for (const p of this.procs) killTree(p)
    await removeDataDir(this.dataDir, this.procs)
  }
}

// ---------------------------------------------------------------- launch

/**
 * Connects to a page target and installs the recorder; the page then loads `url`, or reloads, so the prelude runs first.
 * `viewport` ('412x915@2.625') emulates a phone.
 */
async function prepare(page, url, viewport = process.env.WC_E2E_VIEWPORT) {
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl)
  // Uncaught page errors, kept so a failed boot or test can say why.
  cdp.errors = []
  cdp.navigations = 0
  cdp.on('Page.frameNavigated', ({ frame }) => {
    if (!frame.parentId) cdp.navigations++
  })
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
    cdp.errors.push((d.exception?.description ?? d.text ?? '').split('\n')[0])
    if (cdp.errors.length > MAX_PAGE_ERRORS) cdp.errors.shift()
  })
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  // WC_E2E_VIEWPORT=412x915@2.625: a phone (portrait layout, touch), before the page boots so it starts that size.
  const vp = /^(\d+)x(\d+)(?:@([\d.]+))?$/.exec(viewport ?? '')
  if (vp) {
    const [, width, height, dpr] = vp
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: Number(width), height: Number(height), deviceScaleFactor: Number(dpr ?? 1), mobile: true })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true })
  }
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PRELUDE })
  if (url) await cdp.send('Page.navigate', { url })
  else await cdp.send('Page.reload', { ignoreCache: true })
  return cdp
}

const booted = () => window.__e2e?.installed && ['title', 'wizard'].includes(window.__wc.router.current()) && document.querySelector('.screen.active')
const bootState = () => ({ url: location.href, ready: document.readyState, prelude: Boolean(window.__e2e), wc: Boolean(window.__wc) })

/**
 * Waits for the first screen. A WebView that comes up while the dev server is still compiling can stall on
 * its first load, so one more reload is tried before giving up with what the page looked like.
 */
async function bootWait(app, cdp, url) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await app.waitFor(booted, { timeout: APP_BOOT_MS / 2, label: 'the app to show its first screen' })
    } catch (e) {
      const state = await app.eval(bootState).catch((x) => ({ error: x.message }))
      if (attempt === 0 && !/socket closed/.test(e.message)) {
        console.log(`    boot stalled (${JSON.stringify(state)}); reloading once`)
        if (url) await cdp.send('Page.navigate', { url })
        else await cdp.send('Page.reload', { ignoreCache: true })
        continue
      }
      const errors = cdp.errors.length ? `; page errors: ${cdp.errors.join(' | ')}` : ''
      throw new Error(`${e.message} (page: ${JSON.stringify(state)})${errors}`)
    }
  }
}

function merge(base, patch) {
  const out = structuredClone(base)
  for (const [k, v] of Object.entries(patch ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' ? merge(out[k], v) : v
  }
  return out
}

/** The settings a test data dir starts with: onboarded, the real costume folder, a known profile, fast text. */
export function seedSettings(patch) {
  return merge(
    {
      version: 1,
      onboarded: true,
      profile: { displayName: 'Yodha', callMe: 'Yodha', honorific: 'kun' },
      appearance: { theme: 'light', modelsDir: process.env.WC_E2E_MODELS || defaultModelsDir() },
      motion: { textCps: 60, autoDelayMs: 400 },
    },
    patch,
  )
}

/**
 * Starts the app and resolves once the first screen shows.
 * - `wizard`: a first run. No settings.json, or with `settings`, that patch over seedSettings() but not onboarded.
 * - `settings`: a patch over seedSettings().
 * - `mock`: false runs the real Agent SDK (tests/e2e/real.mjs only).
 * - `env`: extra environment for the app and its sidecar.
 */
/**
 * A phone (phone access): its own headless Chrome at phone size with touch, loading the app as a phone paired by
 * `pair` (a waifufy-code://pair link). Close it with `close()` like any app.
 */
export async function openPhone(pair, { viewport = '412x915@2.625' } = {}) {
  const port = CDP_PORT + 1
  const dataDir = mkdtempSync(join(tmpdir(), 'wc-phone-'))
  const browser = BROWSERS.find((b) => existsSync(b))
  if (!browser) throw new Error('no Chrome or Edge found; set WC_E2E_BROWSER')
  const headless = process.env.WC_E2E_HEADED ? [] : ['--headless=new']
  const proc = spawn(browser, [
    ...headless,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(dataDir, 'browser')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    'about:blank',
  ], { stdio: 'ignore' })
  try {
    const page = await pageTarget(port, Date.now() + CDP_BOOT_MS, (u) => u === 'about:blank')
    const url = `${VITE_URL}?pair=${encodeURIComponent(pair)}`
    const cdp = await prepare(page, url, viewport)
    const app = new App({ cdp, dataDir, procs: [proc], target: 'browser' })
    await bootWait(app, cdp, url)
    return app
  } catch (e) {
    killTree(proc)
    await removeDataDir(dataDir, [proc])
    throw e
  }
}

export async function launch(options = {}) {
  const { wizard = false, settings, mock = true, env: extra, target = process.env.WC_E2E_TARGET || 'app', tag = 'run' } = options
  // The previous launch's browser may still be exiting.
  const portDeadline = Date.now() + PORT_FREE_MS
  while (await probe(`http://127.0.0.1:${CDP_PORT}/json/version`)) {
    if (Date.now() > portDeadline) throw new Error(`something already listens on CDP port ${CDP_PORT}; close it or set WC_CDP_PORT`)
    await sleep(POLL_MS * 4)
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'wc-e2e-'))
  if (!wizard || settings) {
    const seed = seedSettings(wizard ? merge(settings, { onboarded: false }) : settings)
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(seed, null, 2))
  }
  // Test projects (lib.mjs makeProject) count as trusted, as a folder you already trusted in the terminal would.
  const env = { ...process.env, WC_TRUST_FOLDERS: PROJECTS_ROOT, ...extra, WC_DATA_DIR: dataDir, WC_CDP_PORT: String(CDP_PORT) }
  if (mock) env.WC_MOCK = '1'
  else delete env.WC_MOCK
  await ensureVite()

  const procs = []
  let sidecarPort
  let url
  try {
    if (target === 'app') {
      if (!existsSync(EXE)) {
        throw new Error(`no debug build at ${EXE}; run \`cargo build --manifest-path app/src-tauri/Cargo.toml\` or set WC_E2E_EXE`)
      }
      // The shell turns WC_CDP_PORT into the WebView2 switches and a profile under WC_DATA_DIR (lib.rs enable_cdp).
      const log = logFile(`app-${tag}.log`)
      procs.push(spawn(EXE, [], { cwd: join(APP_DIR, 'src-tauri'), env, stdio: ['ignore', log, log] }))
    } else {
      sidecarPort = await freePort()
      const token = randomBytes(16).toString('hex')
      const log = logFile(`link-${tag}.log`)
      const link = spawn(process.execPath, [join('src', 'server.ts')], {
        cwd: LINK_DIR,
        env: { ...env, WC_PORT: String(sidecarPort), WC_TOKEN: token },
        stdio: ['pipe', log, log],
      })
      procs.push(link)
      const browser = BROWSERS.find((b) => existsSync(b))
      if (!browser) throw new Error('no Chrome or Edge found; set WC_E2E_BROWSER')
      const headless = process.env.WC_E2E_HEADED ? [] : ['--headless=new']
      procs.push(
        spawn(browser, [
          ...headless,
          `--remote-debugging-port=${CDP_PORT}`,
          `--user-data-dir=${join(dataDir, 'browser')}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--window-size=1600,900',
          // Her voice plays through the real audio graph (timing, loudness), just not out of the speakers.
          '--mute-audio',
          ...webviewArgs(),
          'about:blank',
        ], { stdio: 'ignore' }),
      )
      url = `${VITE_URL}?link=${sidecarPort}&token=${token}`
    }

    const deadline = Date.now() + CDP_BOOT_MS
    const isApp = (u) => u.startsWith(VITE_URL) || /^(tauri|https?:\/\/tauri\.)/.test(u)
    const page = await pageTarget(CDP_PORT, deadline, (u) => (target === 'app' ? isApp(u) : u === 'about:blank'))
    if (target === 'app' && !page.url.startsWith(VITE_URL)) {
      console.log(`    warning: the app loads ${page.url}, an embedded dist snapshot (a \`tauri build\`), not Vite; it may be stale`)
    }
    // The app's page is navigated to, not reloaded: a reload before WebView2 commits its first load reloads
    // about:blank and drops the pending navigation, leaving a stalled boot.
    const cdp = await prepare(page, url ?? page.url)
    const app = new App({ cdp, dataDir, procs, target, sidecarPort })
    // A retry navigates to the page the app had opened: reloading a load that stalled can leave about:blank.
    await bootWait(app, cdp, url ?? page.url)
    return app
  } catch (e) {
    for (const p of procs) killTree(p)
    await removeDataDir(dataDir, procs)
    throw e
  }
}
