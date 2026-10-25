import { open } from '@tauri-apps/plugin-dialog'
import type { Settings } from '../../link/src/protocol.ts'
import './theme.css'
import './base.css'
import { createCharacter } from './character'
import { chatScreen } from './chat'
import type { Ctx, Router, Screen, ScreenName } from './contracts'
import { connect } from './link'
import { savesScreen } from './screens/saves'
import { settingsScreen } from './screens/settings'
import { titleScreen } from './screens/title'
import { wizardScreen } from './screens/wizard'
import { applyAppearance, createStore } from './state'
import { createVoice } from './voice'

const STAGE_W = 1600
const STAGE_H = 900
const PETALS = 16

// The 1600×900 stage is scaled to fit the window around its center (R: no scrolling, any window size).
function fit() {
  const s = Math.min(innerWidth / STAGE_W, innerHeight / STAGE_H)
  const stage = document.getElementById('stage')!
  stage.style.transform = `translate(-50%, -50%) scale(${s})`
  stage.dataset.scale = String(s)
}
addEventListener('resize', fit)
fit()

for (let k = 0; k < PETALS; k++) {
  const p = document.createElement('i')
  p.className = 'petal'
  p.style.left = `${200 + Math.random() * 1500}px`
  p.style.animationDuration = `${9 + Math.random() * 9}s`
  p.style.animationDelay = `${-Math.random() * 18}s`
  document.getElementById('petals')!.appendChild(p)
}

// ---------------------------------------------------------------- shared helpers

function toast(text: string, ms = 2600) {
  const t = document.getElementById('toast')!
  t.textContent = text
  t.classList.add('show')
  clearTimeout(Number(t.dataset.timer))
  t.dataset.timer = String(setTimeout(() => t.classList.remove('show'), ms))
}

let closeConfirm: ((yes: boolean) => void) | undefined
function confirmDialog(title: string, body: string, yes = 'Yes', no = 'Cancel') {
  const box = document.getElementById('confirm')!
  document.getElementById('confirmTitle')!.textContent = title
  document.getElementById('confirmBody')!.textContent = body
  const yesBtn = document.getElementById('confirmYes')!
  const noBtn = document.getElementById('confirmNo')!
  yesBtn.textContent = yes
  noBtn.textContent = no
  box.classList.add('show')
  noBtn.focus()
  return new Promise<boolean>((resolve) => {
    closeConfirm = (answer) => {
      closeConfirm = undefined
      box.classList.remove('show')
      resolve(answer)
    }
    yesBtn.onclick = () => closeConfirm?.(true)
    noBtn.onclick = () => closeConfirm?.(false)
  })
}

async function pickFolder(title: string, defaultPath?: string) {
  const dir = await open({ directory: true, title, defaultPath: defaultPath || undefined }).catch(() => null)
  return typeof dir === 'string' ? dir : ''
}

function pickImages(multiple: boolean) {
  const input = document.getElementById('filePicker') as HTMLInputElement
  input.multiple = multiple
  input.value = ''
  return new Promise<{ name: string; dataUrl: string }[]>((resolve) => {
    input.onchange = async () => {
      const files = [...(input.files ?? [])]
      resolve(await Promise.all(files.map(async (f) => ({ name: f.name, dataUrl: await readAsDataUrl(f) }))))
    }
    input.click()
  })
}

export function readAsDataUrl(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

// ---------------------------------------------------------------- boot

const link = await connect()
const helloReply = link.next((m): m is Extract<typeof m, { t: 'hello' }> => m.t === 'hello', 30000)
link.send({ t: 'hello' })
const greeting = await helloReply
const store = createStore(link, greeting.settings as Settings)
applyAppearance(store.get())
store.subscribe(applyAppearance)
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyAppearance(store.get()))

link.onStatus((s) => document.getElementById('offline')!.classList.toggle('show', s === 'down'))

const character = createCharacter(document.getElementById('chara')!, link, store)

const screens: Record<ScreenName, Screen> = {
  title: titleScreen(),
  saves: savesScreen(),
  settings: settingsScreen(),
  chat: chatScreen(),
  wizard: wizardScreen(),
}
const history: ScreenName[] = []
let current: ScreenName | undefined

const router: Router = {
  go(name, params) {
    if (current === name) return void screens[name].show(params)
    if (current) {
      screens[current].hide()
      document.getElementById(`screen-${current}`)!.classList.remove('active')
      history.push(current)
      if (history.length > 20) history.shift()
    }
    current = name
    document.getElementById(`screen-${name}`)!.classList.add('active')
    document.getElementById('stage')!.dataset.screen = name
    screens[name].show(params)
  },
  current: () => current ?? 'title',
  back() {
    const prev = history.pop()
    // Back into the chat returns to the running session (Settings or Load opened from it); chat.show() with no
    // params falls back to the title when that session has ended. The wizard is never gone back to.
    router.go(prev && prev !== 'wizard' ? prev : 'title')
    history.pop()
  },
}

const voice = createVoice(link, store, greeting.voiceKey === true)
const ctx: Ctx = { link, store, character, router, voice, toast, confirm: confirmDialog, pickFolder, pickImages }
for (const [name, screen] of Object.entries(screens)) screen.mount(document.getElementById(`screen-${name}`)!, ctx)

// WebView2 keeps the browser's reload keys. Reloading would drop the page's session (the link closes it), so they
// never reach the browser. Ctrl+R is the CLI's history search; the chat composer handles it when focused.
addEventListener(
  'keydown',
  (e) => {
    const k = e.key.toLowerCase()
    if (e.key === 'F5' || (e.ctrlKey && !e.altKey && k === 'r')) {
      if (!(e.target as HTMLElement | null)?.closest?.('[data-wc-input]')) e.preventDefault()
    }
  },
  true,
)

// A file or link dropped anywhere outside the composer would navigate the window away from the app.
for (const type of ['dragover', 'drop'] as const) {
  addEventListener(type, (e) => {
    if (!e.defaultPrevented) e.preventDefault()
  })
}

// Esc: the confirm dialog first, then the screen on top (which closes its own overlays first).
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return
  if (closeConfirm) return void (e.preventDefault(), closeConfirm(false))
  if (current && screens[current].onEscape?.()) e.preventDefault()
})

// Expose a tiny hook for the E2E harness (tests/e2e): which screen is showing, and the link.
;(window as unknown as { __wc: unknown }).__wc = { router, store, link, character }

await character.ready
router.go(store.get().onboarded ? 'title' : 'wizard')
