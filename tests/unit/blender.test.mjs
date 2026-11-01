// Unit check of link/src/blender.ts with a stand-in for Blender (a script that acts as edit.py would): finding
// Blender, a save there coming back, and an error from it coming back.
// Run: node tests/unit/blender.test.mjs   (no app, no Claude, no Blender).
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.WC_DATA_DIR = mkdtempSync(join(tmpdir(), 'wc-blender-'))
const B = await import('../../link/src/blender.ts')

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
const within = (ms, what, p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`no ${what} within ${ms} ms`)), ms))])

// The stand-in: copies the starting motion to --out (a "save" in Blender), or writes an error to --status.
const dir = mkdtempSync(join(tmpdir(), 'wc-fake-blender-'))
const fake = join(dir, 'fake-blender.mjs')
writeFileSync(fake, `
import { copyFileSync, writeFileSync } from 'node:fs'
const a = process.argv.slice(process.argv.indexOf('--') + 1)
const arg = (k) => a[a.indexOf(k) + 1]
setTimeout(() => {
  if (process.env.FAKE_BLENDER === 'error') writeFileSync(arg('--status'), JSON.stringify({ error: 'MMD Tools is not installed in Blender.' }))
  else copyFileSync(arg('--vmd'), arg('--out'))
}, 300)
setTimeout(() => process.exit(0), 600)
`)
const vmd = Buffer.from('Vocaloid Motion Data 0002\0\0\0\0\0'.padEnd(80, '\0'), 'latin1')

await test('only blender.exe is taken as Blender', async () => {
  eq(B.isBlenderExe(fake), false, 'a script is not Blender')
  eq(await B.findBlender(join(dir, 'blender.exe')), undefined, 'a blender.exe that isn\'t there')
  const exe = join(dir, 'blender.exe')
  writeFileSync(exe, '')
  eq(await B.findBlender(exe), exe, 'picked')
  eq(await B.findBlender(), exe, 'remembered')
})

await test('the script asks MMD Tools for everything and saves the .blend up front', () => {
  for (const s of ['mmd_tools.import_model', 'mmd_tools.import_vmd', 'mmd_tools.export_vmd', 'save_as_mainfile', 'save_post', 'use_keyframe_insert_auto', 'os.replace']) {
    if (!B.EDIT_SCRIPT.includes(s)) throw new Error(`edit.py has no ${s}`)
  }
})

await test('a save in Blender comes back as the motion', async () => {
  const saved = await within(5000, 'save', new Promise((onSaved, fail) => {
    B.openInBlender({ exe: fake, pmx: 'her.pmx', name: 'rem-happy', vmd, onSaved, onError: (e) => fail(new Error(e)) }).catch(fail)
  }))
  eq(saved.equals(vmd), true, 'the same bytes')
})

await test('an error in Blender comes back as one', async () => {
  process.env.FAKE_BLENDER = 'error'
  const error = await within(5000, 'error', new Promise((onError, fail) => {
    B.openInBlender({ exe: fake, pmx: 'her.pmx', name: 'rem-sad', vmd, onSaved: () => fail(new Error('no save expected')), onError }).catch(fail)
  }))
  eq(/MMD Tools/.test(error), true, error)
})

console.log(failures ? `\n${failures} failed` : '\nAll passed')
process.exit(failures ? 1 : 0)
