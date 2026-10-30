import { invoke } from '@tauri-apps/api/core'
import type { ClientMsg, ServerMsg } from '../../link/src/protocol.ts'
import type { Link } from './contracts'
import { clearCode, clearPairing, pair, savedCode, savedPairing, savePairing, waitForComputer, type Pairing } from './pair'

const RETRY_MS = 400
/** A phone's pause between rounds of trying every address, longer each time it finds none, up to the last. */
const BACKOFF_MS = [400, 1000, 2000, 3000, 5000]
/** A phone coming back to the front gives its connection this long to answer before opening a new one. */
const REVIVE_MS = 3000
/** A phone gives the desktop's addresses this long to answer, all at once, in each round. */
const REMOTE_TRY_MS = 3500
/** Addresses a phone remembers for its computer: the ones that worked, then what the computer last reported. */
const MAX_HOSTS = 8
/** The desktop closes a phone's connection with this code when it was unpaired (a new pairing code). */
const UNPAIRED = 4001
/** Why the pairing screen is back, kept across the reload that shows it. */
const PAIR_REASON = 'wc-pair-reason'

type Target = { hosts: string[]; port: number; token: string; remote: boolean }

/**
 * Connects to the link, retrying until it is up and reconnecting if it drops (the shell restarts a crashed
 * sidecar). Outgoing messages sent while down are queued.
 * - Desktop: the sidecar the Tauri shell started, on 127.0.0.1 (`link_info`).
 * - Phone (no sidecar, so no `link_info`): a desktop's link over the network, paired by its QR code (pair.ts). It
 *   never gives up on a pairing the computer would still take: it tries every address it knows at once (home Wi-Fi,
 *   Tailscale…), again and again, and asks to pair again only when the computer answers and refuses it.
 * - A plain browser (tests, `vite` without Tauri): `?link=51234&token=…`, or `?pair=<pairing link>` to act as a phone.
 */
