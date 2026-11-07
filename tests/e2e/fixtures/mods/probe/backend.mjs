// E2E fixture backend: `echo` answers its params, `emit` pushes a `tick` to the panel, `hang` never answers,
// a tool call answers its text as `echoed`, anything else answers true.
import { createInterface } from 'node:readline'
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'shutdown') return send({ id: m.id, result: null }), setTimeout(() => process.exit(0), 10)
  if (m.id === undefined) return
  if (m.method === 'tool.call') return send({ id: m.id, result: { echoed: m.params.input.text } })
  if (m.method !== 'panel.call') return send({ id: m.id, result: true })
  const { method, params } = m.params
  if (method === 'hang') return // never answers: the e2e drops the link while this call waits
  if (method === 'echo') return send({ id: m.id, result: params })
  if (method === 'emit') send({ method: 'panel.emit', params: { type: 'tick', payload: params } })
  send({ id: m.id, result: true })
})
