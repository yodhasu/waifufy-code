// Unit check of link/src/mods/manifest.ts parseManifest(): validation of a mod's mod.json.
// Run: node tests/unit/mods-manifest.test.mjs   (no app, no Claude).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { parseManifest } = await import('../../link/src/mods/manifest.ts')

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

const base = { id: 'hello-mod', name: 'Hello', version: '1.0.0', apiVersion: 1 }
/** A mod folder holding the given relative files. */
function modDir(...files) {
  const dir = mkdtempSync(join(tmpdir(), 'wc-mod-'))
  for (const f of files) {
    mkdirSync(join(dir, f, '..'), { recursive: true })
    writeFileSync(join(dir, f), '')
  }
  return dir
}

test('valid manifest parses with defaults', () => {
  const r = parseManifest(base, modDir())
  eq(r.ok, true, 'ok')
  eq([r.manifest.tools, r.manifest.skills, r.manifest.settings, r.manifest.permissions], [[], [], [], []], 'defaults')
  eq(r.manifest.defaultEnabled, false, 'defaultEnabled')
})
test('unknown fields are ignored', () => {
  const r = parseManifest({ ...base, bogus: 1 }, modDir())
  eq(r.ok, true, 'ok')
  eq('bogus' in r.manifest, false, 'bogus kept')
})
test('id "Bad_Id" is invalid', () => {
  const r = parseManifest({ ...base, id: 'Bad_Id' }, modDir())
  eq([r.ok, r.status], [false, 'invalid'], 'result')
})
test('apiVersion 2 is incompatible', () => {
  const r = parseManifest({ ...base, apiVersion: 2 }, modDir())
  eq([r.ok, r.status], [false, 'incompatible'], 'result')
})
test('panel.entry "../x.html" is invalid: path escapes the mod folder', () => {
  const r = parseManifest({ ...base, panel: { entry: '../x.html', slot: 'chat.left' } }, modDir())
  eq([r.ok, r.status, r.reason], [false, 'invalid', 'path escapes the mod folder'], 'result')
})
test('panel with an existing entry parses; a missing one is invalid', () => {
  const panel = { entry: 'p.html', slot: 'chat.right' }
  eq(parseManifest({ ...base, panel }, modDir('p.html')).ok, true, 'present')
  eq(parseManifest({ ...base, panel }, modDir()).ok, false, 'missing')
})
test('skills ["a"] without skills/a/SKILL.md is invalid', () => {
  eq(parseManifest({ ...base, skills: ['a'] }, modDir()).ok, false, 'missing')
  eq(parseManifest({ ...base, skills: ['a'] }, modDir('skills/a/SKILL.md')).ok, true, 'present')
})
test('duplicate tool names in one mod are invalid', () => {
  const tool = { name: 't', description: 'd', input: {} }
  const r = parseManifest({ ...base, tools: [tool, tool] }, modDir())
  eq([r.ok, r.status], [false, 'invalid'], 'result')
})
test('tool names outside [A-Za-z0-9_-]{1,40} are invalid', () => {
  for (const name of ['a b', 'a.b', 'x'.repeat(41)]) {
    const r = parseManifest({ ...base, tools: [{ name, description: 'd', input: {} }] }, modDir())
    eq([r.ok, r.status], [false, 'invalid'], `name ${JSON.stringify(name)}`)
  }
})
test('select without options is invalid', () => {
  const r = parseManifest({ ...base, settings: [{ key: 'k', type: 'select', label: 'K' }] }, modDir())
  eq([r.ok, r.status], [false, 'invalid'], 'result')
})
test('non-object manifest is invalid', () => {
  eq(parseManifest(null, modDir()).ok, false, 'null')
})

process.exit(failures ? 1 : 0)
