// A visual tour for reviewing the UI by eye: every screen and the main chat states, in light and dark,
// saved as PNGs in tests/e2e/out/tour/. Uses the mock session, so it costs nothing.
//
//   node tests/e2e/tour.mjs            the Tauri debug build (WC_E2E_TARGET=browser for headless Chrome)
//   WC_TOUR_PORTRAIT=1 node …          a phone (412×915 portrait, touch) into tests/e2e/out/tour-portrait/;
//                                      WC_E2E_VIEWPORT=1080x1920 picks another size

const PORTRAIT = process.env.WC_TOUR_PORTRAIT === '1'
// Read by the driver as it launches, so the page boots at phone size.
if (PORTRAIT) process.env.WC_E2E_VIEWPORT ||= '412x915@2.625'

const { launch, stopVite } = await import('./driver.mjs')
const { fastText, makeProject, newGame, readAll, removeTempDirs, say, setField, sleep, T, turnEnd, waitScreen } = await import('./lib.mjs')

const SETTLE_MS = 900
const TABS = ['you', 'waifu', 'roleplay', 'appearance', 'motion', 'claude', 'voice', 'slack', 'phone', 'about']
const DIR = PORTRAIT ? 'tour-portrait' : 'tour'

let app
const shot = async (name) => {
  await sleep(SETTLE_MS)
  console.log(`  ${await app.screenshot(`${DIR}/${name}`)}`)
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

  await app.click(T('qm-slack'))
  await app.waitFor(() => document.querySelector('[data-test="slack"] [data-id="c:C0GENERAL"]'), { label: 'the Slack inbox' })
  await shot(`${theme}-08a-slack`)
  await app.click('[data-test="slack"] [data-id="c:C0GENERAL"]')
  await app.waitFor(() => document.querySelector('[data-test="slack"] header h2')?.textContent === '#general', { label: '#general' })
  await shot(`${theme}-08b-slack-conversation`)
  await app.key('Escape')
  await app.key('Escape')
  if (PORTRAIT) {
    await app.click(T('qm-more'))
    await app.waitVisible(T('qm-sheet'))
    await shot(`${theme}-08c-more`)
    await app.click(T('more-quests'))
    await shot(`${theme}-08d-quests`)
    await app.click(T('ptab-status'))
    await shot(`${theme}-08e-status`)
    await app.click(T('ptab-close'))
  }

  // On a phone the costumes are in ⋯.
  if (PORTRAIT) await app.click(T('qm-more')), await app.click(T('more-costume'))
  else await app.click(T('qm-costume'))
  await app.waitVisible(T('costume-picker'))
  await shot(`${theme}-08-costumes`)
  await app.key('Escape')

  await app.go('saves')
  await waitScreen(app, 'saves')
  await shot(`${theme}-09-saves`)

  await app.go('settings')
  await waitScreen(app, 'settings')
  // The screen fades in from transparent; tabs checked before that would count as hidden.
  await app.waitVisible(T('settings-tab', { tab: TABS[0] }))
  for (const tab of TABS) {
    const sel = T('settings-tab', { tab })
    // In portrait the tabs are a scrolling strip.
    await app.eval((s) => {
      const b = document.querySelector(s)
      if (b) b.parentElement.scrollLeft = b.offsetLeft - b.parentElement.clientWidth / 2
    }, sel)
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
  // Signed in to the mock Slack workspace, so the chat shows its inbox (link/src/slack.ts mockApi).
  await app.go('settings')
  await waitScreen(app, 'settings')
  await app.click(T('settings-tab', { tab: 'slack' }))
  await setField(app, 'slack.clientId', '123.456')
  await app.click(T('set-slack.signin'))
  await app.waitFor(() => document.querySelector('[data-test="slack-status"]')?.textContent.includes('Signed in'), { label: 'Slack signed in' })
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
