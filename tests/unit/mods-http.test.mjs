// Unit check of link/src/mods/http.ts serveMod: panel files over real HTTP, per-mod token, path guard, SDK.
// Run: node tests/unit/mods-http.test.mjs
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { serveMod, panelToken, checkPanelToken } = await import('../../link/src/mods/http.ts')

const root = mkdtempSync(join(tmpdir(), 'wc-http-'))
const mk = (id) => {
  const dir = join(root, id)
  mkdirSync(join(dir, 'ui'), { recursive: true })
  writeFileSync(join(dir, 'mod.json'), '{"secret":true}')
  writeFileSync(join(dir, 'ui', 'index.html'), `<h1>${id}</h1>`)
  writeFileSync(join(dir, 'ui', 'app.js'), '1')
  return { id, dir, source: 'env', status: 'ok' }
}
const mods = [mk('tickets'), mk('other'), { ...mk('broken'), status: 'invalid' }]
const server = createServer((req, res) => { if (!serveMod(req, res, () => mods)) { res.writeHead(404); res.end('x') } })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const get = (p) => fetch(base + p) // fetch normalises '..', so raw paths go through http.get below
const raw = (path) => new Promise((ok) => {
  import('node:http').then(({ get }) => get({ host: '127.0.0.1', port: server.address().port, path }, (r) => { r.resume(); r.on('end', () => ok(r.statusCode)) }))
})

let failed = 0
async function test(name, fn) {
  try { await fn(); console.log(`ok   ${name}`) } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`) }
}
const eq = (a, b) => { if (a !== b) throw new Error(`${a} !== ${b}`) }

const pt = panelToken('tickets')
await test('serves ui/index.html with the CSP header', async () => {
  const r = await get(`/mods/tickets/ui/index.html?pt=${pt}`)
  eq(r.status, 200)
  eq(r.headers.get('content-security-policy'), "default-src 'self'; connect-src 'none'")
  eq(r.headers.get('content-type').startsWith('text/html'), true)
  eq(await r.text(), '<h1>tickets</h1>')
})
await test('js gets a js content type', async () => eq((await get(`/mods/tickets/ui/app.js?pt=${pt}`)).headers.get('content-type').startsWith('text/javascript'), true))
await test('/mods/tickets/ui/../mod.json → 404', async () => eq(await raw(`/mods/tickets/ui/../mod.json?pt=${pt}`), 404))
await test('%2e%2e encoded escape → 404', async () => {
  eq(await raw(`/mods/tickets/ui/%2e%2e/mod.json?pt=${pt}`), 404)
  eq(await raw(`/mods/tickets/ui/..%2fmod.json?pt=${pt}`), 404)
  eq(await raw(`/mods/tickets/ui/..%5cmod.json?pt=${pt}`), 404)
})
await test('wrong or missing pt → 403', async () => {
  eq((await get('/mods/tickets/ui/index.html')).status, 403)
  eq((await get('/mods/tickets/ui/index.html?pt=nope')).status, 403)
})
await test('pt of mod A does not open mod B', async () => eq((await get(`/mods/other/ui/index.html?pt=${pt}`)).status, 403))
await test('disabled or unknown id → 404', async () => {
  eq((await get(`/mods/ghost/ui/index.html?pt=${panelToken('ghost')}`)).status, 404)
  eq((await get(`/mods/broken/ui/index.html?pt=${panelToken('broken')}`)).status, 404)
})
await test('/mods/_sdk/waifufy.js served without a token', async () => {
  const r = await get('/mods/_sdk/waifufy.js')
  eq(r.status, 200)
  eq((await r.text()).includes('window.waifufy'), true)
})
await test('tokens are stable per id and checked', () => {
  eq(panelToken('tickets'), pt)
  eq(checkPanelToken('tickets', pt), true)
  eq(checkPanelToken('other', pt), false)
})
server.closeAllConnections(); server.close()
process.exitCode = failed ? 1 : 0
