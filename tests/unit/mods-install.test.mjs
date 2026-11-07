// Unit check of Mods.install / Mods.remove and the settings merge (link/src/mods/index.ts): copying a mod folder into
// the data folder, replacing an older version, removal keeping its data, and partial settings updates.
// Run: node tests/unit/mods-install.test.mjs   (no app, no Claude).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'wc-mods-data-'))
process.env.WC_DATA_DIR = dataDir
const { discoverMods, modDataDir, modsDir } = await import('../../link/src/mods/discover.ts')
const { ModHost } = await import('../../link/src/mods/host.ts')
const { Mods } = await import('../../link/src/mods/index.ts')

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

const tmp = () => mkdtempSync(join(tmpdir(), 'wc-mods-'))
/** A source mod folder (panel only, no backend) with a note file so a replace is visible. */
function source(id, version = '1.0.0', extra = {}) {
  const dir = join(tmp(), id)
  mkdirSync(join(dir, 'ui'), { recursive: true })
  writeFileSync(join(dir, 'ui', 'index.html'), `<h1>${id} ${version}</h1>`)
  writeFileSync(join(dir, 'mod.json'), JSON.stringify({ id, name: id, version, apiVersion: 1, panel: { entry: 'ui/index.html', slot: 'chat.left' }, ...extra }))
  return dir
}

const envRoot = tmp(), repoRoot = tmp()
for (const [root, id] of [[envRoot, 'envmod'], [repoRoot, 'repomod']]) {
  const dir = join(root, id)
  mkdirSync(join(dir, 'ui'), { recursive: true })
  writeFileSync(join(dir, 'ui', 'index.html'), 'x')
  writeFileSync(join(dir, 'mod.json'), JSON.stringify({ id, name: id, version: '1.0.0', apiVersion: 1, panel: { entry: 'ui/index.html', slot: 'chat.left' } }))
}
const flags = {}
const mods = new Mods({
  host: new ModHost({ stopGraceMs: 300, restartDelayMs: 0 }),
  discover: () => discoverMods({ env: envRoot, installed: modsDir(), repo: repoRoot }),
  broadcast: () => {},
  port: () => 4321,
  flags: async () => ({ ...flags }),
  setFlag: async (id, on) => void (flags[id] = on),
  app: () => 'sent',
})
await mods.init()
const info = (id) => mods.list().find((m) => m.id === id)

try {
  await test('install valid folder copies it and lists it', async () => {
    const r = await mods.install(source('fresh'))
    eq(r, { ok: true, id: 'fresh' }, 'result')
    ok(existsSync(join(modsDir(), 'fresh', 'ui', 'index.html')), 'copied')
    eq(info('fresh')?.source, 'installed', 'listed as installed')
  })

  await test('install invalid folder -> ok false with the parser\'s reason', async () => {
    const bad = source('broken')
    writeFileSync(join(bad, 'mod.json'), JSON.stringify({ id: 'Bad Id', name: 'x', version: '1', apiVersion: 1 }))
    const r = await mods.install(bad)
    eq(r.ok, false, 'rejected')
    ok(/id must be/.test(r.reason), r.reason)
    ok(!existsSync(join(modsDir(), 'Bad Id')) && !existsSync(join(modsDir(), 'broken')), 'nothing copied')
    const none = await mods.install(tmp())
    ok(!none.ok && /no mod\.json/.test(none.reason), 'a folder without mod.json says so')
  })

  await test('install existing id -> needsReplace, then replace: true succeeds', async () => {
    const r = await mods.install(source('fresh', '2.0.0'))
    eq(r, { ok: false, reason: 'fresh is already installed', needsReplace: true }, 'asks first')
    eq(info('fresh').version, '1.0.0', 'old version stays')
    eq(await mods.install(source('fresh', '2.0.0'), true), { ok: true, id: 'fresh' }, 'replaced')
    eq(info('fresh').version, '2.0.0', 'new version listed')
    eq(readFileSync(join(modsDir(), 'fresh', 'ui', 'index.html'), 'utf8'), '<h1>fresh 2.0.0</h1>', 'new files')
  })

  await test('remove keeps mod-data unless deleteData', async () => {
    await mods.install(source('keeper'))
    await mods.install(source('goner'))
    for (const id of ['keeper', 'goner']) writeFileSync(join(modDataDir(id), 'note.txt'), 'kept')
    await mods.remove('keeper')
    ok(!existsSync(join(modsDir(), 'keeper')) && !info('keeper'), 'keeper folder and listing gone')
    ok(existsSync(join(modDataDir('keeper'), 'note.txt')), 'keeper data kept')
    await mods.remove('goner', true)
    ok(!existsSync(join(dataDir, 'mod-data', 'goner')), 'goner data deleted')
  })

  await test('repo/env mods cannot be removed', async () => {
    for (const id of ['envmod', 'repomod']) {
      let msg = ''
      await mods.remove(id).catch((e) => (msg = e.message))
      ok(/not an installed mod/.test(msg), `${id}: ${msg}`)
      ok(info(id), `${id} still listed`)
    }
  })

  await test('a partial settings update merges with the stored values; a bad value is rejected with a reason', async () => {
    await mods.install(source('knob', '1.0.0', {
      settings: [
        { key: 'name', type: 'string', label: 'Name', default: 'x' },
        { key: 'limit', type: 'number', label: 'Limit', default: 3 },
        { key: 'token', type: 'secret', label: 'Token' },
      ],
    }))
    await mods.setSettings('knob', { name: 'Rem' })
    await mods.setSettings('knob', { limit: 7 })
    eq(info('knob').values, { name: 'Rem', limit: 7 }, 'one field at a time keeps the others')
    let msg = ''
    await mods.setSettings('knob', { limit: 'lots', name: 'Ram' }).catch((e) => (msg = e.message))
    ok(/"limit" must be a number/.test(msg), msg)
    eq(info('knob').values, { name: 'Rem', limit: 7 }, 'a rejected call changes nothing')
    msg = ''
    await mods.setSettings('knob', { bogus: 1 }).catch((e) => (msg = e.message))
    ok(/no setting "bogus"/.test(msg), msg)
    await mods.setSettings('knob', { token: 's3cret' })
    ok(!readFileSync(join(modDataDir('knob'), 'settings.json'), 'utf8').includes('s3cret'), 'the secret is not in the file')
    eq(info('knob').values, { name: 'Rem', limit: 7 }, 'values never show the secret')
  })
} finally {
  await mods.stopAll()
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
