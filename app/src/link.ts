import { invoke } from '@tauri-apps/api/core'
import type { ClientMsg, ServerMsg } from '../../link/src/protocol.ts'
import type { Link } from './contracts'

const RETRY_MS = 400

/**
 * Connects to the sidecar the Tauri shell started, retrying until it is up, and reconnecting if it
 * drops (the shell restarts a crashed sidecar). Outgoing messages sent while down are queued.
 * In a plain browser (tests, `vite` without Tauri) the port and token come from the URL:
 * `?link=51234&token=…`.
 */
export async function connect(): Promise<Link> {
  const { port, token } = await linkInfo()
  const handlers = new Set<(m: ServerMsg) => void>()
  const statusHandlers = new Set<(s: 'up' | 'down') => void>()
  const outbox: ClientMsg[] = []
  let ws: WebSocket | undefined

  const setStatus = (s: 'up' | 'down') => {
    for (const h of statusHandlers) h(s)
  }

  await new Promise<void>((ready) => {
    let isFirst = true
    const open = () => {
      const s = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`)
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
      s.onclose = () => {
        if (ws === s) {
          ws = undefined
          setStatus('down')
        }
        setTimeout(open, RETRY_MS)
      }
    }
    open()
  })

  const link: Link = {
    base: `http://127.0.0.1:${port}`,
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

async function linkInfo(): Promise<{ port: number; token: string }> {
  const q = new URLSearchParams(location.search)
  if (q.get('link')) return { port: Number(q.get('link')), token: q.get('token') ?? '' }
  return invoke<{ port: number; token: string }>('link_info')
}
