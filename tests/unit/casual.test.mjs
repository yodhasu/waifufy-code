// Unit check of casual mode's pure parts (link/src/casual): the hidden <feel> line, her heart, memory lookup,
// the shared context after a compaction, the casual block in the work transcript, and the OpenAI stream parser.
// Run: node tests/unit/casual.test.mjs   (no app, no model).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.WC_DATA_DIR = mkdtempSync(join(tmpdir(), 'wc-casual-'))
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'wc-casual-cc-'))

const { FeelParser, parseFeel, stripForPool } = await import('../../link/src/casual/engine.ts')
const H = await import('../../link/src/casual/heart.ts')
const { openMemory, rank, words, overlap } = await import('../../link/src/casual/memory.ts')
const P = await import('../../link/src/casual/prompt.ts')
const { casualBlock, parseCasual } = await import('../../link/src/casual/block.ts')
const { sse, claudeBlocks } = await import('../../link/src/casual/providers.ts')
const { defaultSettings } = await import('../../link/src/settings.ts')
const { loadContext, loadHistory } = await import('../../link/src/saves.ts')
const { searchEntries, searchHistory } = await import('../../link/src/history-search.ts')

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
const ok = (v, msg) => {
  if (!v) throw new Error(msg)
}

function feelOf(deltas) {
  let text = ''
  const p = new FeelParser((s) => (text += s))
  for (const d of deltas) p.feed(d)
  p.flush()
  return { text, a: p.appraisal }
}

await test('feel line is read and removed, even split across deltas', () => {
  const r = feelOf(['<fe', 'el j=0.4 s=-0.1 a=0 u=0.2 f=0 c=0.8 w=1', '/>\n[smile] Hi', ' there'])
  eq(r.text, '[smile] Hi there', 'text')
  eq(r.a.feel, [0.4, -0.1, 0, 0.2, 0], 'feel')
  eq(r.a.confidence, 0.8, 'confidence')
  eq(r.a.work, true, 'work')
})

await test('a reply without a feel line passes through untouched', () => {
  const r = feelOf(['Hello', ' you'])
  eq(r.text, 'Hello you', 'text')
  eq(r.a, undefined, 'no appraisal')
})

await test('a stray feel tag later in the reply is never shown', () => {
  eq(feelOf(['<feel j=0 c=1/>\nOne. <feel j=1/> Two.']).text, 'One. Two.', 'text')
})

await test('feel values are clamped', () => {
  eq(parseFeel('j=3 s=-7 c=2').feel.slice(0, 2), [1, -1], 'clamped')
})

await test('the backlog line drops tags and voice lines', () => {
  eq(stripForPool('[smile] Welcome back! <ja>おかえり</ja> [affection+]'), 'Welcome back!', 'stripped')
})

await test('heart: kindness raises joy, and it settles back over time', () => {
  const t = H.traitsFor('devoted')
  const start = { feelings: [...t.baseline], at: 0, lastSeen: 0 }
  const after = H.feel(start, t, [0.8, 0, 0, 0, 0], 1, 3, 0)
  ok(after.feelings[0] > start.feelings[0] + 0.3, `joy rose: ${after.feelings[0]}`)
  const later = H.settle(after, t, 3, 6 * 3_600_000)
  ok(Math.abs(later.feelings[0] - (t.baseline[0] + 0.15 * 0.6)) < 0.05, `back near baseline: ${later.feelings[0]}`)
})

await test('heart: unkindness hurts more at low affection', () => {
  const t = H.traitsFor('devoted')
  const start = { feelings: [...t.baseline], at: 0, lastSeen: 0 }
  const low = H.feel(start, t, [0, 0.6, 0.6, 0, 0], 1, 0, 0)
  const high = H.feel(start, t, [0, 0.6, 0.6, 0, 0], 1, 5, 0)
  ok(low.feelings[2] > high.feelings[2], `anger low ${low.feelings[2]} > high ${high.feelings[2]}`)
})

await test('heart: moods follow the feelings', () => {
  eq(H.moodOf([0.2, 0.05, 0.6, 0, 0]), 'irritated', 'angry')
  eq(H.moodOf([0.7, 0, 0, 0.5, 0]), 'excited', 'excited')
  eq(H.moodOf([0.2, 0.6, 0, 0, 0]), 'down', 'down')
  eq(H.moodOf([0.1, 0.05, 0.02, 0, 0]), 'calm', 'calm')
})

