// Unit check of link/src/mods/discover.ts discoverMods(): finding mod folders across the env/installed/repo roots.
// Run: node tests/unit/mods-discover.test.mjs   (no app, no Claude).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'wc-mod-data-'))
process.env.WC_DATA_DIR = dataDir
const { discoverMods, modDataDir } = await import('../../link/src/mods/discover.ts')

let failures = 0
function test(name, fn) {
  try {
    fn()
    console.log(`PASS  ${name}`)
  } catch (e) {
    failures++
    console.log(`FAIL  ${name}\n      ${e.message}`)
  }
}
const eq = (a, b, msg) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
}

const tmp = () => mkdtempSync(join(tmpdir(), 'wc-mods-'))
/** Write root/<folder>/mod.json (a string is written as-is, an object as JSON). */
function mod(root, folder, manifest) {
  mkdirSync(join(root, folder), { recursive: true })
  if (manifest !== undefined) writeFileSync(join(root, folder, 'mod.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
}
const good = (id, name = id) => ({ id, name, version: '1.0.0', apiVersion: 1 })

test('env root wins over installed and repo for the same id', () => {
  const env = tmp(), installed = tmp(), repo = tmp()
  mod(env, 'a', good('a', 'from env'))
  mod(installed, 'a', good('a', 'from installed'))
  mod(repo, 'a', good('a', 'from repo'))
  mod(installed, 'b', good('b'))
  mod(repo, 'c', good('c'))
  const found = discoverMods({ env, installed, repo })
  eq(found.map((m) => [m.id, m.source, m.status]), [['a', 'env', 'ok'], ['b', 'installed', 'ok'], ['c', 'repo', 'ok']], 'mods')
  eq(found[0].manifest.name, 'from env', 'winner manifest')
})

test('folder without mod.json is skipped', () => {
  const env = tmp()
  mod(env, 'empty')
  eq(discoverMods({ env, installed: tmp(), repo: tmp() }), [], 'found')
})

test('invalid manifest is listed with status invalid and reason', () => {
  const env = tmp()
  mod(env, 'broken', { id: 'broken', name: 'x', version: '1', apiVersion: 1, skills: 'nope' })
  mod(env, 'junk', '{ not json')
  const [broken, junk] = discoverMods({ env, installed: tmp(), repo: tmp() })
  eq([broken.id, broken.status, typeof broken.reason], ['broken', 'invalid', 'string'], 'broken')
  eq([junk.id, junk.status, typeof junk.reason], ['junk', 'invalid', 'string'], 'junk')
})

test('missing roots are fine (empty list)', () => {
  eq(discoverMods({ env: join(tmp(), 'nope'), installed: join(tmp(), 'nope'), repo: join(tmp(), 'nope') }), [], 'found')
})

test('folder name differing from manifest id -> invalid "folder name must match id"', () => {
  const env = tmp()
  mod(env, 'folder', good('other'))
  const [m] = discoverMods({ env, installed: tmp(), repo: tmp() })
  eq([m.id, m.status, m.reason], ['folder', 'invalid', 'folder name must match id'], 'entry')
})

test('a repo plugin folder may be named differently from its mod id', () => {
  const repo = tmp()
  mod(repo, 'folder', good('other'))
  const [m] = discoverMods({ env: tmp(), installed: tmp(), repo })
  eq([m.id, m.status, m.source], ['other', 'ok', 'repo'], 'entry')
})

test('modDataDir creates and returns a per-mod folder under DATA_DIR', () => {
  eq(modDataDir('x'), join(dataDir, 'mod-data', 'x'), 'path')
})

process.exit(failures ? 1 : 0)
