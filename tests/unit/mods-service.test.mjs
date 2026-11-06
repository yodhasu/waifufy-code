// Unit check of link/src/mods/index.ts Mods: enable flags, backends, app events, capabilities, panel emits, settings.
// Run: node tests/unit/mods-service.test.mjs   (no app, no Claude; spawns small backends written to a temp folder).
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'wc-mods-data-'))
process.env.WC_DATA_DIR = dataDir
const { discoverMods, modDataDir } = await import('../../link/src/mods/discover.ts')
const { ModHost } = await import('../../link/src/mods/host.ts')
const { Mods } = await import('../../link/src/mods/index.ts')

// A backend that counts its starts, keeps the events and settings it got, and can emit or call the app.
const BACKEND = `
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
appendFileSync(process.env.WC_MOD_DATA + '/starts.txt', 'x')
const events = []
let settings = null
const waiting = new Map()
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === undefined) { const w = waiting.get(m.id); waiting.delete(m.id); return w && w(m) }
  if (m.method === 'shutdown') { send({ id: m.id, result: null }); setTimeout(() => process.exit(0), 10); return }
  if (m.method === 'event') return events.push(m.params)
  if (m.method === 'settings.changed') return (settings = m.params.settings)
  if (m.method === 'init') { settings = m.params.settings; return send({ id: m.id, result: true }) }
  if (m.method === 'tool.call') return send({ id: m.id, result: { tool: m.params.name } })
  const { method, params } = m.params
  if (method === 'events') return send({ id: m.id, result: events })
  if (method === 'settings') return send({ id: m.id, result: settings })
  if (method === 'emit') { send({ method: 'panel.emit', params: { type: 'tick', payload: params } }); return send({ id: m.id, result: true }) }
  if (method === 'app') {
    const id = 'a' + m.id
    waiting.set(id, (r) => send({ id: m.id, result: r.error ? { error: r.error.message } : { value: r.result } }))
    return send({ id, method: 'app.call', params })
  }
  send({ id: m.id, result: params })
})
`

const root = mkdtempSync(join(tmpdir(), 'wc-mods-'))
function mod(id, manifest) {
  const dir = join(root, id)
  mkdirSync(join(dir, 'ui'), { recursive: true })
  writeFileSync(join(dir, 'ui', 'index.html'), `<h1>${id}</h1>`)
  writeFileSync(join(dir, 'backend.mjs'), BACKEND)
  writeFileSync(join(dir, 'mod.json'), JSON.stringify({ id, name: id, version: '1.0.0', apiVersion: 1, ...manifest }))
}
mod('alpha', {
  backend: { entry: 'backend.mjs' },
  panel: { entry: 'ui/index.html', slot: 'chat.left' },
  permissions: ['events.emotion', 'chat.send', 'theme', 'notify'],
  settings: [
    { key: 'name', type: 'string', label: 'Name', default: 'x' },
    { key: 'limit', type: 'number', label: 'Limit', default: 3 },
    { key: 'token', type: 'secret', label: 'Token' },
  ],
  tools: [{ name: 'alpha_tool', description: 'd', input: { type: 'object' } }],
})
mod('beta', { backend: { entry: 'backend.mjs' }, permissions: ['events.turn'], defaultEnabled: true })
mod('gamma', { panel: { entry: 'ui/index.html', slot: 'chat.right' }, permissions: ['events.emotion'] })

