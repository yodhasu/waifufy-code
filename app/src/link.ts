import { invoke } from '@tauri-apps/api/core'
import type { ClientMsg, ServerMsg } from '../../link/src/protocol.ts'

export type Link = {
  /** HTTP base of the sidecar, which also serves Rem's model and voices. */
  base: string
  send(m: ClientMsg): void
  on(handler: (m: ServerMsg) => void): () => void
}

const RETRY_MS = 400

/** Connects to the sidecar the Tauri shell started, retrying until it is up and reconnecting if it drops. */
export async function connect(): Promise<Link> {
  const { port, token } = await invoke<{ port: number; token: string }>('link_info')
  const handlers = new Set<(m: ServerMsg) => void>()
  const outbox: ClientMsg[] = []
  let ws: WebSocket | undefined

  await new Promise<void>((ready) => {
    const open = () => {
      const s = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`)
      s.onopen = () => {
        ws = s
        for (const m of outbox.splice(0)) s.send(JSON.stringify(m))
        ready()
      }
      s.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as ServerMsg
        for (const h of handlers) h(m)
      }
      s.onclose = () => {
        if (ws === s) ws = undefined
        setTimeout(open, RETRY_MS)
      }
    }
    open()
  })

  return {
    base: `http://127.0.0.1:${port}`,
    send: (m) => (ws ? ws.send(JSON.stringify(m)) : void outbox.push(m)),
    on: (h) => (handlers.add(h), () => void handlers.delete(h)),
  }
}
