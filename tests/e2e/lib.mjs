// Shared assertions and flows for the E2E scenarios. Everything goes through data-test hooks
// (docs/V1.md "Test hooks") and window.__wc, never through layout or class names.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export { MOCK } from '../../link/src/mock.ts'
export { EMOTIONS } from '../../link/src/protocol.ts'

/** Selector for a test hook plus data-* attributes: T('ask-option', { v: 'allow' }). */
export const T = (name, attrs = {}) =>
  `[data-test="${name}"]` + Object.entries(attrs).map(([k, v]) => `[data-${k}="${String(v).replace(/"/g, '\\"')}"]`).join('')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** How long a "leave mid-turn?" confirmation gets to appear. */
const CONFIRM_MS = 800
const READ_POLL_MS = 100
/** A visible surface brighter than this (relative luminance 0..1) in dark mode is a raw light color. */
const BRIGHT_LUMINANCE = 0.82
/** Backgrounds more transparent than this let the themed surface under them show through. */
const MIN_SURFACE_ALPHA = 0.5
const MAX_REPORTED = 12

/** Thrown by `skip()`: the runner reports SKIP with the reason instead of FAIL. */
export class Skip extends Error {}
export const skip = (reason) => {
  throw new Skip(reason)
}

export function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

export function eq(actual, expected, msg) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`)
}

export function near(actual, expected, tolerance, msg) {
  if (Math.abs(actual - expected) > tolerance) throw new Error(`${msg}: expected ${expected} ± ${tolerance}, got ${actual}`)
}

/** Whether `want` appears in `list` in order (other items may sit in between). */
export function inOrder(list, want) {
  let k = 0
  for (const v of list) if (v === want[k]) k++
  return k === want.length
}

const PROJECT_FILES = {
  'README.md': '# booking-agent\n\nThe booking agent.\n',
  'package.json': '{ "name": "booking-agent", "version": "1.4.0" }\n',
  'src/app.ts': "export const app = 'booking'\n",
  'src/prompts/loader.ts': "const TEMPLATE = 'booking-v12'\nexport const prompt = () => TEMPLATE\n",
  'src/flows/booking.ts': 'export const booking = true\n',
  'docs/notes.md': 'notes\n',
  '.gitignore': 'secret/\nnode_modules/\n',
  'secret/hidden-token.txt': 'never list me\n',
  'node_modules/leftpad/index.js': 'module.exports = 1\n',
}

/** Temp folders made by makeProject() and tempDir(), removed by removeTempDirs() at the end of a run. */
const made = []

/** An empty temp folder that removeTempDirs() deletes. */
export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

export function removeTempDirs() {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/** A throwaway project folder (a git repo, so .gitignore applies) to start sessions in. */
export function makeProject(name = 'booking-agent') {
  const dir = join(tempDir('wc-e2e-proj-'), name)
  for (const [rel, body] of Object.entries(PROJECT_FILES)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' })
  } catch {
    // Without git the @ picker may still honor .gitignore; the scenario reports what it sees.
  }
  return dir
}

export const folderName = (dir) => basename(dir)

// ---------------------------------------------------------------- navigation and sessions

export async function waitScreen(app, name, timeout = 10_000) {
  await app.waitFor((n) => window.__wc.router.current() === n && document.getElementById(`screen-${n}`)?.classList.contains('active'), {
    args: [name],
    timeout,
    label: `screen ${name}`,
  })
}

/** Back to the title the way a user leaves a chat (MENU, which saves the session's meta and thumbnail). */
export async function toTitle(app) {
  if ((await app.screen()) === 'chat' && (await app.visible(T('qm-menu')))) {
    await app.click(T('qm-menu'))
    // Leaving mid-turn asks first.
    if (await app.waitVisible('#confirm', CONFIRM_MS).catch(() => false)) await app.click('#confirmYes')
  } else await app.go('title')
  await waitScreen(app, 'title')
}

/**
 * Starts a chat in `cwd` the way New Game does after the folder picker (which can't be driven), and
 * waits for the session's `ready`. Returns the `start` message the app sent.
 */
export async function newGame(app, cwd, params = {}) {
  const m = await app.mark()
  await app.go('chat', { cwd, ...params })
  await waitScreen(app, 'chat')
  const start = await app.waitSent('start', { cwd }, m, 15_000)
  await app.waitEvent('ready', { epoch: start.epoch }, m, 20_000)
  await app.waitVisible(T('chat-input'))
  return start
}

/** Types `text` into the chat input and presses Enter; returns the mark from before, for waitEvent. */
export async function say(app, text) {
  const m = await app.mark()
  await focusInput(app)
  await app.type(text)
  await app.key('Enter')
  await app.waitSent('say', { text }, m)
  return m
}

export async function focusInput(app) {
  await app.waitFor(() => !document.querySelector('[data-test="chat-input"]')?.disabled, { label: 'chat input enabled' })
  await app.click(T('chat-input'))
}

export const turnEnd = (app, from, timeout = 45_000) => app.waitEvent('turn_end', {}, from, timeout)

/** Text instantly and AUTO-advance fast, for tests that are not about the typewriter. */
export const fastText = (app) => app.updateSettings({ motion: { textCps: 0, autoDelayMs: 50 } })

export function dialogueState(app) {
  return app.eval(() => ({
    text: document.querySelector('[data-test="dialogue-text"]')?.textContent ?? '',
    name: document.querySelector('[data-test="dialogue-name"]')?.textContent ?? '',
    talking: document.getElementById('chara').dataset.talking,
    more: window.__e2e.visible('[data-test="dialogue-advance"]'),
  }))
}

/** Clicks through every remaining page of the current reply until nothing is typing or pending. */
export async function readAll(app, { timeout = 60_000, settleMs = 500 } = {}) {
  const deadline = Date.now() + timeout
  let last = ''
  let stableSince = Date.now()
  while (Date.now() < deadline) {
    const s = await dialogueState(app)
    if (s.text !== last) (last = s.text), (stableSince = Date.now())
    if (s.more) await app.click(T('dialogue'))
    else if (s.talking !== '1' && Date.now() - stableSince > settleMs) return s
    await sleep(READ_POLL_MS)
  }
  throw new Error('the dialogue never settled')
}

/** The saves list straight from the sidecar. */
export function savesList(app) {
  return app.eval(async () => {
    const reply = window.__wc.link.next((m) => m.t === 'saves', 5000)
    window.__wc.link.send({ t: 'saves' })
    return (await reply).list
  })
}

/** Plays one short session in `cwd` (New Game, one line, back to the title) so a save exists. */
export async function playSession(app, cwd, line = 'hello there') {
  await newGame(app, cwd)
  await fastText(app)
  const m = await say(app, line)
  await turnEnd(app, m)
  await readAll(app, { timeout: 20_000 })
  await toTitle(app)
}

// ---------------------------------------------------------------- generic UI helpers

/** Marks the first visible element under `scope` whose text matches `re` and returns a selector for it. */
export async function byText(app, re, scope = '#stage', tags = 'button, [role=button], a, .btn') {
  const ok = await app.eval(
    (src, flags, sc, tg) => {
      document.querySelectorAll('[data-e2e-pick]').forEach((el) => el.removeAttribute('data-e2e-pick'))
      const rx = new RegExp(src, flags)
      const root = document.querySelector(sc)
      const el = [...(root?.querySelectorAll(tg) ?? [])].find((e) => window.__e2e.isVisible(e) && rx.test(e.textContent ?? ''))
      el?.setAttribute('data-e2e-pick', '1')
      return Boolean(el)
    },
    re.source,
    re.flags,
    scope,
    tags,
  )
  return ok ? '[data-e2e-pick="1"]' : undefined
}

/** The test-hook names of the elements that look selected or focused within `sel` matches (for keyboard menus). */
export function selectedHook(app, sel) {
  return app.eval((s) => {
    const items = [...document.querySelectorAll(s)].filter((el) => window.__e2e.isVisible(el))
    const marks = ['selected', 'active', 'sel', 'current', 'focus', 'is-selected', 'hover']
    const hit =
      items.find((el) => el === document.activeElement || el.contains(document.activeElement)) ??
      items.find((el) => el.getAttribute('aria-selected') === 'true' || el.dataset.selected === '1' || el.dataset.selected === 'true') ??
      items.find((el) => marks.some((c) => el.classList.contains(c)))
    return hit?.dataset.test ?? hit?.dataset.v ?? hit?.dataset.name ?? null
  }, sel)
}

/**
 * Sets a settings field `set-<path>` whatever widget it is: input, select, textarea, checkbox, or a
 * group of buttons carrying data-v. Returns the widget kind it found. The wizard and the settings page
 * share field hooks, so the lookup is scoped to the active screen.
 */
export async function setField(app, path, value, scope = '.screen.active') {
  const sel = `${scope} ${T(`set-${path}`)}`
  await app.waitFor((s) => document.querySelector(s), { args: [sel], label: sel })
  const kind = await app.eval(
    (s, v) => {
      const host = document.querySelector(s)
      const control = host.matches('input, select, textarea') ? host : host.querySelector('input, select, textarea')
      const option = host.querySelector(`[data-v="${String(v)}"]`)
      if (option && (!control || control.type === 'radio')) return 'option'
      if (!control) return 'none'
      if (control.type === 'checkbox') return control.checked === Boolean(v) ? 'checkbox-same' : 'checkbox'
      return 'value'
    },
    sel,
    value,
  )
  if (kind === 'option') await app.click(`${sel} [data-v="${String(value)}"]`)
  else if (kind === 'checkbox') {
    // A styled switch hides its checkbox; the user clicks the label around it.
    await app.eval((s) => {
      document.querySelectorAll('[data-e2e-pick]').forEach((el) => el.removeAttribute('data-e2e-pick'))
      const host = document.querySelector(s)
      const box = host.matches('input') ? host : host.querySelector('input')
      const target = window.__e2e.isVisible(box) ? box : (box.closest('label') ?? box.parentElement)
      target.setAttribute('data-e2e-pick', 'toggle')
    }, sel)
    await app.click('[data-e2e-pick="toggle"]')
  } else if (kind === 'value') {
    const target = await app.eval((s) => (document.querySelector(s).matches('input, select, textarea') ? s : `${s} input, ${s} select, ${s} textarea`), sel)
    await app.setValue(target, typeof value === 'number' ? String(value) : value)
  } else if (kind === 'none') throw new Error(`${sel} has no input, select, textarea or [data-v="${value}"] option`)
  return kind
}

/**
 * In dark mode, lists visible test-hooked elements and panels whose own background is bright, which means
 * a raw color slipped past the theme tokens (R46).
 */
export function brightSurfaces(app, threshold = BRIGHT_LUMINANCE) {
  return app.eval((limit, minAlpha, max) => {
    const parse = (c) => (c.match(/[\d.]+/g) ?? []).map(Number)
    const out = []
    for (const el of document.querySelectorAll('.screen.active *, .overlay.show *')) {
      // Media and swatches of user-chosen colors (accent, nameplate) are not theme surfaces.
      if (el.matches('img, canvas, video, input[type=color]') || el.style.background || el.style.backgroundColor) continue
      if (!window.__e2e.isVisible(el)) continue
      const [r, g, b, a = 1] = parse(getComputedStyle(el).backgroundColor)
      if (a < minAlpha) continue
      // Relative luminance (Rec. 709 weights).
      const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      if (l > limit) out.push(`${el.tagName.toLowerCase()}${el.dataset.test ? `[data-test=${el.dataset.test}]` : ''}.${[...el.classList].join('.')}`)
    }
    return [...new Set(out)].slice(0, max)
  }, threshold, MIN_SURFACE_ALPHA, MAX_REPORTED)
}
