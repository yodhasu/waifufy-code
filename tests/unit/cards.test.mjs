// Unit check of link/src/cards.ts: the first card, syncing, the love meter, swapping, export and import.
// Run: node tests/unit/cards.test.mjs   (no app, no Claude).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.WC_DATA_DIR = mkdtempSync(join(tmpdir(), 'wc-cards-'))
process.env.WC_NO_MODEL_SEARCH = '1'

const C = await import('../../link/src/cards.ts')
const { defaultSettings } = await import('../../link/src/settings.ts')
const { characterSlug } = await import('../../link/src/casual/modes.ts')

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

const s = defaultSettings()

await test('the first card takes the id her memory lives under, and the latest love meter', async () => {
  eq(characterSlug(s), 'rem', 'slug before cards')
  const id = await C.ensureCard(s, async () => 12)
  eq(id, 'rem', 'id')
  eq(s.card, 'rem', 'settings.card')
  eq(characterSlug(s), 'rem', 'memory slug unchanged')
  eq((await C.readCard('rem')).love.points, 12, 'seeded love')
  eq(await C.ensureCard(s, async () => 40), 'rem', 'second call keeps the card')
  eq((await C.readCard('rem')).love.points, 12, 'love not reseeded')
})

await test('settings edits sync to the active card and keep its love meter', async () => {
  s.waifu.name = 'Rem-chan'
  s.voice.voiceId = 'my-clone'
  s.appearance.model = 'mmd'
  s.appearance.mmdFile = 'C:\\models\\reine.pmx'
  await C.syncCard(s)
  const c = await C.readCard('rem')
  eq([c.waifu.name, c.voice.voiceId, c.look.model, c.love.points], ['Rem-chan', 'my-clone', 'mmd', 12], 'card')
})

await test('the love meter is clamped and per card', async () => {
  await C.setCardLove('rem', 999)
  eq(await C.cardLove('rem'), 45, 'clamped to the top')
  await C.setCardLove('rem', 20)
  eq(await C.cardLove('rem'), 20, 'set')
})

let reine
await test('a new card is the default character with an empty meter; a copy keeps her but not the meter', async () => {
  const fresh = await C.newCard()
  eq([fresh.waifu.name, fresh.love.points, fresh.look.model], ['Rem', 0, 'live2d'], 'fresh')
  const copy = await C.newCard(await C.readCard('rem'))
  eq([copy.waifu.name, copy.voice.voiceId, copy.love.points], ['Rem-chan (copy)', 'my-clone', 0], 'copy')
  if (copy.id === 'rem' || !C.isCardId(copy.id)) throw new Error(`bad id ${copy.id}`)
  reine = copy
})

await test('switching copies only her fields; the user profile and app settings stay', async () => {
  const t = structuredClone(s)
  t.profile.callMe = 'Yodha'
  t.appearance.theme = 'dark'
  t.voice.volume = 33
  const card = await C.readCard(reine.id)
  card.waifu.name = 'Reine'
  C.applyCard(t, card)
  eq([t.card, t.waifu.name, t.profile.callMe, t.appearance.theme, t.voice.volume, t.voice.voiceId], [reine.id, 'Reine', 'Yodha', 'dark', 33, 'my-clone'], 'after')
  eq(characterSlug(t), reine.id, 'her memory is her own card\'s')
})

await test('keepCard restores the active card over stale fields', async () => {
  const stale = structuredClone(s)
  stale.waifu.name = 'Stale'
  C.keepCard(stale, s)
  eq(stale.waifu.name, 'Rem-chan', 'kept')
})

await test('export drops machine paths; import gets a new id and finds the model beside the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-export-'))
  const out = await C.exportCard('rem', join(dir, 'Rem'))
  eq(out, join(dir, 'Rem.waifu.json'), 'extension added')
  const file = JSON.parse(readFileSync(out, 'utf8'))
  eq([file.look.modelsDir, file.look.mmdFile, file.love.points], ['', 'reine.pmx', 20], 'exported')
  if (JSON.stringify(file).includes('facts')) throw new Error('memory leaked into the card')
  writeFileSync(join(dir, 'reine.pmx'), '')
  const back = await C.importCard(out)
  if (back.id === 'rem') throw new Error('import overwrote the original')
  eq([back.waifu.name, back.look.model, back.look.mmdFile, back.love.points], ['Rem-chan', 'mmd', join(dir, 'reine.pmx'), 20], 'imported')
})

await test('import without the model falls back to Live2D; junk is refused; wrong types take defaults', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-import-'))
  const f = join(dir, 'x.waifu.json')
  writeFileSync(f, JSON.stringify({ waifu: { name: 'Mika', formality: 'very', catchphrases: ['hi', 3] }, look: { model: 'mmd', mmdFile: 'gone.pmx' }, love: { points: -5 } }))
  const c = await C.importCard(f)
  eq([c.waifu.name, c.waifu.formality, c.waifu.catchphrases, c.look.model, c.love.points], ['Mika', 60, ['hi'], 'live2d', 0], 'normalized')
  writeFileSync(f, '{"nope": 1}')
  let threw = false
  await C.importCard(f).catch(() => (threw = true))
  eq(threw, true, 'refused')
})

await test('list and delete', async () => {
  const before = await C.listCards()
  const rem = before.find((c) => c.id === 'rem')
  eq([rem.name, rem.hearts, rem.model, rem.voiced], ['Rem-chan', 3, 'mmd', true], 'summary')
  await C.deleteCard(reine.id)
  eq((await C.listCards()).length, before.length - 1, 'deleted')
})

console.log(failures ? `\n${failures} failed` : '\nAll passed')
process.exit(failures ? 1 : 0)
