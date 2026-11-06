// E2E fixture backend: `echo` answers its params, `emit` pushes a `tick` to the panel, anything else answers true.
import { createInterface } from 'node:readline'
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'shutdown') return send({ id: m.id, result: null }), setTimeout(() => process.exit(0), 10)
  if (m.id === undefined) return
  if (m.method !== 'panel.call') return send({ id: m.id, result: true })
  const { method, params } = m.params
  if (method === 'echo') return send({ id: m.id, result: params })
  if (method === 'emit') send({ method: 'panel.emit', params: { type: 'tick', payload: params } })
  send({ id: m.id, result: true })
})