await test('heart: a tsundere hides it, and work mode says nothing when she is fine', () => {
  const t = H.traitsFor('tsundere')
  const sulky = { feelings: [0.2, 0.1, 0.4, 0, 0], at: 0, lastSeen: 0 }
  ok(/hide it/.test(H.moodGuide(sulky, t)), 'masked')
  eq(H.restingFace(sulky, t), 'pout', 'face')
  eq(H.moodGuide({ feelings: [0.3, 0, 0, 0, 0], at: 0, lastSeen: 0 }, t, true), '', 'quiet at work')
})

await test('heart: coming back after days makes a clingy heart a little sad', () => {
  const t = H.traitsFor('yandere-lite')
  const h = { feelings: [...t.baseline], at: 0, lastSeen: 0.001 }
  const back = H.reunion(h, t, 2, 3 * 24 * 3_600_000)
  ok(back.feelings[1] > t.baseline[1] + 0.2, `sadness ${back.feelings[1]}`)
})

await test('memory: lookup finds the matching fact, skips duplicates', async () => {
  const m = openMemory('test-rem')
  eq(await m.addFacts(['Their sister Mia visits in December.', 'They love ramen from the shop near the station.']), 2, 'added')
  eq(await m.addFacts(['Their sister Mia visits in December!']), 0, 'duplicate')
  const hits = m.recall('is mia coming over soon?')
  ok(hits[0]?.includes('Mia'), `hit: ${hits}`)
  eq(m.recall('quantum chromodynamics'), [], 'nothing unrelated')
})

await test('memory: one character has one memory, so two openers never save over each other', async () => {
  const session = openMemory('test-shared')
  const startup = openMemory('test-shared')
  ok(session === startup, 'same memory')
  await startup.addFacts(['Their sister Mia visits in December.'])
  await session.addFacts(['They love ramen.'])
  const disk = JSON.parse(readFileSync(join(session.dir, 'facts.json'), 'utf8')).list.map((f) => f.text)
  eq(disk.length, 2, `both kept: ${disk}`)
})

await test('memory: words and overlap', () => {
  eq(words('The ramen shops!'), ['ramen', 'shop'], 'words')
  ok(words('ラーメン').length === 3, 'CJK bigrams')
  ok(overlap('likes ramen a lot', 'really likes ramen') >= 0.7, 'overlap')
  eq(rank(['cats are nice', 'dogs bark'], ['dogs']), [1], 'rank')
})

await test('memory: tune revisions are kept with history', async () => {
  const m = openMemory('test-rem')
  await m.setTune({ style: 'Short lines.', examples: ['{you}: hi\n{name}: Hi!'] }, 'test')
  eq(m.tune().rev, 1, 'rev')
  eq(openMemory('test-rem').tune().style, 'Short lines.', 'persisted')
})

await test('history: work lines tagged, sides alternate, work hidden when not shared', () => {
  const pool = [
    { mode: 'work', who: 'user', text: 'fix the build', at: 0 },
    { mode: 'work', who: 'tool', text: 'Bash npm test', at: 0 },
    { mode: 'work', who: 'char', text: 'Fixed!', at: 0 },
    { mode: 'casual', who: 'user', text: 'thanks!', at: 0 },
    { mode: 'casual', who: 'char', text: 'Anytime.', at: 0 },
  ]
  const m = P.historyMessages(pool, true)
  eq(m.map((x) => x.role), ['user', 'assistant', 'user', 'assistant'], 'roles')
  eq(m[1].content, '[work] (did: Bash npm test)\n[work] Fixed!', 'work folded')
  eq(P.historyMessages(pool, false).map((x) => x.content), ['thanks!', 'Anytime.'], 'not shared')
})

