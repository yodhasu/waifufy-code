// Newline-delimited JSON-RPC 2.0 over a pair of streams: the wire between the link and a mod's backend.
// Anything on the input that is not a JSON-RPC message (a stray console.log) goes to onLog instead of breaking
// the connection, and a line over 1 MB is dropped and reported.

import type { Readable, Writable } from 'node:stream'

const MAX_LINE = 1024 * 1024

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export class RpcPeer {
  private pending = new Map<number, Pending>()
  private nextId = 1
  private buf = ''
  private skipping = false
  private closed = false

  private input: Readable
  private output: Writable
  private onRequest: (method: string, params: unknown) => Promise<unknown>
  private onLog: (line: string) => void

  constructor(
    input: Readable,
    output: Writable,
    onRequest: (method: string, params: unknown) => Promise<unknown>,
    onLog: (line: string) => void,
  ) {
    this.input = input
    this.output = output
    this.onRequest = onRequest
    this.onLog = onLog
    input.setEncoding('utf8')
    input.on('data', this.onData)
    input.on('error', () => {})
    output.on('error', () => {}) // a dead child must not take the link down with an EPIPE
  }

  private onData = (chunk: string) => {
    this.buf += chunk
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      if (this.skipping) this.skipping = false // the tail of an oversize line
      else if (line.length > MAX_LINE) this.onLog(`line too long (over ${MAX_LINE} bytes), dropped`)
      else this.line(line)
    }
    if (this.buf.length > MAX_LINE) {
      if (!this.skipping) this.onLog(`line too long (over ${MAX_LINE} bytes), dropped`)
      this.skipping = true
      this.buf = ''
    }
  }

  private line(raw: string) {
    const text = raw.trim()
    if (!text) return
    let msg: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { message?: string } }
    try {
      msg = JSON.parse(text)
      if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) throw new Error('not an object')
    } catch {
      this.onLog(text)
      return
    }
    if (typeof msg.method === 'string') {
      const id = msg.id
      this.onRequest(msg.method, msg.params).then(
        (result) => id !== undefined && this.send({ jsonrpc: '2.0', id, result: result ?? null }),
        (e) => id !== undefined && this.send({ jsonrpc: '2.0', id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } }),
      )
    } else if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(msg.error.message ?? 'rpc error'))
      else p.resolve(msg.result)
    } else this.onLog(text)
  }

  private send(obj: object) {
    if (!this.closed) this.output.write(JSON.stringify(obj) + '\n')
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('connection closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  /** Stop reading and fail every request still waiting. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.input.off('data', this.onData)
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('connection closed'))
    }
    this.pending.clear()
  }
}
