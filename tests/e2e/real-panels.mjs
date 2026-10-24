// The V0.5 panels against the REAL Agent SDK and bundled Claude Code (no WC_MOCK), with no model turns at all:
// every `say` and `shell` is blocked from the start, and the panels only use session controls and the CLI's local
// commands (/config, /effort current…), which cost nothing. Run by hand:
//
//   node tests/e2e/real-panels.mjs            screenshots in tests/e2e/out/real-panels/
//
// Each panel is opened as typed, its first screen is checked for an error (a red body line, an error toast), and
// it is closed with Esc. Real settings files are only read, never changed.

import { launch, stopVite } from './driver.mjs'
import { focusInput, makeProject, newGame, removeTempDirs, sleep, T } from './lib.mjs'

const LOAD_MS = 30_000
const SETTLE_MS = 1200

/** Slash command → the menu's data-test. */
const PANELS = [
  ['/mcp', 'mcp'],
  ['/status', 'settings'],
  ['/config', 'settings'],
  ['/usage', 'settings'],
  ['/stats', 'settings'],
  ['/model', 'model'],
  ['/effort', 'effort'],
  ['/fast', 'fast'],
  ['/context', 'context'],
  ['/permissions', 'permissions'],
  ['/hooks', 'hooks'],
  ['/memory', 'memory'],
  ['/skills', 'skills'],
  ['/plugin', 'plugin'],
  ['/tasks', 'tasks'],
  ['/diff', 'diff'],
  ['/rewind', 'rewind'],
]

const results = []
const report = (status, what, detail = '') => {
  results.push({ status, what })
  console.log(`${status.padEnd(4)}  ${what}${detail ? `  (${detail})` : ''}`)
}

let app
try {
  app = await launch({ mock: false, tag: 'real-panels' })
  // Nothing here may reach the model.
  await app.eval(() => {
    window.__e2e.block.add('say')
    window.__e2e.block.add('shell')
  })
  const project = makeProject('real-panels')
  await newGame(app, project)
  report('PASS', 'a real session started (no message sent)')

  for (const [cmd, test] of PANELS) {
    const m = await app.mark()
    await focusInput(app)
    await app.type(`${cmd} `)
    await app.key('Enter')
    try {
      await app.waitVisible(T(test), LOAD_MS)
      await app.waitFor((t) => {
        const h = document.querySelector(`[data-test="${t}"] header h2`)?.textContent ?? ''
        // Loaded: a title, and no "Loading…" left in the body (/plugin asks the marketplaces first).
        return h && h !== "Loading…" && !/Loading/.test(document.querySelector(`[data-test="${t}"] .mbody`)?.textContent ?? "")
      }, { args: [test], timeout: LOAD_MS, label: `${cmd} loaded` })
      await sleep(SETTLE_MS)
      const st = await app.eval((t) => {
        const el = document.querySelector(`[data-test="${t}"]`)
        return {
          title: el.querySelector('header h2')?.textContent ?? '',
          rows: el.querySelectorAll('[data-test="menu-row"]').length,
          // An error line in the body; a red ✘ glyph is a server's real status, not a panel error.
          bad: [...el.querySelectorAll('.menu-body .bad, p.empty.bad')].map((x) => x.textContent.trim()).filter(Boolean).join(' | '),
          toast: document.getElementById('toast')?.classList.contains('show') ? document.getElementById('toast').textContent : '',
          text: el.innerText.slice(0, 160).replace(/\s+/g, ' '),
        }
      }, test)
      await app.screenshot(`real-panels/${cmd.slice(1)}`)
      const sentModel = (await app.sent(m, 'say')).length
      const problem = st.bad || (/fail|error|couldn|not available|can't/i.test(st.toast) ? st.toast : '')
      report(problem || sentModel ? 'FAIL' : 'PASS', `${cmd} → "${st.title}"`, problem || `${st.rows} rows · ${st.text}`)
    } catch (e) {
      await app.screenshot(`real-panels/${cmd.slice(1)}-FAIL`).catch(() => {})
      report('FAIL', `${cmd} did not open`, e.message.split('\n')[0])
    }
    // Close every screen of it.
    for (let i = 0; i < 4 && (await app.count(T(test))); i++) await app.key('Escape')
  }
} catch (e) {
  report('FAIL', 'the run stopped', e.message.split('\n')[0])
} finally {
  await app?.close?.()
  stopVite()
  removeTempDirs()
}
const failed = results.filter((r) => r.status === 'FAIL').length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
