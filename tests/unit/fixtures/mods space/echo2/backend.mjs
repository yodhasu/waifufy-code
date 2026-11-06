// Test fixture: answers every request; `read` tries to read a file, `emit`/`app` push to the host.
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
let initInfo = null
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'shutdown') { send({ id: m.id, result: null }); setTimeout(() => process.exit(0), 10); return }
  if (m.id === undefined) return
  if (m.method === 'init') { initInfo = { env: [process.env.WC_MOD_ID, process.env.WC_MOD_DATA, process.env.WC_TOKEN ?? null], params: m.params }; return send({ id: m.id, result: true }) }
  if (m.method === 'tool.call') return send({ id: m.id, result: { tool: m.params.name, input: m.params.input } })
  if (m.method !== 'panel.call') return send({ id: m.id, error: { code: -32601, message: 'no method' } })
  const { method, params } = m.params
  if (method === 'info') send({ id: m.id, result: initInfo })
  else if (method === 'read') {
    try { send({ id: m.id, result: { ok: readFileSync(params.path, 'utf8') } }) } catch (e) { send({ id: m.id, result: { code: e.code } }) }
  } else if (method === 'emit') {
    send({ method: 'panel.emit', params: { type: 'tick', payload: params } })
    send({ id: m.id, result: true })
  } else if (method === 'app') {
    send({ id: 'a1', method: 'app.call', params: { capability: 'notify', params } })
    send({ id: m.id, result: true })
  } else send({ id: m.id, result: params })
})
