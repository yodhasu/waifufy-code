// Unit check of the voice pieces in the link: <ja> lines in the tag parser, the persona's voice section (only
// with a key), the settings migration, and the mock clip. Run: node tests/unit/voice.test.mjs (no app, no Claude).
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'wc-voice-'))
process.env.WC_DATA_DIR = dir
delete process.env.FISH_API_KEY

const { TagParser } = await import('../../link/src/session.ts')
const { buildPersona } = await import('../../link/src/persona.ts')
const { defaultSettings, loadSettings } = await import('../../link/src/settings.ts')
const tts = await import('../../link/src/tts.ts')

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

function parse(deltas) {
  const out = { text: '', faces: [], voice: [] }
  const p = new TagParser((s) => (out.text += s), (e) => out.faces.push(e), () => {}, (v) => out.voice.push(v))
  for (const d of deltas) p.feed(d)
  p.flush()
  return out
}

await test('a <ja> line leaves the text and comes out as a voice line, even cut across deltas', () => {
  const r = parse(['Found it! [smile] All good. <j', 'a>見つけました！[softly] 大丈夫です', 'よ。</ja>\n\nNext.'])
  eq(r.text, 'Found it! All good.\n\nNext.', 'text')
  eq(r.voice, ['見つけました！[softly] 大丈夫ですよ。'], 'voice keeps its delivery cue')
  eq(r.faces, ['smile'], 'faces')
})

await test('a <ja> in code, or a lone "<", stays text', () => {
  eq(parse(['Use `<ja>x</ja>` there.']).voice, [], 'inline code')
  eq(parse(['if a <', ' b then']).text, 'if a < b then', 'a lone <')
})

await test('the persona asks for <ja> lines only while her voice can play', async () => {
  const s = defaultSettings()
  if (buildPersona(s).includes('<ja>')) throw new Error('no key: no voice section')
  await tts.setVoiceKey('test-key')
  const withKey = buildPersona(s)
  for (const want of ['## Voice lines (Japanese)', '<ja>', '「レム」', 'くん']) {
    if (!withKey.includes(want)) throw new Error(`the voice section lacks ${want}`)
  }
  s.voice.language = 'en'
  if (buildPersona(s).includes('<ja>')) throw new Error('an English voice reads the text: no <ja> lines')
  s.voice.language = 'ja'
  s.voice.enabled = false
  if (buildPersona(s).includes('<ja>')) throw new Error('turned off: no voice section')
  await tts.setVoiceKey('')
  eq(tts.hasVoiceKey(), false, 'the key is removed')
})

await test('settings from before 0.5.1 gain the voice defaults; the old placeholder key is dropped', async () => {
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: 1, onboarded: true, voice: { provider: 'off' } }))
  const s = await loadSettings()
  eq('provider' in s.voice, false, 'provider dropped')
  eq([s.voice.enabled, s.voice.voiceId, s.voice.model, s.voice.language], [true, 'd19e2bd4c7464bd98fa2e67044de9a8b', 's2.1-pro-free', 'ja'], 'defaults')
})

await test('the key is kept out of the child CLI environment', async () => {
  process.env.FISH_API_KEY = 'secret'
  const { childEnv } = await import('../../link/src/shell.ts')
  eq('FISH_API_KEY' in childEnv(), false, 'not passed on')
  eq(tts.voiceKey(), 'secret', 'the env var is a key')
  delete process.env.FISH_API_KEY
})

await test('a mock clip is a WAV whose length follows the line', () => {
  const short = tts.mockClip('はい。')
  const long = tts.mockClip('はい、レムにお任せください。今日も頑張りましょう。')
  eq(short.mime, 'audio/wav', 'mime')
  eq(short.audio.toString('ascii', 0, 4), 'RIFF', 'header')
  if (!(long.audio.length > short.audio.length * 2)) throw new Error('a longer line is a longer clip')
})

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
