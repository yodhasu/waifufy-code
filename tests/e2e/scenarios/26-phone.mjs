// Phone access (docs/V0.5.md R77–R78): the desktop turns it on and shows a pairing code; a phone (a second, phone-sized
// headless Chrome loading the app with ?pair=…, driver.mjs openPhone) joins the session running on the desktop,
// chats in it, answers a prompt the desktop sees close, keeps its own pairing through a new code, and is dropped when
// the desktop removes it.
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
      name: 'Settings → Phone shows a pairing code; a phone pairs with it, in portrait, with Join and Exit',
      async run({ app }) {
        const pair = await enablePhone(app)
        assert((await app.text(T('phone-status'))).includes('waiting for your phone'), 'waiting')
        const phone = await openPhone(pair)
        try {
          eq(await phone.eval(() => document.getElementById('stage').dataset.orient), 'portrait', 'portrait stage')
          await phone.waitVisible(T('title-join'))
          assert(!(await phone.eval(() => document.querySelector('[data-test="title-exit"]').hidden)), 'a phone has Exit too (it closes the app)')
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
          // Pocket VN: the composer waits behind Reply.
          await phone.waitVisible(T('qm-reply'))
          assert(!(await phone.visible(T('chat-input'))), 'no composer until Reply')
          await phone.click(T('qm-reply'))
          await phone.waitVisible(T('chat-input'))
          await phone.waitFor(() => !document.querySelector('[data-test="chat-input"]')?.disabled, { label: 'phone input enabled' })
          // Joining doesn't end the desktop's session.
          assert(!(await app.eval(() => window.__e2e.events.some((e) => e.t === 'ended'))), 'the desktop session still runs')
          // A message from the phone runs in the desktop's session, and the desktop shows the prompt it brings.
          await say(phone, 'permission please')
          // Sending closes the composer again.
          await phone.waitHidden(T('chat-input'))
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
          await phone.waitVisible(T('qm-reply'))
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
          await phone.click(T('pb-more'))
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
      r: 'R78',
      name: 'a phone held sideways gets the Theater: the side bar, the composer beside her, Quests in the sheet',
      async run({ app, project }) {
        const pair = await enablePhone(app)
        const start = await newGame(app, project)
        await fastText(app)
        const phone = await openPhone(pair, { viewport: '915x412@2.625' })
        try {
          eq(await phone.eval(() => document.getElementById('stage').dataset.orient), 'landscape', 'landscape stage')
          await phone.click(T('title-join'))
          // The tutorial is about the upright controls, so a phone held sideways skips it.
          await phone.waitVisible(T('prail'))
          await phone.waitVisible(T('chat-input'))
          await phone.waitVisible(T('pb-leave'))
          assert(!(await phone.visible(T('qm-log'))), 'the side bar replaces the quick menu')
          await phone.click(T('rail-quests'))
          await phone.waitVisible('.chat-right')
          await phone.click(T('ptab-close'))
          await phone.waitHidden(T('panel-tabs'))
          // ✕ leaves for the title; the computer's session goes on.
          await phone.click(T('pb-leave'))
          await phone.waitVisible(T('title-join'))
          assert(!(await app.eval((ep) => window.__e2e.events.some((e) => e.t === 'ended' && e.epoch === ep), start.epoch)), 'the session still runs')
        } finally {
          await phone.close()
        }
      },
    },
    {
      r: 'R78',
      name: 'a joining phone gets the whole session: the desktop\'s actions, its lines, an open prompt above the tutorial',
      async run({ app, project }) {
        const pair = await enablePhone(app)
        await newGame(app, project)
        await fastText(app)
        await say(app, 'tools please')
        await turnEnd(app)
        await say(app, 'permission please')
        await app.waitVisible(T('ask'), 15_000)
        const deskActs = await app.eval(() => document.querySelectorAll('.chat .act').length)
        const phone = await openPhone(pair)
        try {
          await fastText(phone)
          await phone.click(T('title-join'))
          // The prompt open on the desktop shows on the phone too, and the first-chat tutorial waits behind it.
          await phone.waitVisible(T('ask'), 15_000)
          assert(!(await phone.visible(T('tutorial'))), 'the tutorial covers the prompt')
          eq(await phone.eval(() => document.querySelectorAll('.chat .act').length), deskActs, 'the same actions as the desktop')
          await phone.click(`${T('ask')} ${T('ask-option')}`)
          await app.waitHidden(T('ask'), 10_000)
          await phone.waitVisible(T('tutorial'))
          await phone.click(T('tutorial-skip'))
          await turnEnd(app)
          // The LOG has what the desktop said.
          await phone.click(T('qm-log'))
          await phone.waitVisible(T('log'))
          assert((await phone.text(T('log'))).includes('tools please'), 'the desktop\'s line is in the phone\'s LOG')
          await phone.key('Escape')
        } finally {
          await phone.close()
        }
      },
    },
    {
      r: 'R78',
      name: 'a phone that loses its connection (Android in the background) stays in the session; a restart goes back in',
      async run({ app, project }) {
        const pair = await enablePhone(app)
        await newGame(app, project)
        await fastText(app)
        // The app stays open across this file's tests: sessions they replaced ended before this mark.
        const since = (await app.mark()).events
        const phone = await openPhone(pair)
        try {
          await fastText(phone)
          await phone.eval(() => localStorage.setItem('wc-phone-tutorial', '1'))
          await phone.click(T('title-join'))
          await phone.waitVisible(T('qm-reply'))
          await phone.eval(() => window.__e2e.dropLinks())
          await phone.waitFor(() => /Joining|ready|today/i.test(document.querySelector('.dialogue')?.textContent ?? ''), { label: 'back in the session', timeout: 10_000 })
          assert(!/stopped unexpectedly/.test(await chatText(phone)), 'the phone ended the session')
          // What she does meanwhile on the desktop reaches the phone through the new connection.
          await say(app, 'permission please')
          await phone.waitVisible(T('ask'), 15_000)
          await app.click(`${T('ask')} ${T('ask-option')}`)
          await turnEnd(app)
          // Android killed the app: it starts again and goes straight back into the chat.
          await phone.eval(() => location.reload())
          await phone.waitFor(() => document.getElementById('stage')?.dataset.screen === 'chat', { label: 'the chat after a restart', timeout: 20_000 })
          assert(!(await app.eval((f) => window.__e2e.events.slice(f).some((e) => e.t === 'ended'), since)), 'the desktop session still runs')
        } finally {
          await phone.close()
        }
      },
    },
    {
      r: 'R78',
      name: 'low-spec mode: no character is loaded, and the session reads as a chat room',
      timeout: 120_000,
      async run({ app, project }) {
        const pair = await enablePhone(app)
        await newGame(app, project)
        await fastText(app)
        await say(app, 'hello from the desk')
        await turnEnd(app)
        const phone = await openPhone(pair)
        try {
          await phone.eval(() => (localStorage.setItem('wc-lowspec', '1'), location.reload()))
          await phone.waitFor(() => window.__wc?.router.current() === 'title' && document.documentElement.dataset.lowspec === '1', { timeout: 30_000, label: 'low-spec title' })
          await phone.waitFor(() => !document.querySelector('[data-test="title-join"]')?.hidden, { label: 'Join' })
          await fastText(phone)
          await phone.click(T('title-join'))
          await phone.waitVisible(T('chatroom'), 20_000)
          await phone.waitFor(() => [...document.querySelectorAll('[data-test="chatroom-entry"]')].some((e) => e.dataset.who === 'user' && e.textContent.includes('hello from the desk')), { label: 'the desk line in the room' })
          eq(await phone.eval(() => document.getElementById('chara').dataset.model), 'none', 'no model')
          eq(await phone.eval(() => document.querySelectorAll('canvas').length), 0, 'nothing drawn')
          assert(!(await phone.visible(T('tutorial'))), 'no visual-novel tutorial')
        } finally {
          await phone.close()
        }
      },
    },
    {
      r: 'R77',
      name: 'a phone that cannot reach its computer waits and keeps its pairing, then connects on its own once it can',
      async run({ app }) {
        const pair = await enablePhone(app)
        await setField(app, 'phone.enabled', false)
        const phone = await openPhone(pair, { boot: false })
        try {
          await phone.waitVisible(T('pair-waiting'), 20_000)
          assert(!(await phone.visible(T('pair'))), 'not sent back to the pairing screen')
          // The computer comes back: the phone connects without anyone touching it.
          await setField(app, 'phone.enabled', true)
          await phone.waitVisible(T('title-join'), 30_000)
          assert(!(await phone.visible(T('pair-waiting'))), 'the waiting screen is gone')
        } finally {
          await phone.close()
          await setField(app, 'phone.enabled', false)
        }
      },
    },
    {
      r: 'R77',
      name: 'a phone that lost its own token pairs again by itself with the link it saved (no computer screen)',
      timeout: 60_000,
      async run({ app }) {
        const pair = await enablePhone(app)
        const phone = await openPhone(pair)
        try {
          await phone.waitFor(() => !!localStorage.getItem('wc-pair-code') && JSON.parse(localStorage.getItem('wc-pairing')).token !== JSON.parse(localStorage.getItem('wc-pair-code')).token, { label: 'paired, with the link kept' })
          // Its own token gone bad (as after the computer forgot it), and no pairing link in the page address this time.
          await phone.eval(() => {
            const p = JSON.parse(localStorage.getItem('wc-pairing'))
            localStorage.setItem('wc-pairing', JSON.stringify({ ...p, token: 'lost' }))
            location.href = location.origin + '/'
          })
          await phone.waitFor(() => window.__wc?.router.current() === 'title' && !document.querySelector('[data-test="pair"]'), { timeout: 40_000, label: 'back in, without the pairing screen' })
          const token = await phone.eval(() => JSON.parse(localStorage.getItem('wc-pairing')).token)
          assert(token !== 'lost' && token.length > 20, 'a new token of its own')
        } finally {
          await phone.close()
        }
      },
    },
    {
      r: 'R77',
      name: 'a phone keeps its own pairing through a new code; removing it on the desktop drops it to the pairing screen',
      async run({ app }) {
        const pair = await enablePhone(app)
        const phone = await openPhone(pair)
        try {
          // Paired with the code: the phone now holds a token of its own, and the desktop lists it.
          await phone.waitFor((code) => JSON.parse(localStorage.getItem('wc-pairing') ?? '{}').token !== code, {
            args: [new URL(pair.replace('waifufy-code://', 'http://x/')).searchParams.get('t')],
            label: 'a device token saved',
          })
          await app.waitVisible(T('phone-device'))
          await app.click(T('set-phone.reset'))
          await app.waitVisible('#confirm.show')
          await app.click('#confirmYes')
          await new Promise((r) => setTimeout(r, 1500))
          assert(!(await phone.visible(T('pair'))), 'a new code leaves the phone paired')
          await app.click(T('phone-forget'))
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
