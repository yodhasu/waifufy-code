// The app half of the mod panel bridge: postMessage with one sandboxed panel iframe on one side, the link's
// `mod-*` messages on the other. Wire format: link/src/mods/sdk/waifufy.js (the panel half).
// Only messages whose source is this iframe's window are believed; replies go out with targetOrigin '*'
// because a sandboxed frame's origin is opaque.

import type { ModInfo, ServerMsg } from '../../../link/src/protocol.ts'
import type { Link } from '../contracts'

/** Panel → app message, as waifufy.js posts it. */
type PanelMsg = { wc: 1; kind: 'call' | 'app' | 'resize' | 'ready'; seq?: number; method?: string; capability?: string; params?: unknown }

export type Bridge = {
  /** Posts the app's theme variables to the panel. */
  theme(): void
  /** Posts an event (a backend push, an app event, `reconnected`) to the panel. */
  event(type: string, payload?: unknown): void
  close(): void
}

/** App-wide request counter: mod-reply is routed by (id, seq), so seqs from two frames of one mod never collide. */
let nextSeq = 0

/** Every `--*` custom property on :root, as the app currently resolves it. */
export function themeVars(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement)
  const vars: Record<string, string> = {}
  for (const name of Array.from(cs)) if (name.startsWith('--')) vars[name] = cs.getPropertyValue(name).trim()
  return vars
}

/**
 * Bridges `frame` to the link for `mod`. `onReady` runs on each `ready` (after the theme went out), `onResize` with
 * the height the panel asked for.
 */
export function createBridge(frame: HTMLIFrameElement, mod: ModInfo, link: Link, hooks: { onReady(): void; onResize(px: number): void }): Bridge {
  /** App seq → the panel's own seq, for calls waiting on a `mod-reply`. */
  const pending = new Map<number, number>()
  const post = (m: Record<string, unknown>) => frame.contentWindow?.postMessage({ wc: 1, ...m }, '*')

  const bridge: Bridge = {
    theme: () => post({ kind: 'theme', vars: themeVars() }),
    event: (type, payload) => post({ kind: 'event', type, payload }),
    close() {
      removeEventListener('message', onMessage)
      offLink()
      themeWatch.disconnect()
      pending.clear()
    },
  }

  function onMessage(e: MessageEvent) {
    if (!frame.contentWindow || e.source !== frame.contentWindow) return
    const d = e.data as PanelMsg | null
    if (!d || typeof d !== 'object' || d.wc !== 1) return
    if (d.kind === 'ready') return void (bridge.theme(), hooks.onReady())
    if (d.kind === 'resize') {
      const h = Number(d.params)
      if (Number.isFinite(h)) hooks.onResize(h)
      return
    }
    if ((d.kind !== 'call' && d.kind !== 'app') || !Number.isFinite(d.seq)) return
    const name = d.kind === 'call' ? d.method : d.capability
    if (typeof name !== 'string' || !name) return post({ kind: 'reply', seq: d.seq, ok: false, error: `no ${d.kind === 'call' ? 'method' : 'capability'}` })
    const seq = ++nextSeq
    pending.set(seq, d.seq!)
    if (d.kind === 'call') link.send({ t: 'mod-call', id: mod.id, seq, method: name, params: d.params })
    else link.send({ t: 'mod-app', id: mod.id, seq, capability: name, params: d.params })
  }

  const offLink = link.on((m: ServerMsg) => {
    if (m.t === 'mod-reply' && m.id === mod.id) {
      const theirs = pending.get(m.seq)
      if (theirs === undefined) return
      pending.delete(m.seq)
      post({ kind: 'reply', seq: theirs, ok: m.ok, value: m.value, error: m.error })
    } else if (m.t === 'mod-event' && m.id === mod.id) bridge.event(m.type, m.payload)
  })

  // A theme or accent change (state.ts) or a mod's theme.set lands on :root's attributes.
  const themeWatch = new MutationObserver(() => bridge.theme())
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme', 'class'] })

  addEventListener('message', onMessage)
  return bridge
}
