// Unit check of app/src/character/vmd.ts and motion-vmd.ts: VMD bone keys written and read, and a card's motion
// through a VMD and back (the way it goes to Blender and returns).
// Run: node tests/unit/motion-vmd.test.mjs   (no app, no Claude).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const V = await import('../../app/src/character/vmd.ts')
const M = await import('../../app/src/character/motion-vmd.ts')
const { emotionPose } = await import('../../app/src/character/mmd-engine.ts')

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
const near = (a, b, msg, tol = 0.15) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    const x = a[k] ?? [0, 0, 0], y = b[k] ?? [0, 0, 0]
    if (x.some((v, i) => Math.abs(v - y[i]) > tol)) throw new Error(`${msg}: ${k} ${JSON.stringify(x)} vs ${JSON.stringify(y)}`)
  }
}

await test('bone keys are written and read back, Shift-JIS names included', () => {
  const keys = [
    { name: '右人指１', frame: 0, rotation: [0.1, 0.2, 0.3, Math.sqrt(1 - 0.14)] },
    { name: 'ﾈｸﾀｲ１', frame: 45, rotation: [0, 0, 0, 1] },
  ]
  const back = V.readVmd(V.writeVmd('ポーズ', keys))
  eq(back.map((k) => [k.name, k.frame]), [['右人指１', 0], ['ﾈｸﾀｲ１', 45]], 'names and frames')
  back.forEach((k, i) => k.rotation.forEach((v, j) => Math.abs(v - keys[i].rotation[j]) < 1e-6 || eq(v, keys[i].rotation[j], 'rotation')))
  eq(V.encodeSjis('右人指１右人指１', 15).length, 14, 'a name is cut on a character, not inside one')
})

await test('anything that is not a VMD is refused', () => {
  for (const junk of [new Uint8Array(10), new TextEncoder().encode('Vocaloid Motion Data file'.padEnd(80, ' '))]) {
    let threw = false
    try { V.readVmd(junk) } catch { threw = true }
    eq(threw, true, 'refused')
  }
  const cut = V.writeVmd('x', [{ name: '頭', frame: 0, rotation: [0, 0, 0, 1] }]).subarray(0, 80)
  let threw = false
  try { V.readVmd(cut) } catch (e) { threw = /cut short/.test(e.message) }
  eq(threw, true, 'a cut-off file is refused')
})

await test('a held pose goes through a VMD and comes back the same', () => {
  const m = { pose: { 頭: [12.5, -20, 4], 右腕: [10, 30, 45], 左ひじ: [0, -60, 0], 右人指１: [0, 0, 35.2] }, keys: [] }
  const back = M.motionFromVmd(M.motionToVmd(m, 'Reine'))
  near(back.pose, m.pose, 'pose')
  eq(back.keys, [], 'no keys')
})

await test('keys go through a VMD and come back at their times, over the held pose', () => {
  const m = { pose: { 頭: [10, 0, 0] }, keys: [{ t: 0, pose: { 頭: [-10, 0, 0] } }, { t: 0.4, pose: { 右腕: [0, 0, 60] } }] }
  const back = M.motionFromVmd(M.motionToVmd(m, 'Reine'))
  near(back.pose, m.pose, 'held pose')
  eq(back.keys.map((k) => k.t), [0, 0.4], 'times')
  near(back.keys[0].pose, { 頭: [-10, 0, 0] }, 'first key: only what differs from the held pose')
  near(back.keys[1].pose, { 右腕: [0, 0, 60] }, 'second key')
})

await test('a built-in emotion starts the studio from its own stance', () => {
  eq(Object.keys(emotionPose('normal')), [], 'normal is the relaxed pose')
  const pout = emotionPose('pout')
  if (!(pout['頭']?.[1] > 30)) throw new Error(`pout turns her head away: ${JSON.stringify(pout['頭'])}`)
})

const LAB_VMD = join(ROOT, 'ui-draft', 'mmd-lab', 'assets', 'motions', '執事お辞儀.vmd')
await test('a real MMD motion comes in: its joints only, within a card\'s limits', () => {
  if (!existsSync(LAB_VMD)) return console.log('      (skipped: no lab motion)')
  const m = M.motionFromVmd(readFileSync(LAB_VMD))
  const joints = new Set([m.pose, ...m.keys.map((k) => k.pose)].flatMap((p) => Object.keys(p)))
  eq([...joints].some((j) => j === 'センター' || j.startsWith('ﾈｸﾀｲ')), false, 'no bones the engine doesn\'t drive')
  if (!joints.has('上半身')) throw new Error('the bow bends her upper body')
  if (m.keys.length > 30) throw new Error(`too many keys: ${m.keys.length}`)
})

console.log(failures ? `\n${failures} failed` : '\nAll passed')
process.exit(failures ? 1 : 0)
