import type { CtlOp, ServerMsg } from '../../../link/src/protocol.ts'
import type { Link } from '../contracts'

const CTL_TIMEOUT_MS = 30000

let seq = 0

/**
 * Calls one of the running session's SDK controls (link/src/protocol.ts CTL_OPS) and resolves with its result.
 * Rejects with the SDK's own error, or after CTL_TIMEOUT_MS (a reconnect to a slow MCP server can take a while).
 */
export function control<T = unknown>(link: Link, op: CtlOp, ...args: unknown[]): Promise<T> {
  const id = `ctl-${++seq}`
  type Result = Extract<ServerMsg, { t: 'ctl_result' }>
  const reply = link.next((m): m is Result => m.t === 'ctl_result' && m.id === id, CTL_TIMEOUT_MS)
  link.send({ t: 'ctl', id, op, args })
  return reply.then((m) => {
    if (!m.ok) throw new Error(m.error ?? `${op} failed`)
    return m.data as T
  })
}
