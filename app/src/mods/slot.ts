// Mod panel slots: an enabled mod's panel as a sandboxed iframe in the chat screen's `chat.left` or `chat.right`
// host, bridged to the link (bridge.ts). No `allow-same-origin`, so a panel never reaches the app's DOM or storage.
// A panel that doesn't say `ready` within 10 s, or whose backend crashed, shows an error card with Retry and Disable.

import type { ModInfo, ServerMsg } from '../../../link/src/protocol.ts'
import type { Link } from '../contracts'
import { esc } from '../ui'
import { createBridge, type Bridge } from './bridge'
import './mods.css'

const READY_TIMEOUT_MS = 10_000
/** A panel may ask for any height in this range (waifufy.resize). */
const MIN_HEIGHT = 24
const MAX_HEIGHT = 1200

/** Mounts `mod`'s panel into `host`; returns its teardown. */
export function mountModPanel(host: HTMLElement, mod: ModInfo, link: Link): () => void {
  const el = document.createElement('section')
  el.className = 'mod-panel'
  el.dataset.test = 'mod-panel'
  el.dataset.id = mod.id
  host.append(el)

  let frame: HTMLIFrameElement | undefined
  let bridge: Bridge | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let failed = false

  function load() {
    failed = false
    el.innerHTML = ''
    frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.title = mod.name
    frame.src = mod.panel!.url
    el.append(frame)
    const f = frame
    bridge = createBridge(f, mod, link, {
      onReady: () => clearTimeout(timer),
      onResize: (px) => (f.style.height = `${Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, px))}px`),
    })
    clearTimeout(timer)
    timer = setTimeout(() => fail(`${mod.name} didn't load.`), READY_TIMEOUT_MS)
  }

  function unload() {
    clearTimeout(timer)
    bridge?.close()
    bridge = undefined
    frame = undefined
  }

  function fail(why: string) {
    if (failed) return
    failed = true
    unload()
    el.innerHTML = `<div class="mod-error" data-test="mod-error" role="alert">
        <p>${esc(why)}</p>
        <div class="mod-error-acts">
          <button type="button" class="pill" data-test="mod-retry">Retry</button>
          <button type="button" class="pill" data-test="mod-disable">Disable</button>
        </div>
      </div>`
    el.querySelector('[data-test="mod-retry"]')!.addEventListener('click', () => {
      // Turning it on again restarts a crashed backend; the frame reloads either way.
      link.send({ t: 'mod-enable', id: mod.id, enabled: true })
      load()
    })
    el.querySelector('[data-test="mod-disable"]')!.addEventListener('click', () => link.send({ t: 'mod-enable', id: mod.id, enabled: false }))
  }

  const offMods = link.on((m: ServerMsg) => {
    if (m.t !== 'mods') return
    const me = m.mods.find((x) => x.id === mod.id)
    if (me?.status === 'crashed') fail(`${mod.name} stopped working${me.reason ? `: ${me.reason}` : '.'}`)
  })
  let wasDown = false
  const offStatus = link.onStatus((s) => {
    if (s === 'down') return void (wasDown = true)
    if (!wasDown) return
    wasDown = false
    bridge?.theme()
    bridge?.event('reconnected')
  })

  if (mod.status === 'crashed') fail(`${mod.name} stopped working${mod.reason ? `: ${mod.reason}` : '.'}`)
  else load()

  return () => {
    unload()
    offMods()
    offStatus()
    el.remove()
  }
}

/**
 * Keeps one panel per enabled mod in its slot host, from the latest `mods` list. `hosts` gives the element a slot
 * mounts into (and the node to insert before); an unknown slot draws nothing. Returns `sync` and `clear`.
 */
export function createModSlots(link: Link, hosts: (slot: string) => { parent: HTMLElement; before: Node | null } | undefined) {
  /** Mounted panels by mod id, with the URL they were mounted from (a new token remounts). */
  const mounted = new Map<string, { url: string; off: () => void }>()
  let mods: ModInfo[] = []

  function sync(list = mods) {
    mods = list
    const wanted = mods.filter((m) => m.enabled && m.panel)
    for (const [id, p] of [...mounted]) {
      if (wanted.some((m) => m.id === id && m.panel!.url === p.url)) continue
      p.off()
      mounted.delete(id)
    }
    for (const mod of wanted) {
      if (mounted.has(mod.id)) continue
      const at = hosts(mod.panel!.slot)
      if (!at) continue
      const slot = document.createElement('div')
      slot.className = 'chat-mod'
      at.parent.insertBefore(slot, at.before)
      const off = mountModPanel(slot, mod, link)
      mounted.set(mod.id, { url: mod.panel!.url, off: () => (off(), slot.remove()) })
    }
  }

  function clear() {
    for (const p of mounted.values()) p.off()
    mounted.clear()
  }

  return { sync, clear }
}

/** The `_app` mod events: `theme.set` (CSS variables onto :root) and `notify` (a toast). Returns the unsubscribe. */
export function listenAppEvents(link: Link, toast: (text: string) => void): () => void {
  return link.on((m) => {
    if (m.t !== 'mod-event' || m.id !== '_app') return
    const p = m.payload as Record<string, unknown> | null
    if (!p || typeof p !== 'object') return
    if (m.type === 'theme.set') {
      // Only CSS variables, only strings: a mod themes the app, it doesn't restyle it.
      for (const [k, v] of Object.entries(p)) if (k.startsWith('--') && typeof v === 'string') document.documentElement.style.setProperty(k, v)
    } else if (m.type === 'notify' && typeof p.text === 'string') toast(p.text)
  })
}
