// Unit check of link/src/mods/host.ts ModHost + nodeArgs(): backend processes under Node's permission model.
// Run: node tests/unit/mods-host.test.mjs   (no app, no Claude; spawns small fixture backends).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dataDir = mkdtempSync(join(tmpdir(), 'wc-host-data-'))
process.env.WC_DATA_DIR = dataDir
process.env.WC_TOKEN = 'secret-token'
const { discoverMods, modDataDir } = await import('../../link/src/mods/discover.ts')
const { ModHost, nodeArgs } = await import('../../link/src/mods/host.ts')

const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url))
const none = join(dataDir, 'none')
const find = (root) => discoverMods({ env: join(FIX, root), installed: none, repo: none })
const mods = Object.fromEntries([...find('mods'), ...find('mods space')].map((m) => [m.id, m]))

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`PASS  ${name}`)
  } catch (e) {
    failures++
    console.log(`FAIL  ${name}\n      ${e.message}`)
  }
}
const eq = (a, b, msg) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fast = { stopGraceMs: 300, restartDelayMs: 0 }
const withPerms = (m, permissions) => ({ ...m, manifest: { ...m.manifest, permissions } })
const starts = (id) => {
  try {
    return readFileSync(join(modDataDir(id), 'starts.txt'), 'utf8').length
  } catch {
    return 0
  }
}

await test('nodeArgs: permission flags, declared paths expanded, spawn rights only when declared', () => {
  const a = nodeArgs(withPerms(mods.echo, ['fs.read:%APPDATA%/xx', 'fs.write:~/yy', 'notify']))
  if (!a.includes('--permission')) throw new Error('no --permission')
  if (!a.includes(`--allow-fs-read=${mods.echo.dir}`)) throw new Error('mod dir not readable')
  if (!a.includes(`--allow-fs-write=${modDataDir('echo')}`)) throw new Error('data dir not writable')
  if (!a.some((x) => x.startsWith('--allow-fs-read=') && x.endsWith('xx') && !x.includes('%'))) throw new Error('APPDATA not expanded')
  if (!a.some((x) => x.startsWith('--allow-fs-write=') && x.endsWith('yy') && !x.includes('~'))) throw new Error('~ not expanded')
  if (a.includes('--allow-child-process') || a.includes('--allow-worker')) throw new Error('spawn rights without declaration')
  const b = nodeArgs(withPerms(mods.echo, ['process.spawn', 'process.worker']))
  if (!b.includes('--allow-child-process') || !b.includes('--allow-worker')) throw new Error('declared rights missing')
})

await test('echo: init then panel.call returns params; toolCall routes to tool.call', async () => {
  const h = new ModHost(fast)
  await h.start(withPerms(mods.echo, ['notify']), { a: 1 })
  eq(h.status('echo'), 'running', 'status')
  eq(await h.panelCall('echo', 'ping', { n: 2 }), { n: 2 }, 'panel.call')
  eq(await h.toolCall('echo', 'tool-x', { q: 1 }), { tool: 'tool-x', input: { q: 1 } }, 'tool.call')
  const info = await h.panelCall('echo', 'info', null)
  eq(info.params, { apiVersion: 1, settings: { a: 1 }, grantedPermissions: ['notify'] }, 'init params')
  eq(info.env, ['echo', modDataDir('echo'), null], 'env has id and data dir, no link token')
  await h.stopAll()
  eq(h.status('echo'), 'off', 'after stop')
})

await test('mod -> link: panel.emit and app.call surface as events', async () => {
  const h = new ModHost(fast)
  await h.start(mods.echo, {})
  const got = []
  h.on('emit', (id, m) => got.push(['emit', id, m]))
  h.on('app', (id, m, reply) => {
    got.push(['app', id, m])
    reply('done')
  })
  await h.panelCall('echo', 'emit', { z: 1 })
  await h.panelCall('echo', 'app', { t: 'hi' })
  await sleep(50)
  eq(got, [['emit', 'echo', { type: 'tick', payload: { z: 1 } }], ['app', 'echo', { capability: 'notify', params: { t: 'hi' } }]], 'events')
  await h.stopAll()
})

