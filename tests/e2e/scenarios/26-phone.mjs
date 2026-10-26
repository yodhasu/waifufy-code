// Phone access (docs/V0.5.md R77–R78): the desktop turns it on and shows a pairing code; a phone (a second, phone-sized
// headless Chrome loading the app with ?pair=…, driver.mjs openPhone) joins the session running on the desktop,
// chats in it, answers a prompt the desktop sees close, and is dropped by a new pairing code.
import { openPhone } from '../driver.mjs'
import { assert, eq, fastText, newGame, say, setField, T, turnEnd } from '../lib.mjs'

/** Turns phone access on in the desktop's Settings → Phone and returns the pairing link, aimed at this machine. */
async function enablePhone(app) {
  await app.go('settings')
  await app.waitVisible('[data-tab="phone"]')
  await app.click('[data-tab="phone"]')
  await app.waitVisible(T('phone-status'))
  await setField(app, 'phone.enabled', true)
  await app.waitFor(() => !!document.querySelector('[data-test="phone-qr"] svg') && !document.querySelector('[data-phone-pair]').hidden, { label: 'the pairing QR code' })
  const url = await app.eval(() => document.querySelector('[data-test="phone-qr"]').dataset.url)
  assert(url.startsWith('waifufy-code://pair?'), `pair url: ${url}`)
  // The test's phone runs on this machine, so it tries loopback first.
  const u = new URL(url.replace('waifufy-code://', 'http://x/'))
  u.searchParams.set('h', '127.0.0.1')
  return `waifufy-code://pair?${u.searchParams}`
}

const chatText = (app) => app.eval(() => document.querySelector('.dialogue')?.textContent ?? '')

export default {
  name: 'Phone access: pair a phone, join the desktop session, answer from either side',
  tests: [
    {
      r: 'R77',
      name: 'Settings → Phone shows a pairing code; a phone pairs with it, in portrait, with Join instead of Exit',
      async run({ app }) {
        const pair = await enablePhone(app)
        assert((await app.text(T('phone-status'))).includes('waiting for your phone'), 'waiting')
        const phone = await openPhone(pair)
        try {
          eq(await phone.eval(() => document.getElementById('stage').dataset.orient), 'portrait', 'portrait stage')
          await phone.waitVisible(T('title-join'))
          assert(await phone.eval(() => document.querySelector('[data-test="title-exit"]').hidden), 'no Exit on a phone')
          await app.waitFor(() => /1 phone connected/.test(document.querySelector('[data-test="phone-status"]')?.textContent ?? ''), { label: 'the desktop sees the phone' })
        } finally {
          await phone.close()
        }
      },
    },
    {
      r: 'R78',
      name: 'the phone joins the running session, chats in it, and its answer closes the prompt on the desktop',
      async run({ app, project }) {
        const pair = await enablePhone(app)
        await newGame(app, project)
        await fastText(app)
        await say(app, 'hello from the desk')
        await turnEnd(app)
        const phone = await openPhone(pair)
        try {
          await fastText(phone)
          await phone.click(T('title-join'))
          // A phone's first chat opens on the touch tutorial.
          await phone.waitVisible(T('tutorial'))
          await phone.click(T('tutorial-skip'))
          await phone.waitHidden(T('tutorial'))
          await phone.waitVisible(T('chat-input'))
          await phone.waitFor(() => !document.querySelector('[data-test="chat-input"]')?.disabled, { label: 'phone input enabled' })
          // Joining doesn't end the desktop's session.
          assert(!(await app.eval(() => window.__e2e.events.some((e) => e.t === 'ended'))), 'the desktop session still runs')
          // A message from the phone runs in the desktop's session, and the desktop shows the prompt it brings.
          await say(phone, 'permission please')
          await phone.waitVisible(T('ask'), 15_000)
          await app.waitVisible(T('ask'), 15_000)
          await phone.click(`${T('ask')} ${T('ask-option')}`)
          await app.waitHidden(T('ask'), 10_000)
          await turnEnd(app)
          assert((await chatText(phone)).length > 0, 'the phone shows her reply')
        } finally {
          await phone.close()
        }
      },
    },
    {
      r: 'R78',
      name: 'on the phone: the tutorial walks through once; swipes open the log and hide the text; ⋯ opens the panel tabs',
      async run({ app, project }) {
        const pair = await enablePhone(app)
        await newGame(app, project)
        await fastText(app)
        await say(app, 'hello from the desk')
        await turnEnd(app)
        const phone = await openPhone(pair)
        try {
          await fastText(phone)
          await phone.click(T('title-join'))
          await phone.waitVisible(T('tutorial'))
          for (let k = 0; k < 3; k++) {
            eq(await phone.text(T('tutorial-next')), 'Next', `card ${k + 1}`)
            await phone.click(T('tutorial-next'))
          }
          eq(await phone.text(T('tutorial-next')), 'Got it', 'the last card')
          await phone.click(T('tutorial-next'))
          await phone.waitHidden(T('tutorial'))
          // Only once: leaving and joining again goes straight to the chat.
          await phone.go('title')
          await phone.click(T('title-join'))
          await phone.waitVisible(T('chat-input'))
          assert(!(await phone.visible(T('tutorial'))), 'the tutorial shows once')

          // Swipe up on the text box: the backlog.
          await phone.swipe('.dialogue', 0, -160)
          await phone.waitVisible(T('log'))
          await phone.key('Escape')
          await phone.waitHidden(T('log'))
          // Swipe down: everything but her hides; a tap brings it back.
          await phone.swipe('.dialogue', 0, 160)
          await phone.waitFor(() => document.querySelector('.chat')?.dataset.hidden === 'on', { label: 'hidden' })
          await phone.click(T('unhide'))
          await phone.waitFor(() => document.querySelector('.chat')?.dataset.hidden === '', { label: 'shown again' })
          await phone.waitVisible('.dialogue')

          // ⋯ → Quests opens the panel sheet on that tab; tabs switch; ✕ closes it.
          await phone.click(T('qm-more'))
          await phone.click(T('more-quests'))
          await phone.waitVisible(T('panel-tabs'))
          await phone.waitVisible('.chat-right')
          await phone.click(T('ptab-status'))
          await phone.waitVisible('.chat-left')
          await phone.click(T('ptab-close'))
          await phone.waitHidden(T('panel-tabs'))
        } finally {
          await phone.close()
        }
      },
    },
    {
      r: 'R77',
      name: 'a new pairing code drops the phone back to the pairing screen',
      async run({ app }) {
        const pair = await enablePhone(app)
        const phone = await openPhone(pair)
        try {
          await app.click(T('set-phone.reset'))
          await app.waitVisible('#confirm.show')
          await app.click('#confirmYes')
          await phone.waitVisible(T('pair'), 15_000)
          assert((await phone.text(T('pair'))).includes('Pair with your computer'), 'the pairing screen')
        } finally {
          await phone.close()
          await setField(app, 'phone.enabled', false)
        }
      },
    },
  ],
}