const none = join(dataDir, 'none')
const flags = {}
const clients = [[], []]
const appCalls = []
const host = new ModHost({ stopGraceMs: 300, restartDelayMs: 0 })
const mods = new Mods({
  host,
  discover: () => discoverMods({ env: root, installed: none, repo: none }),
  broadcast: (m) => clients.forEach((c) => c.push(m)),
  port: () => 4321,
  flags: async () => ({ ...flags }),
  setFlag: async (id, on) => void (flags[id] = on),
  app: (id, capability, params) => (appCalls.push([id, capability, params]), 'sent'),
})

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`PASS  ${name}`)
  } catch (e) {
    failures++
    console.log(`FAIL  ${name}\n      ${e.stack ?? e.message}`)
  }
}
const eq = (a, b, msg) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
}
const ok = (v, msg) => {
  if (!v) throw new Error(msg)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const info = (id) => mods.list().find((m) => m.id === id)
const starts = (id) => (existsSync(join(modDataDir(id), 'starts.txt')) ? readFileSync(join(modDataDir(id), 'starts.txt'), 'utf8').length : 0)
const clear = () => clients.forEach((c) => (c.length = 0))

try {
  await test('init starts the mods enabled by default and broadcasts the list', async () => {
    await mods.init()
    eq(info('beta').status, 'running', 'beta (defaultEnabled) runs')
    eq(info('alpha').status, 'off', 'alpha is off')
    eq(info('alpha').enabled, false, 'alpha not enabled')
    ok(!info('alpha').panel, 'a disabled mod has no panel')
    ok(clients[0].some((m) => m.t === 'mods'), 'list broadcast')
  })

  await test('enable starts one backend; enable twice quickly still one pid', async () => {
    await Promise.all([mods.enable('alpha', true), mods.enable('alpha', true)])
    eq(info('alpha').status, 'running', 'status')
    eq(info('alpha').enabled, true, 'enabled')
    eq(flags.alpha, true, 'flag written')
    eq(starts('alpha'), 1, 'started once')
    ok(alive(host.pid('alpha')), 'alive')
    eq(mods.served().map((m) => m.id), ['alpha', 'beta'], 'served mods are the enabled ones')
  })

  await test('list: panel url carries the link port and the panel token; values have defaults; tools of enabled mods', async () => {
    const a = info('alpha')
    ok(/^http:\/\/127\.0\.0\.1:4321\/mods\/alpha\/[0-9a-f]{32}\/ui\/index\.html$/.test(a.panel.url), a.panel.url)
    eq(a.panel.slot, 'chat.left', 'slot')
    eq(a.values, { name: 'x', limit: 3 }, 'values')
    eq(a.source, 'env', 'source')
    eq(mods.enabledTools().map((t) => `${t.id}:${t.tool.name}`), ['alpha:alpha_tool'], 'tools')
    eq(await mods.toolCall('alpha', 'alpha_tool', {}), { tool: 'alpha_tool' }, 'tool call')
  })

  await test('appEvent emotion reaches only mods with events.emotion', async () => {
    await mods.enable('gamma', true)
    clear()
    mods.appEvent('emotion', { emotion: 'happy' })
    mods.appEvent('turn.end', { ok: true })
    await sleep(100)
    const ev = clients[0].filter((m) => m.t === 'mod-event').map((m) => `${m.id}:${m.type}`)
    eq(ev, ['alpha:emotion', 'gamma:emotion', 'beta:turn.end'], 'panel events')
    eq(await mods.panelCall('alpha', 'events'), [{ type: 'emotion', payload: { emotion: 'happy' } }], 'alpha backend')
    eq(await mods.panelCall('beta', 'events'), [{ type: 'turn.end', payload: { ok: true } }], 'beta backend')
  })

  await test('mod-app capability without its permission → error "permission denied: chat.send"', async () => {
    let msg = ''
    await mods.appCall('beta', 'chat.send', { text: 'hi' }).catch((e) => (msg = e.message))
    eq(msg, 'permission denied: chat.send', 'panel call')
    // The same check for a backend's app.call.
    eq(await mods.panelCall('beta', 'app', { capability: 'chat.send', params: { text: 'hi' } }), { error: 'permission denied: chat.send' }, 'backend call')
    eq(appCalls, [], 'nothing reached the app')
    eq(await mods.appCall('alpha', 'chat.send', { text: 'hi' }), 'sent', 'with permission')
    eq(appCalls, [['alpha', 'chat.send', { text: 'hi' }]], 'app got it')
    clear()
    await mods.appCall('alpha', 'theme.set', { '--accent': 'red' })
    eq(clients[0].at(-1), { t: 'mod-event', id: '_app', type: 'theme.set', payload: { '--accent': 'red' } }, 'theme broadcast')
  })

  await test('notify is an _app toast event (no session involved); empty text is an error; needs its permission', async () => {
    clear()
    await mods.appCall('alpha', 'notify', { text: 'hello' })
    eq(clients[0].at(-1), { t: 'mod-event', id: '_app', type: 'notify', payload: { modId: 'alpha', text: 'hello' } }, 'toast event')
    eq(appCalls.length, 1, 'never handed to the app callback')
    let msg = ''
    await mods.appCall('alpha', 'notify', { text: '  ' }).catch((e) => (msg = e.message))
    eq(msg, 'notify needs a non-empty text', 'empty text')
    await mods.appCall('beta', 'notify', { text: 'x' }).catch((e) => (msg = e.message))
    eq(msg, 'permission denied: notify', 'no permission')
  })

  await test('toggling off then on quickly leaves one new backend running', async () => {
    const pid = host.pid('alpha')
    const before = starts('alpha')
    await Promise.all([mods.enable('alpha', false), mods.enable('alpha', true)])
    eq(info('alpha').status, 'running', 'status')
    eq(starts('alpha'), before + 1, 'started exactly once more')
    await sleep(100)
    ok(!alive(pid), 'previous process gone')
    ok(alive(host.pid('alpha')), 'new process alive')
  })

  await test('panel emit is broadcast to every connected client', async () => {
    clear()
    await mods.panelCall('alpha', 'emit', { n: 1 })
    await sleep(50)
    for (const c of clients) ok(c.some((m) => m.t === 'mod-event' && m.id === 'alpha' && m.type === 'tick' && m.payload.n === 1), JSON.stringify(c))
  })

  await test('settings values persist to mod-data/<id>/settings.json except secret fields', async () => {
    await mods.setSettings('alpha', { name: 'Rem', limit: 'lots', token: 's3cret', bogus: 1 })
    const file = JSON.parse(readFileSync(join(modDataDir('alpha'), 'settings.json'), 'utf8'))
    eq(file, { name: 'Rem' }, 'file')
    eq(info('alpha').values, { name: 'Rem', limit: 3 }, 'values shown (no secret)')
    await sleep(50)
    eq(await mods.panelCall('alpha', 'settings'), { name: 'Rem', limit: 3, token: 's3cret' }, 'backend got the secret')
  })

  await test('disable stops it and list shows off', async () => {
    const pid = host.pid('alpha')
    await mods.enable('alpha', false)
    eq(info('alpha').status, 'off', 'status')
    eq(info('alpha').enabled, false, 'enabled')
    await sleep(100)
    ok(!alive(pid), 'process gone')
    let msg = ''
    await mods.panelCall('alpha', 'events').catch((e) => (msg = e.message))
    ok(/not enabled/.test(msg), msg)
  })
} finally {
  await host.stopAll()
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