export async function connect(): Promise<Link> {
  const target = await linkTarget()
  const handlers = new Set<(m: ServerMsg) => void>()
  const statusHandlers = new Set<(s: 'up' | 'down') => void>()
  const outbox: ClientMsg[] = []
  let ws: WebSocket | undefined
  let host = target.hosts[0]!
  let failed = 0

  const setStatus = (s: 'up' | 'down') => {
    for (const h of statusHandlers) h(s)
  }
  // `device`: this phone keeps a device token of its own when it pairs with the code (the computer sends one).
  const url = (h: string) => `ws://${h}:${target.port}/?token=${encodeURIComponent(target.token)}${target.remote ? '&device' : ''}`

  /** Remembers what worked first, then the rest, for the next time (and the next launch). */
  function remember(first: string, more: string[] = []) {
    target.hosts = [...new Set([first, ...target.hosts, ...more])].slice(0, MAX_HOSTS)
    if (target.remote) savePairing({ hosts: target.hosts, port: target.port, token: target.token })
  }

  /**
   * A phone whose computer won't take its token any more. With the pairing link it was paired with saved (and not
   * the token it just lost), it pairs again with that on its own: no trip to the computer. Otherwise it asks.
   */
  function unpaired(reason: string) {
    const code = savedCode()
    if (code && code.token !== target.token) {
      savePairing({ ...code, hosts: [...new Set([...target.hosts, ...code.hosts])].slice(0, MAX_HOSTS) })
      return location.reload()
    }
    clearCode()
    clearPairing()
    try {
      sessionStorage.setItem(PAIR_REASON, reason)
    } catch {
      // The pairing screen just shows its usual text.
    }
    location.reload()
  }

  let waiting: ReturnType<typeof waitForComputer> | undefined
  let reopen = () => {}
  await new Promise<void>((ready) => {
    let isFirst = true
    const adopt = (s: WebSocket, h: string) => {
      host = h
      failed = 0
      ws = s
      if (target.remote) remember(h)
      waiting?.close()
      waiting = undefined
      s.onmessage = (e) => {
        let m: ServerMsg
        try {
          m = JSON.parse(String(e.data)) as ServerMsg
        } catch {
          return
        }
        // The computer's addresses right now: a pairing from another network keeps finding it.
        if (m.t === 'hello' && m.addresses?.length && target.remote) remember(host, m.addresses)
        // Paired with the code: this phone's own token from now on, which a new pairing code never takes away.
        if (m.t === 'paired' && target.remote) (target.token = m.token), remember(host)
        for (const h of handlers) h(m)
      }
      s.onclose = (e) => {
        if (ws === s) {
          ws = undefined
          setStatus('down')
        }
        // The desktop made a new pairing code: this phone has to scan it.
        if (e.code === UNPAIRED) return unpaired('Your computer made a new pairing code. Scan it to connect again.')
        setTimeout(open, RETRY_MS)
      }
      for (const m of outbox.splice(0)) s.send(JSON.stringify(m))
      setStatus('up')
      if (isFirst) (isFirst = false), ready()
    }
    const open = async () => {
      if (!target.remote) {
        const s = new WebSocket(url(host))
        s.onopen = () => adopt(s, host)
        s.onclose = () => setTimeout(open, RETRY_MS)
        return
      }
      const won = await openAny(target.hosts.map((h) => ({ host: h, url: url(h) })), REMOTE_TRY_MS)
      if (won) return adopt(won.socket, won.host)
      failed++
      // Only the computer saying no (it was removed there) unpairs: a slow or missing network just means trying again.
      if (await refusedBy(target.hosts, target.port, target.token)) return unpaired('Your computer no longer takes this pairing. Scan its code again.')
      if (isFirst && !waiting) waiting = waitForComputer(target.hosts, () => unpaired(''))
      waiting?.update(failed)
      setTimeout(open, BACKOFF_MS[Math.min(failed, BACKOFF_MS.length) - 1])
    }
    reopen = () => void open()
    void open()
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
    // The address that answered last: model files load from the same place as the socket.
    get base() {
      return `http://${host}:${target.port}`
    },
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
  let reason: string | undefined
  try {
    reason = sessionStorage.getItem(PAIR_REASON) ?? undefined
    sessionStorage.removeItem(PAIR_REASON)
  } catch {
    // No reason to show, then.
  }
  // A browser posing as a phone (?pair=…) pairs from its URL, except straight after being unpaired, which would
  // otherwise pair it again with the same link.
  const fromUrl = q.get('pair')
  if (fromUrl && reason === undefined) savePairing(fromUrl)
  if (!fromUrl) {
    try {
      const { port, token } = await invoke<{ port: number; token: string }>('link_info')
      return { hosts: ['127.0.0.1'], port, token, remote: false }
    } catch {
      // No link_info: the phone app (or a browser without ?link), which pairs with a desktop instead.
    }
  }
  const p: Pairing = savedPairing() ?? (await pair(reason || undefined))
  return { ...p, remote: true }
}

/** Opens a socket to every address at once; the first to open is kept and the others are closed. */
function openAny(tries: { host: string; url: string }[], ms: number) {
  return new Promise<{ host: string; socket: WebSocket } | undefined>((resolve) => {
    const sockets: WebSocket[] = []
    let left = tries.length
    let done = false
    const finish = (won?: { host: string; socket: WebSocket }) => {
      if (done) return
      done = true
      clearTimeout(timer)
      for (const s of sockets) {
        if (s === won?.socket) continue
        s.onopen = s.onerror = s.onclose = null
        s.close()
      }
      if (won) won.socket.onopen = won.socket.onerror = won.socket.onclose = null
      resolve(won)
    }
    const timer = setTimeout(() => finish(), ms)
    for (const t of tries) {
      const s = new WebSocket(t.url)
      sockets.push(s)
      s.onopen = () => finish({ host: t.host, socket: s })
      s.onerror = () => void (--left === 0 && finish())
    }
    if (!tries.length) finish()
  })
}

/** Whether the computer answers, at any address, that it doesn't take this token (401). No answer is not a no. */
async function refusedBy(hosts: string[], port: number, token: string) {
  const one = (h: string) =>
    fetch(`http://${h}:${port}/paired?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(REMOTE_TRY_MS) }).then((r) =>
      r.status === 401 ? true : Promise.reject(),
    )
  return Promise.any(hosts.map(one)).then(() => true, () => false)
}
