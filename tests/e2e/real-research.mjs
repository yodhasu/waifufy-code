// One REAL roleplay research run (R40): Haiku with web search and fetch, as the Settings → Roleplay page
// starts it. It spends a little plan budget, so it is run by hand only:
//
//   node tests/e2e/real-research.mjs ["Name"] ["Series"] ["notes"]
//
// The settings UI around it (progress, cancel, result card, Apply, library) is covered by the E2E suite with
// the mock research; this checks the part only a real run can: the model, the tools and the structured output.

process.env.WC_DATA_DIR ??= (await import('node:os')).tmpdir()
const { research } = await import('../../link/src/research.ts')

const [name = 'Rem', series = 'Re:Zero − Starting Life in Another World', notes = ''] = process.argv.slice(2)
const MIN_SAMPLE_LINES = 3

const results = []
const check = (cond, what, detail = '') => {
  results.push(cond)
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`)
}

const started = Date.now()
const progress = []
try {
  const preset = await research({
    name,
    series,
    notes,
    signal: new AbortController().signal,
    onProgress: (text) => (progress.push(text), console.log(`  · ${text}`)),
    claudePath: process.env.WC_CLAUDE || undefined,
  })
  const secs = ((Date.now() - started) / 1000).toFixed(0)
  console.log(`\n${JSON.stringify(preset, null, 2)}\n`)
  check(true, `research finished in ${secs}s`)
  check(progress.some((p) => p.startsWith('Searching') || p.startsWith('Reading')), 'progress shows the web research', `${progress.length} lines`)
  check(preset.prompt.length > 200, 'a tailored roleplay prompt', `${preset.prompt.length} chars`)
  check(preset.profile.summary.length > 0 && preset.profile.personality.length > 0, 'a structured profile')
  check(preset.profile.sampleLines.length >= MIN_SAMPLE_LINES, 'sample lines', `${preset.profile.sampleLines.length}`)
  check(preset.sources.length > 0, 'sources are listed', preset.sources.slice(0, 3).join(' '))
} catch (e) {
  check(false, 'research run', e instanceof Error ? e.message : String(e))
}
process.exit(results.every(Boolean) ? 0 : 1)