await test('casual reads the context as work has it: the summary and what came after, not the compacted lines', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'wc-casual-cwd-'))
  const id = '11111111-2222-3333-4444-555555555555'
  const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const base = { sessionId: id, cwd, version: '2.1.0', userType: 'external', isSidechain: false }
  // The shape the CLI writes: the boundary links back with logicalParentUuid, the summary is a user line.
  const lines = [
    { ...base, type: 'user', uuid: 'a1', parentUuid: null, message: { role: 'user', content: 'old work request' } },
    { ...base, type: 'assistant', uuid: 'a2', parentUuid: 'a1', message: { role: 'assistant', model: 'x', content: [{ type: 'text', text: 'old reply' }] } },
    { ...base, type: 'system', subtype: 'compact_boundary', uuid: 'b1', parentUuid: null, logicalParentUuid: 'a2', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 100 } },
    { ...base, type: 'user', uuid: 's1', parentUuid: 'b1', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'Summary: they fixed the login bug together.' } },
    { ...base, type: 'user', uuid: 'c1', parentUuid: 's1', message: { role: 'user', content: casualBlock('hey', 'hi!') } },
  ]
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const context = await loadContext(id, cwd)
  eq(context.map((e) => e.text), ['Summary: they fixed the login bug together.', 'hey', 'hi!'], 'context')
  ok(context.every((e) => e.mode === 'casual'), 'summary never hidden or tagged [work]')
  ok((await loadHistory(id, cwd)).some((e) => e.text === 'old reply'), 'the backlog still shows the compacted lines')
  // search_history reaches what the compaction took out of context.
  const found = await searchHistory(id, cwd, 'what was the old work request?', { you: 'Master', name: 'Rem' })
  ok(found.includes('Master: old work request') && found.includes('Rem: old reply'), found)
  eq(await searchHistory(undefined, cwd, 'anything', { you: 'Master', name: 'Rem' }), 'Nothing said yet in this session.', 'no session yet')
})

await test('search_history: best stretches, oldest first, never overlapping, nothing for no match', () => {
  const n = { you: 'Master', name: 'Rem' }
  const entries = [
    ...Array.from({ length: 30 }, (_, i) => ({ who: i % 2 ? 'char' : 'user', text: `filler line number ${i}` })),
    { who: 'user', text: 'the deploy to staging failed again', mode: 'casual' },
    { who: 'tool', name: 'Bash', detail: 'npm run deploy:staging' },
    { who: 'char', text: 'staging deploy is green now' },
    ...Array.from({ length: 10 }, (_, i) => ({ who: 'user', text: `more filler ${i}` })),
  ]
  const out = searchEntries(entries, 'staging deploy', n)
  ok(out.includes('Master (casual): the deploy to staging failed again') && out.includes('[tool] Bash npm run deploy:staging'), out)
  const starts = [...out.matchAll(/--- lines (\d+)/g)].map((m) => Number(m[1]))
  ok(starts.every((s, i) => i === 0 || s - starts[i - 1] >= 4), `overlap: ${starts}`)
  eq(searchEntries(entries, 'quantum chromodynamics', n), 'Nothing found.', 'no match')
})

await test('the casual system prompt is stable and has her rules', () => {
  const s = defaultSettings()
  const tune = { rev: 0, at: 0, style: 'Short.', examples: ['{you}: hi\n{name}: Hi, {you}!'] }
  const a = P.casualSystem(s, tune, { works: [], avoid: [] }, true)
  eq(a, P.casualSystem(s, tune, { works: [], avoid: [] }, true), 'stable')
  ok(a.includes('<feel joy=0'), 'appraisal line')
  ok(a.includes('use_tools'), 'tools')
  ok(a.includes('Hi, Master!'), 'examples filled')
  ok(!a.includes('Claude Code'), 'no Claude Code')
})

await test('casual block round-trips through the transcript', () => {
  const b = casualBlock('hi </you> there', '[smile] Hello!')
  eq(parseCasual(`prefix ${b} ${casualBlock('a', 'b')}`), [{ you: 'hi </you> there', her: '[smile] Hello!' }, { you: 'a', her: 'b' }], 'parsed')
  eq(parseCasual('nothing here'), [], 'none')
})

await test('OpenAI stream: text and tool-call pieces are parsed', async () => {
  const body = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"recall","arguments":"{\\"q"}}]}}]}\n',
    'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":8}}}\n',
    'data: [DONE]\n',
  ]
  const stream = new ReadableStream({ start(c) { for (const b of body) c.enqueue(new TextEncoder().encode(b)); c.close() } })
  const out = []
  for await (const ch of sse(stream)) out.push(ch)
  eq(out.length, 4, 'chunks')
  eq(out[3].usage.prompt_tokens_details.cached_tokens, 8, 'usage')
})

await test('Claude blocks keep older lines in stable chunks', () => {
  const msgs = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }))
  const a = claudeBlocks(msgs.slice(0, 19), 'Master', 'Rem')
  const b = claudeBlocks(msgs.slice(0, 19).concat([{ role: 'assistant', content: 'x' }, { role: 'user', content: 'y' }]), 'Master', 'Rem')
  eq(a[1].text, b[1].text, 'first chunk unchanged')
  eq(b.at(-1).text.trim(), 'y', 'newest last')
})

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