await test('hang: panelCall rejects after the injected timeout with "timed out"; stop still kills it', async () => {
  const h = new ModHost({ ...fast, panelTimeoutMs: 200 })
  await h.start(mods.hang, {})
  let msg = ''
  await h.panelCall('hang', 'x', {}).catch((e) => (msg = e.message))
  if (!/timed out/.test(msg)) throw new Error(`got "${msg}"`)
  const pid = h.pid('hang')
  await h.stopAll()
  await sleep(100)
  if (alive(pid)) throw new Error('hung child survived stop')
})

await test('crash: restarts up to 3 times in the window then status crashed', async () => {
  const h = new ModHost(fast)
  const seen = []
  h.on('status', (id, s) => seen.push(s))
  await h.start(mods.crash, {})
  for (let i = 0; i < 100 && h.status('crash') !== 'crashed'; i++) await sleep(50)
  eq(h.status('crash'), 'crashed', 'status')
  eq(starts('crash'), 4, 'starts (1 + 3 restarts)')
  eq(seen.at(-1), 'crashed', 'status event')
  await h.stopAll()
})

await test('crash: crashes older than the window do not count', async () => {
  rmSync(join(modDataDir('crash'), 'starts.txt'), { force: true })
  let t = 0
  const h = new ModHost({ ...fast, now: () => t, restartWindowMs: 1000 })
  await h.start(mods.crash, {})
  for (let i = 0; i < 6; i++) {
    // The clock jumps past the window before each crash, so the host never sees more than one.
    t += 5000
    const n = starts('crash')
    for (let j = 0; j < 100 && starts('crash') === n; j++) await sleep(30)
  }
  eq(h.status('crash'), 'running', 'status')
  await h.stopAll()
})

await test('noisy: non-JSON and oversize stdout is logged, next request still answers; stderr goes to mod.log', async () => {
  const h = new ModHost(fast)
  await h.start(mods.noisy, {})
  eq(await h.panelCall('noisy', 'm', { k: 1 }), { method: 'm', params: { k: 1 } }, 'answer')
  await h.stopAll()
  const log = readFileSync(join(modDataDir('noisy'), 'mod.log'), 'utf8')
  if (!log.includes('hello, I am not json')) throw new Error('junk line not logged')
  if (!log.includes('some stderr')) throw new Error('stderr not logged')
  if (!log.includes('too long')) throw new Error('oversize line not reported')
  if (log.length > 200_000) throw new Error('oversize line was logged in full')
})

await test('stopAll leaves no child processes', async () => {
  const h = new ModHost(fast)
  await h.start(mods.echo, {})
  await h.start(mods.hang, {})
  const pids = [h.pid('echo'), h.pid('hang')]
  if (pids.some((p) => !p || !alive(p))) throw new Error('children not running')
  await h.stopAll()
  await sleep(100)
  if (pids.some(alive)) throw new Error('child still alive')
})

await test('path with a space spawns and answers', async () => {
  const h = new ModHost(fast)
  await h.start(mods.echo2, {})
  eq(await h.panelCall('echo2', 'p', 7), 7, 'answer')
  await h.stopAll()
})

await test('sqlite: node:sqlite opens a db in an fs.write path under --permission', async () => {
  const h = new ModHost(fast)
  await h.start(mods.sqlite, {})
  eq(await h.panelCall('sqlite', 'q', null), [{ v: 'hi' }], 'rows')
  console.log(`      flags: ${nodeArgs(mods.sqlite).join(' ')}`)
  await h.stopAll()
})

await test('fs read outside allowed paths fails inside the child (ERR_ACCESS_DENIED); a declared path works', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'wc-outside-'))
  const file = join(outside, 'f.txt')
  writeFileSync(file, 'secret')
  const h = new ModHost(fast)
  await h.start(mods.echo, {})
  eq(await h.panelCall('echo', 'read', { path: file }), { code: 'ERR_ACCESS_DENIED' }, 'denied')
  await h.stopAll()
  await h.start(withPerms(mods.echo, [`fs.read:${outside}`]), {})
  eq(await h.panelCall('echo', 'read', { path: file }), { ok: 'secret' }, 'declared')
  await h.stopAll()
  rmSync(outside, { recursive: true, force: true })
})

rmSync(dataDir, { recursive: true, force: true })
if (failures) {
  console.log(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nall passed')
