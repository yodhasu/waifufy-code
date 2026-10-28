import { invoke } from '@tauri-apps/api/core'
import type { ClientMsg, ServerMsg } from '../../link/src/protocol.ts'
import type { Link } from './contracts'
import { clearPairing, pair, savedPairing, savePairing, type Pairing } from './pair'

const RETRY_MS = 400
/** A phone coming back to the front gives its connection this long to answer before opening a new one. */
const REVIVE_MS = 3000
/** A phone gives each of the desktop's addresses this long to answer before trying the next. */
const REMOTE_TRY_MS = 3500
/** The desktop closes a phone's connection with this code when it was unpaired (a new pairing code). */
const UNPAIRED = 4001

type Target = { hosts: string[]; port: number; token: string; remote: boolean }

/**
 * Connects to the link, retrying until it is up and reconnecting if it drops (the shell restarts a crashed
 * sidecar). Outgoing messages sent while down are queued.
 * - Desktop: the sidecar the Tauri shell started, on 127.0.0.1 (`link_info`).
 * - Phone (no sidecar, so no `link_info`): a desktop's link over the network, paired by its QR code (pair.ts).
 * - A plain browser (tests, `vite` without Tauri): `?link=51234&token=…`, or `?pair=<pairing link>` to act as a phone.
 */
export async function connect(): Promise<Link> {
  let target = await linkTarget()
  const handlers = new Set<(m: ServerMsg) => void>()
  const statusHandlers = new Set<(s: 'up' | 'down') => void>()
  const outbox: ClientMsg[] = []
  let ws: WebSocket | undefined

  const setStatus = (s: 'up' | 'down') => {
    for (const h of statusHandlers) h(s)
  }
  const url = (host: string) => `ws://${host}:${target.port}/?token=${encodeURIComponent(target.token)}`

  // A phone finds which of the desktop's addresses answers (home Wi-Fi, Tailscale…), and pairs again if none does.
  if (target.remote) target = await reachable(target)

  let reopen = () => {}
  await new Promise<void>((ready) => {
    let isFirst = true
    const open = () => {
      const s = new WebSocket(url(target.hosts[0]!))
      s.onopen = () => {
        ws = s
        for (const m of outbox.splice(0)) s.send(JSON.stringify(m))
        setStatus('up')
        if (isFirst) (isFirst = false), ready()
      }
      s.onmessage = (e) => {
        let m: ServerMsg
        try {
          m = JSON.parse(String(e.data)) as ServerMsg
        } catch {
          return
        }
        for (const h of handlers) h(m)
      }
      s.onclose = (e) => {
        if (ws === s) {
          ws = undefined
          setStatus('down')
        }
        // The desktop made a new pairing code: this phone has to scan it.
        if (e.code === UNPAIRED) {
          clearPairing()
          return location.reload()
        }
        setTimeout(open, RETRY_MS)
      }
    }
    reopen = open
    open()
  })

  // Back from the background, a phone's socket may look open while the network under it is gone (Android kept the
  // object, not the connection). One round trip tells; without an answer it is closed, and reconnects at once.
  if (target.remote) {
    addEventListener('visibilitychange', () => {
      const s = ws
      if (document.visibilityState !== 'visible' || !s) return
      let answered = false
      const off = (m: ServerMsg) => void (m.t === 'hello' && (answered = true))
      handlers.add(off)
      s.send(JSON.stringify({ t: 'hello' } satisfies ClientMsg))
      setTimeout(() => {
        handlers.delete(off)
        if (answered || ws !== s) return
        // Let go of it at once: a socket whose network is gone can take long to finish closing, and meanwhile
        // messages would go into it instead of the outbox.
        ws = undefined
        s.onclose = s.onmessage = null
        s.close()
        setStatus('down')
        reopen()
      }, REVIVE_MS)
    })
  }

  const link: Link = {
    base: `http://${target.hosts[0]}:${target.port}`,
    remote: target.remote,
    send: (m) => (ws ? ws.send(JSON.stringify(m)) : void outbox.push(m)),
    on: (h) => (handlers.add(h), () => void handlers.delete(h)),
    onStatus: (h) => (statusHandlers.add(h), () => void statusHandlers.delete(h)),
    next: (pred, timeoutMs = 15000) =>
      new Promise((resolve, reject) => {
        const off = link.on((m) => {
          if (!pred(m)) return
          off()
          clearTimeout(timer)
          resolve(m)
        })
        const timer = setTimeout(() => (off(), reject(new Error('timed out waiting for the link'))), timeoutMs)
      }),
  }
  return link
}

async function linkTarget(): Promise<Target> {
  const q = new URLSearchParams(location.search)
  if (q.get('link')) return { hosts: ['127.0.0.1'], port: Number(q.get('link')), token: q.get('token') ?? '', remote: false }
  const fromUrl = q.get('pair')
  if (fromUrl) savePairing(fromUrl)
  if (!fromUrl) {
    try {
      const { port, token } = await invoke<{ port: number; token: string }>('link_info')
      return { hosts: ['127.0.0.1'], port, token, remote: false }
    } catch {
      // No link_info: the phone app (or a browser without ?link), which pairs with a desktop instead.
    }
  }
  const p = savedPairing() ?? (await pair())
  return { ...p, remote: true }
}

/** Whether a WebSocket to `url` opens (and is let in) within `ms`. */
function opens(url: string, ms: number) {
  return new Promise<boolean>((resolve) => {
    const s = new WebSocket(url)
    const done = (ok: boolean) => {
      clearTimeout(timer)
      s.onopen = s.onerror = s.onclose = null
      s.close()
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), ms)
    s.onopen = () => done(true)
    s.onerror = () => done(false)
  })
}

/** Puts the first address that answers first; with none, asks to pair again, saying why. */
async function reachable(t: Target): Promise<Target> {
  let p: Pairing = t
  for (;;) {
    for (const host of p.hosts) {
      if (await opens(`ws://${host}:${p.port}/?token=${encodeURIComponent(p.token)}`, REMOTE_TRY_MS)) {
        const ordered = { ...p, hosts: [host, ...p.hosts.filter((h) => h !== host)] }
        savePairing(ordered)
        return { ...ordered, remote: true }
      }
    }
    p = await pair(`Couldn't reach your computer at ${p.hosts.join(' or ') || 'any address'}. Is Waifufy Code open there, with phone access on, and is this phone on the same network (or Tailscale)?`)
  }
}
