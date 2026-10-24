// A visual tour for reviewing the UI by eye: every screen and the main chat states, in light and dark,
// saved as PNGs in tests/e2e/out/tour/. Uses the mock session, so it costs nothing.
//
//   node tests/e2e/tour.mjs            the Tauri debug build (WC_E2E_TARGET=browser for headless Chrome)

import { launch, stopVite } from './driver.mjs'
import { fastText, makeProject, newGame, readAll, removeTempDirs, say, sleep, T, turnEnd, waitScreen } from './lib.mjs'

const SETTLE_MS = 900
const TABS = ['you', 'waifu', 'roleplay', 'appearance', 'motion', 'claude', 'voice', 'about']

let app
const shot = async (name) => {
  await sleep(SETTLE_MS)
  console.log(`  ${await app.screenshot(`tour/${name}`)}`)
}

async function tourTheme(theme) {
  await app.updateSettings({ appearance: { theme } })
  await app.go('title')
  await waitScreen(app, 'title')
  await shot(`${theme}-01-title`)

  const project = makeProject(`tour-${theme}`)
  await newGame(app, project)
  await shot(`${theme}-02-chat-ready`)
  await app.updateSettings({ motion: { textCps: 40 } })
  let m = await say(app, 'show me your emotions')
  await sleep(2500)
  await shot(`${theme}-03-chat-talking`)
  await turnEnd(app, m)
  await fastText(app)
  await readAll(app)

  m = await say(app, 'run the tools')
  await turnEnd(app, m)
  await readAll(app)
  await shot(`${theme}-04-chat-after-tools`)

  m = await say(app, 'ask permission to edit')
  await app.waitVisible(T('ask', { kind: 'permission' }), 30_000)
  await shot(`${theme}-05-permission`)
  await app.click(T('ask-option', { v: 'allow' }))
  await turnEnd(app, m)
  await readAll(app)

  m = await say(app, 'a long answer please')
  await turnEnd(app, m)
  await shot(`${theme}-06-long-collapsed`)
  await readAll(app)

  await app.key('Ctrl+O')
  await app.waitVisible(T('log'))
  await shot(`${theme}-07-log`)
  await app.key('Escape')

  await app.click(T('qm-costume'))
  await app.waitVisible(T('costume-picker'))
  await shot(`${theme}-08-costumes`)
  await app.key('Escape')

  await app.go('saves')
  await waitScreen(app, 'saves')
  await shot(`${theme}-09-saves`)

  await app.go('settings')
  await waitScreen(app, 'settings')
  for (const tab of TABS) {
    const sel = T('settings-tab', { tab })
    if (!(await app.visible(sel))) continue
    await app.click(sel)
    await shot(`${theme}-10-settings-${tab}`)
  }
}

try {
  app = await launch({ wizard: true, tag: 'tour' })
  await waitScreen(app, 'wizard', 30_000)
  await shot('light-00-wizard')
  await app.updateSettings({ onboarded: true, profile: { displayName: 'Yodha', callMe: 'Yodha' } })
  for (const theme of ['light', 'dark']) await tourTheme(theme)
} catch (e) {
  console.error('tour failed:', e)
  await app?.screenshot('tour/FAILED').catch(() => {})
  process.exitCode = 1
} finally {
  await app?.close()
  stopVite()
  removeTempDirs()
}
