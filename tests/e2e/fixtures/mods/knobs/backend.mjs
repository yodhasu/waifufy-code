// E2E fixture backend: keeps the settings it was given, pushes them to the settings page whenever they change.
import { createInterface } from 'node:readline'
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n')
let settings = {}
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'shutdown') return send({ id: m.id, result: null }), setTimeout(() => process.exit(0), 10)
  if (m.method === 'settings.changed') return void ((settings = m.params.settings), send({ method: 'panel.emit', params: { type: 'settings', payload: settings } }))
  if (m.id === undefined) return
  if (m.method === 'init') settings = m.params.settings
  if (m.method === 'panel.call' && m.params.method === 'settings') return send({ id: m.id, result: settings })
  send({ id: m.id, result: true })
})
