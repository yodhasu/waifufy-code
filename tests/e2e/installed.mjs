// Checks an installed build (setup.exe) without spending budget: it boots from its own bundled Node, sidecar
// and Claude Code, the login check runs, Rem loads, and a real session completes its handshake. No message is
// ever sent. Your real settings and saves are untouched (a temp WC_DATA_DIR).
//
//   WC_E2E_EXE="<install dir>\waifufy-code.exe" node tests/e2e/installed.mjs

import { launch, stopVite } from './driver.mjs'
import { makeProject, newGame, removeTempDirs, T, waitScreen } from './lib.mjs'

const READY_MS = 60_000
const MODEL_MS = 60_000

const results = []
const check = (cond, what, detail = '') => {
  results.push(cond)
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`)
}

if (!process.env.WC_E2E_EXE) throw new Error('set WC_E2E_EXE to the installed waifufy-code.exe')

let app
try {
  app = await launch({ mock: false, tag: 'installed' })
  await waitScreen(app, 'title', 30_000)
  const url = await app.eval(() => location.href)
  check(!url.startsWith('http://localhost'), 'the page is the bundled frontend, not a dev server', url)
  check(await app.visible(T('title-new')), 'the title screen shows')

  // The boot hello (with the login state) comes before the recorder is installed, so ask again.
  const m0 = await app.mark()
  await app.eval(() => window.__wc.link.send({ t: 'auth_check' }))
  const { auth } = await app.waitEvent('auth', {}, m0, 30_000)
  check(auth.loggedIn === true, 'the bundled Claude Code reports the login', auth.error ?? auth.method ?? '')
  check(!(await app.visible(T('title-login'))), 'no Log in banner while logged in')

  await app.waitFor(() => document.getElementById('chara')?.dataset.model, { timeout: MODEL_MS, label: 'the character' })
  check((await app.chara('data-model')) === 'live2d', 'Rem loads as Live2D from the costume folder', await app.chara('data-costume'))

  const project = makeProject('installed-smoke')
  const start = await newGame(app, project)
  const ready = await app.waitEvent('ready', { epoch: start.epoch }, 0, READY_MS)
  check(ready.commands.length > 0 && ready.models.length > 0, 'a real session completes its handshake', `${ready.commands.length} commands, model ${ready.model}`)
  check((await app.pageErrors()).length === 0, 'no page errors', (await app.pageErrors()).join(' | '))
} catch (e) {
  check(false, 'installed app', e instanceof Error ? e.message : String(e))
  await app?.screenshot('installed-FAIL').catch(() => {})
} finally {
  await app?.close()
  stopVite()
  removeTempDirs()
}
process.exit(results.every(Boolean) ? 0 : 1)
