// Runs the E2E scenarios against the app with the mock session (WC_MOCK=1) and prints a PASS/FAIL
// table by requirement. Exits non-zero when anything fails.
//
//   node tests/e2e/run.mjs                 every scenario file
//   node tests/e2e/run.mjs chat R14        only files whose name contains "chat", or tests tagged R14
//   node tests/e2e/run.mjs --strict        also fails when a requirement is skipped or has no test
//
// See tests/README.md for the environment variables (target, exe, models folder).

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launch, OUT, ROOT, stopVite } from './driver.mjs'
import { makeProject, removeTempDirs, Skip } from './lib.mjs'

const SCENARIOS = join(ROOT, 'tests', 'e2e', 'scenarios')
const TEST_TIMEOUT_MS = 120_000
const SETUP_TIMEOUT_MS = 2 * TEST_TIMEOUT_MS
const NOTE_WIDTH = 110
/** Requirements the E2E suite does not cover: packaging and dev mode are checked by building. */
const OUT_OF_SCOPE = { R47: 'installer build (npm run build:installer)', R49: 'dev mode (npm run dev)' }
// R1–R49 are the V1 requirements (docs/V1.md); R50 on are V0.5's (docs/V0.5.md).
const REQUIREMENTS = Array.from({ length: 59 }, (_, k) => `R${k + 1}`)

const args = process.argv.slice(2)
const strict = args.includes('--strict')
const terms = args.filter((s) => !s.startsWith('--'))
const isReq = (s) => /^R\d+$/i.test(s)
const reqTerms = terms.filter(isReq).map((s) => s.toUpperCase())
const fileTerms = terms.filter((s) => !isReq(s))
const selected = (base, test) =>
  !terms.length || fileTerms.some((t) => base.includes(t)) || [test.r].flat().some((r) => reqTerms.includes(r))

class Timeout extends Error {}

function withTimeout(promise, ms, what) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => (timer = setTimeout(() => reject(new Timeout(`${what} timed out after ${ms / 1000}s`)), ms))),
  ]).finally(() => clearTimeout(timer))
}

const results = []
const record = (file, test, status, ms, error) => results.push({ file, name: test.name, r: [test.r].flat(), status, ms, error })

/** A scenario's launch options; a function, so a file can create what it needs only when it runs. */
const launchOptions = (mod, base) => ({ ...(typeof mod.launch === 'function' ? mod.launch() : mod.launch), tag: base })

/** A fresh app (and the file's setup) for `ctx`; on failure every test in `rest` is recorded as failed. */
async function boot(mod, base, ctx, rest) {
  try {
    ctx.app = await launch(launchOptions(mod, base))
  } catch (e) {
    for (const t of rest) record(base, t, 'FAIL', 0, `launch: ${e.message}`)
    console.log(`  ✗ could not launch: ${e.message}`)
    return false
  }
  try {
    if (mod.setup) await withTimeout(mod.setup(ctx), SETUP_TIMEOUT_MS, 'setup')
    return true
  } catch (e) {
    for (const t of rest) record(base, t, 'FAIL', 0, `setup: ${e.message}`)
    console.log(`  ✗ setup failed: ${e.message}`)
    await ctx.app.screenshot(`${base}-setup-FAIL`).catch(() => {})
    await ctx.app.close()
    return false
  }
}

