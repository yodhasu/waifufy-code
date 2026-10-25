// Unit check of link/src/affection.ts and the session's tag parser for the affection verdict.
// Run: node tests/unit/affection.test.mjs   (no app, no Claude).
process.env.WC_DATA_DIR ??= (await import('node:os')).tmpdir()

const A = await import('../../link/src/affection.ts')
const { TagParser } = await import('../../link/src/session.ts')

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

/** Feeds `deltas` and returns the text, faces and affection tags it produced. */
function parse(deltas) {
  const out = { text: '', faces: [], felt: [] }
  const p = new TagParser((s) => (out.text += s), (e) => out.faces.push(e), (t) => out.felt.push(t))
  for (const d of deltas) p.feed(d)
  p.flush()
  return out
}

test('each heart costs 3 more points than the last', () => {
  eq([0, 1, 2, 3, 4, 5].map(A.levelStart), [0, 3, 9, 18, 30, 45], 'thresholds')
  eq([0, 2, 3, 8, 9, 44, 45, 99].map(A.levelOf), [0, 0, 1, 1, 2, 4, 5, 5], 'levels')
  eq(A.affectionProgress(10), { level: 2, into: 1, need: 9 }, 'progress into the third heart')
  eq(A.affectionProgress(45), { level: 5, into: 0, need: 0 }, 'full')
  eq([A.clampPoints(-3), A.clampPoints(200), A.clampPoints(NaN)], [0, 45, 0], 'clamped')
})

test('the parser removes [affection+] and [affection-], even cut across deltas, and reports them', () => {
  const r = parse(['[affec', 'tion+] [shy] Ehehe, thank you!'])
  eq(r.text, 'Ehehe, thank you!', 'text')
  eq(r.faces, ['shy'], 'faces')
  eq(r.felt, ['affection+'], 'felt')
  const down = parse(['Okay. [affection-] I will do better.'])
  eq(down.text, 'Okay. I will do better.', 'text mid-line')
  eq(down.felt, ['affection-'], 'felt down')
  eq(parse(['Use `[affection+]` as the tag.']).felt, [], 'not inside code')
})

test('the mood note says the level, a change, and a rest reminder; it is stripped from history text', () => {
  const note = A.moodNote({ level: 2, change: 'up', restAfterMs: 3 * 3600_000 + 12 * 60_000 }, 'Yodha-kun')
  for (const want of ['Affection level: 2 of 5.', 'It just rose', '3 h 12 min', 'rest reminder']) {
    if (!note.includes(want)) throw new Error(`the note lacks "${want}":\n${note}`)
  }
  eq(A.stripContext(`${note}\nfix the build`), 'fix the build', 'stripped')
  eq(A.moodNote({ level: 0 }, 'you').includes('rest'), false, 'no reminder unless due')
})

test('asMood accepts only a sane mood from the wire', () => {
  eq(A.asMood({ level: 9, change: 'sideways', restAfterMs: -1 }), { level: 5 }, 'clamped, junk dropped')
  eq(A.asMood({ level: 1, change: 'down', restAfterMs: 5 }), { level: 1, change: 'down', restAfterMs: 5 }, 'kept')
  eq([A.asMood(undefined), A.asMood({ level: 'x' })], [undefined, undefined], 'not a mood')
})

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
