// Checks the character's motion tables against real costume folders: every emotion hold must resolve on every
// costume, every gesture and reaction must play at least one step, every candidate suffix must exist in at
// least one costume (no typos), and emotions must not collapse into the same look (a blush alone doesn't count).
// Reactions that should read differently (the tiers of one ladder) are compared the same way.
//
//   node app/src/character/check-motions.mjs [modelsDir] [folderPrefix]
//
// modelsDir defaults to the Re:Zero LiM folder in Downloads, and only folders starting with folderPrefix
// (default ac_base_rem, the Rem costumes) are checked. Exits 1 when something fails.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  BODY_TAPS, EMOTES, FACE_TAPS, GESTURES, IDLE_HOLDS, IDLE_SMILE, LOOK_AROUND, PAT_BUSY, PAT_TIERS, WORK_POSES, first,
  indexMotions, resolvePose,
} from './motions.ts'

const DEFAULT_DIR = join(homedir(), 'Downloads', 'ReZero LiM Live2D Characters', 'Live2D Characters')
const dir = process.argv[2] ?? DEFAULT_DIR
const prefix = process.argv[3] ?? 'ac_base_rem'
const folders = readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith(prefix) && existsSync(join(dir, d.name, `${d.name}.model3.json`)))
  .map((d) => d.name)
if (!folders.length) {
  console.error(`no costume folders (<id>/<id>.model3.json) in ${dir}`)
  process.exit(1)
}

/** Every sequence the director can play, by name. Optional ones may be missing on a costume. */
const sequences = [
  ...Object.entries(EMOTES).map(([e, em]) => [`emote ${e} (enter)`, em.enter, true]),
  ...Object.entries(GESTURES).map(([g, steps]) => [`gesture ${g}`, steps, false]),
  ...[...FACE_TAPS, ...BODY_TAPS, ...PAT_TIERS, PAT_BUSY].map((t) => [t.name, t.steps, false]),
  ['idle smile', IDLE_SMILE, true],
]
const holds = [
  ...Object.entries(EMOTES).filter(([, em]) => em.hold).map(([e, em]) => [`emote ${e} (hold)`, em.hold, false]),
  ...WORK_POSES.map((p, k) => [`work pose ${k}`, p, false]),
  ...IDLE_HOLDS.map((v) => [v.name, v.pose, true]),
]

const allPoses = [...sequences.flatMap(([, steps]) => steps), ...holds.map(([, p]) => p)]
const allSuffixes = new Set([...allPoses.flatMap((p) => [...p.act, ...(p.face ?? [])]), ...LOOK_AROUND.flat()])

let failures = 0
const fail = (msg) => (failures++, console.log(`  FAIL ${msg}`))
const seen = new Set()
const key = (r) => (r ? `${r.act.suffix}${r.face ? ` + ${r.face.suffix}` : ''}` : '—')

for (const id of folders) {
  const model = JSON.parse(readFileSync(join(dir, id, `${id}.model3.json`), 'utf8'))
  const index = indexMotions(model.FileReferences?.Motions ?? {})
  for (const s of index.keys()) seen.add(s)
  console.log(`\n${id}: ${index.size} motions`)

  const groups = Object.fromEntries((model.Groups ?? []).map((g) => [g.Name, g.Ids]))
  if (!groups.EyeBlink?.length) console.log('  note: no EyeBlink group; ParamEyeLOpen/ParamEyeROpen are assumed')
  if (!groups.LipSync?.length) console.log('  note: no LipSync group; ParamMouthOpenY is assumed')
  const cheek = index.get('face_cheek_on')
  if (!cheek) console.log('  note: no face_cheek_on; the blush relies on ParamCheek existing')
  else {
    const file = model.FileReferences.Motions[cheek.group][cheek.index].File
    const ids = JSON.parse(readFileSync(join(dir, id, file), 'utf8')).Curves.map((c) => c.Id)
    if (!ids.includes('ParamCheek')) fail(`face_cheek_on does not drive ParamCheek (${ids})`)
  }

  for (const [name, p, optional] of holds) {
    const r = resolvePose(index, p)
    if (!r && !optional) fail(`${name}: none of ${p.act} exists`)
    if (p.face && r && !first(index, p.face)) {
      console.log(`  ${name}: face ${p.face} missing, uses ${r.face?.suffix ?? 'the act’s own face'}`)
    }
  }
  for (const [name, steps, optional] of sequences) {
    const played = steps.map((s) => resolvePose(index, s))
    if (steps.length && !played.some(Boolean) && !optional) fail(`${name}: no step resolves`)
    const missing = steps.filter((_, k) => !played[k]).map((s) => s.act.join('|'))
    if (missing.length && played.some(Boolean)) console.log(`  ${name}: skips ${missing.join(', ')}`)
  }
  const looks = LOOK_AROUND.filter((l) => first(index, l)).length
  if (!looks) console.log('  note: no look-around add-ons; idle uses holds and smiles only')

  // Each emotion should look different from every other in its motions (enter + hold), not only by a blush.
  const looksOf = new Map()
  for (const [e, em] of Object.entries(EMOTES)) {
    const enter = em.enter.map((s) => key(resolvePose(index, s))).filter((k) => k !== '—')
    const hold = em.hold ? key(resolvePose(index, em.hold)) : '(returns)'
    const look = [...enter, hold].join(' → ')
    const same = looksOf.get(look)
    if (same) fail(`emotions ${same} and ${e} differ at most by a blush: ${look}`)
    else looksOf.set(look, e)
  }
  for (const [look, e] of looksOf) console.log(`  ${e.padEnd(10)} ${look}${EMOTES[e].hold?.blush ? ' (blush)' : ''}`)
  // Each step up a reaction ladder should change her look too.
  for (const [ladder, tiers] of [['face taps', FACE_TAPS], ['body taps', BODY_TAPS], ['headpats', PAT_TIERS]]) {
    const seenTier = new Map()
    for (const t of tiers) {
      const look = t.steps.map((s) => key(resolvePose(index, s))).filter((k) => k !== '—').join(' → ')
      const same = seenTier.get(look)
      if (same) fail(`${ladder}: ${same} and ${t.name} differ at most by a blush: ${look}`)
      else seenTier.set(look, t.name)
    }
  }
}

console.log('')
const typos = [...allSuffixes].filter((s) => !seen.has(s))
for (const s of typos) fail(`candidate ${s} exists in no costume (typo?)`)
console.log(failures ? `${failures} failure(s)` : `all motion tables resolve on ${folders.length} costumes`)
process.exit(failures ? 1 : 0)