async function runFile(f) {
  const base = f.replace(/\.mjs$/, '')
  const mod = (await import(pathToFileURL(join(SCENARIOS, f)).href)).default
  const tests = mod.tests.filter((t) => selected(base, t))
  if (!tests.length) return
  console.log(`\n▶ ${base}: ${mod.name} (${tests.length} tests)`)

  const ctx = { project: makeProject(), file: base, log: (s) => console.log(`    ${s}`) }
  if (!(await boot(mod, base, ctx, tests))) return
  let timedOut = false
  for (const [k, t] of tests.entries()) {
    // A test that timed out is still running and would keep driving this app under the next one, so the next
    // test gets a fresh app. So does every test after one that made the app exit.
    if (timedOut || !ctx.app.alive()) {
      console.log(`  ↻ relaunching: ${timedOut ? 'the timed-out test may still be driving the app' : 'the app exited'}`)
      await ctx.app.close()
      if (!(await boot(mod, base, ctx, tests.slice(k)))) return
    }
    timedOut = false
    const { app } = ctx
    const started = Date.now()
    const loads = app.navigations()
    const errors = app.pageErrors().length
    const label = `[${[t.r].flat().join(' ')}] ${t.name}`
    try {
      await withTimeout(t.run(ctx), t.timeout ?? TEST_TIMEOUT_MS, label)
      record(base, t, 'PASS', Date.now() - started)
      console.log(`  ✓ ${label}`)
    } catch (e) {
      if (e instanceof Skip) {
        record(base, t, 'SKIP', Date.now() - started, e.message)
        console.log(`  - ${label}: SKIP ${e.message}`)
        continue
      }
      const notes = [
        app.navigations() > loads ? 'the page reloaded during the test (a source file changed?)' : '',
        ...app.pageErrors().slice(errors).map((x) => `page error: ${x}`),
      ].filter(Boolean)
      const message = [e.message, ...notes].join('\n      ')
      record(base, t, 'FAIL', Date.now() - started, message)
      console.log(`  ✗ ${label}\n      ${message}`)
      await app.screenshot(`${base}-${[t.r].flat()[0]}-FAIL`).catch(() => {})
      timedOut = e instanceof Timeout
    }
  }
  await ctx.app.close()
}

try {
  for (const f of readdirSync(SCENARIOS).filter((f) => f.endsWith('.mjs')).sort()) await runFile(f)
} finally {
  stopVite()
  removeTempDirs()
}

// ---------------------------------------------------------------- report

const byReq = new Map(REQUIREMENTS.map((r) => [r, []]))
for (const res of results) for (const r of res.r) byReq.get(r)?.push(res)
const rows = REQUIREMENTS.map((r) => {
  const list = byReq.get(r)
  const status = OUT_OF_SCOPE[r] && !list.length
    ? 'n/a'
    : !list.length
      ? '—'
      : list.some((x) => x.status === 'FAIL')
        ? 'FAIL'
        : list.some((x) => x.status === 'PASS')
          ? 'PASS'
          : 'SKIP'
  const note = OUT_OF_SCOPE[r] && !list.length ? OUT_OF_SCOPE[r] : list.map((x) => `${x.status === 'PASS' ? '' : x.status + ' '}${x.name}`).join('; ')
  return { r, status, note }
}).filter((row) => !terms.length || byReq.get(row.r).length)

console.log('\nRequirement  Status  Tests')
console.log('-----------  ------  -----')
for (const row of rows) {
  const note = row.note.length > NOTE_WIDTH ? row.note.slice(0, NOTE_WIDTH - 3) + '…' : row.note
  console.log(`${row.r.padEnd(11)}  ${row.status.padEnd(6)}  ${note}`)
}

const failed = results.filter((x) => x.status === 'FAIL')
if (failed.length) {
  console.log('\nFailures:')
  for (const x of failed) console.log(`  ${x.file} › ${x.name}\n    ${x.error}`)
}
// The finish condition is every requirement verified: a skip or a missing test is not a pass.
const unverified = rows.filter((row) => row.status === 'SKIP' || row.status === '—')
if (unverified.length) {
  console.log(`\nUnverified${strict ? '' : ' (run with --strict to fail on these)'}:`)
  for (const row of unverified) console.log(`  ${row.r}  ${row.status === '—' ? 'no test' : row.note}`)
}
const count = (s) => results.filter((x) => x.status === s).length
console.log(`\n${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped · screenshots and logs in tests/e2e/out`)
mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ at: new Date().toISOString(), results, requirements: rows, unverified }, null, 2))
process.exit(failed.length || (strict && unverified.length) ? 1 : 0)
