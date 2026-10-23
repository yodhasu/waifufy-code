// R10–R17: Claude Code input habits — Enter/Shift+Enter, history, queueing, Esc, Shift+Tab, `/`, `@`, `!`, images.
import { assert, eq, fastText, focusInput, makeProject, newGame, readAll, say, sleep, T, turnEnd, waitScreen } from '../lib.mjs'

const VISIBLE_SLASH_ROWS = 5
const APP_COMMANDS = ['model', 'clear', 'resume', 'config', 'costume', 'help', 'exit']
const SDK_COMMANDS = ['compact', 'context', 'cost', 'triage-workflow']
const MODE_PRESSES = 4
const SAME_TICK_MS = 50
/** Long enough for a removed chip's message to have gone out, had it not been removed. */
const QUEUE_SETTLE_MS = 1000
/** Lets the mode badge follow the stats that confirmed the new mode. */
const BADGE_SETTLE_MS = 200
/** Longer than the @ picker's file search debounce plus a reply from the sidecar. */
const AT_SEARCH_MS = 1200
const CONFIRM_MS = 1500

const inputValue = (app) => app.value(T('chat-input'))

async function clearInput(app) {
  await focusInput(app)
  await app.key('Ctrl+A')
  await app.key('Backspace')
  await app.waitFor(() => document.querySelector('[data-test="chat-input"]').value === '', { label: 'empty input' })
}

/** Starts a fresh session in `cwd` with fast text and an empty input, ready for typing. */
async function freshChat(app, cwd) {
  if (await app.visible('#confirm')) await app.click('#confirmNo')
  await newGame(app, cwd)
  await fastText(app)
  await clearInput(app)
}

/** Types an app command through the slash picker and runs it with Enter. */
async function slash(app, name) {
  await clearInput(app)
  await app.typeKeys(`/${name}`)
  await app.waitVisible(T('slash-popup'))
  await app.key('Enter')
}

export default {
  name: 'Input: Claude Code habits',
  tests: [
    {
      r: 'R10',
      name: 'Enter sends; Shift+Enter inserts a newline and the textarea grows',
      async run({ app, project }) {
        await freshChat(app, project)
        const h0 = await app.eval(() => document.querySelector('[data-test="chat-input"]').offsetHeight)
        await app.type('line one')
        await app.key('Shift+Enter')
        await app.type('line two')
        await app.key('Shift+Enter')
        await app.type('line three')
        eq(await inputValue(app), 'line one\nline two\nline three', 'newlines in the input')
        const h1 = await app.eval(() => document.querySelector('[data-test="chat-input"]').offsetHeight)
        assert(h1 > h0, `the textarea grows (${h0} → ${h1}px)`)
        const m = await app.mark()
        await app.key('Enter')
        await app.waitSent('say', { text: 'line one\nline two\nline three' }, m)
        eq(await inputValue(app), '', 'input cleared after sending')
        await turnEnd(app, m)
        await readAll(app)
      },
    },
    {
      r: 'R10',
      name: '↑/↓ recall input history, per project',
      async run({ app, project }) {
        await freshChat(app, project)
        for (const line of ['first history line', 'second history line']) {
          const m = await say(app, line)
          await turnEnd(app, m)
        }
        await clearInput(app)
        await app.key('ArrowUp')
        eq(await inputValue(app), 'second history line', '↑ once')
        await app.key('ArrowUp')
        eq(await inputValue(app), 'first history line', '↑ twice')
        await app.key('ArrowDown')
        eq(await inputValue(app), 'second history line', '↓')

        await freshChat(app, makeProject('other-project'))
        await clearInput(app)
        await app.key('ArrowUp')
        assert((await inputValue(app)) !== 'second history line', 'another project has its own history')

        await freshChat(app, project)
        await clearInput(app)
        await app.key('ArrowUp')
        eq(await inputValue(app), 'second history line', 'history is kept for the first project')
        await clearInput(app)
      },
    },
    {
      r: 'R11',
      name: 'typing while she works queues the message as a chip; it goes out at the next turn; × removes one',
      timeout: 90_000,
      async run({ app, project }) {
        await freshChat(app, project)
        const m = await say(app, 'use some tools please')
        await app.waitEvent('tool', {}, m, 15_000)
        await focusInput(app)
        await app.type('queued one')
        await app.key('Enter')
        await app.waitVisible(T('queue-chip'))
        await app.type('queued two')
        await app.key('Enter')
        await app.waitFor(() => document.querySelectorAll('[data-test="queue-chip"]').length === 2, { label: 'two chips' })
        const chips = await app.texts(T('queue-chip'))
        assert(chips[0].includes('queued one') && chips[1].includes('queued two'), `chip texts ${chips}`)
        await app.eval(() => {
          const chip = [...document.querySelectorAll('[data-test="queue-chip"]')].find((c) => c.textContent.includes('queued two'))
          const x = chip.querySelector('button, [role=button], .x, .remove') ?? chip
          x.setAttribute('data-e2e-pick', 'x')
        })
        await app.click('[data-e2e-pick="x"]')
        await app.waitFor(() => document.querySelectorAll('[data-test="queue-chip"]').length === 1, { label: 'chip removed' })

        const first = await turnEnd(app, m, 60_000)
        const queued = await app.waitSent('say', { text: 'queued one' }, m, 20_000)
        // The app sends it from its own turn_end handler, which runs just before the recorder logs that event.
        assert(queued.at >= first.at - SAME_TICK_MS, 'the queued message went out when the running turn ended, not before')
        await app.waitFor((f, at) => window.__e2e.events.slice(f).some((e) => e.t === 'turn_end' && e.at > at), {
          args: [m.events, queued.at],
          timeout: 30_000,
          label: 'the queued message ran as its own turn',
        })
        await app.waitHidden(T('queue-chip'))
        await sleep(QUEUE_SETTLE_MS)
        assert(!(await app.sent(m, 'say')).some((s) => s.text === 'queued two'), 'the removed chip was never sent')
        await readAll(app)
      },
    },
    {
      r: 'R12',
      name: 'Esc closes the top overlay first, then interrupts the running turn',
      timeout: 60_000,
      async run({ app, project }) {
        await freshChat(app, project)
        const m = await say(app, 'use some tools please')
        await app.waitEvent('tool', {}, m, 15_000)
        await app.key('Ctrl+L')
        await app.waitVisible(T('log'))
        await app.key('Escape')
        await app.waitHidden(T('log'))
        assert(!(await app.sent(m, 'interrupt')).length, 'closing the overlay did not interrupt')
        await app.key('Escape')
        await app.waitSent('interrupt', {}, m)
        await app.waitEvent('turn_end', { interrupted: true }, m)
      },
    },
    {
      r: ['R12', 'R11'],
      name: 'Esc interrupts and gives queued messages back to the input instead of running them',
      timeout: 60_000,
      async run({ app, project }) {
        await freshChat(app, project)
        const m = await say(app, 'use some tools please')
        await app.waitEvent('tool', {}, m, 15_000)
        await focusInput(app)
        await app.type('queued after all')
        await app.key('Enter')
        await app.waitVisible(T('queue-chip'))
        await app.key('Escape')
        await app.waitSent('interrupt', {}, m)
        await app.waitEvent('turn_end', { interrupted: true }, m)
        await app.waitFor(() => document.querySelector('[data-test="chat-input"]').value.includes('queued after all'), {
          label: 'the queued message is back in the input',
        })
        eq(await app.count(T('queue-chip')), 0, 'no chip is left')
        await sleep(QUEUE_SETTLE_MS)
        assert(!(await app.sent(m, 'say')).some((x) => x.text === 'queued after all'), 'the queued message was not sent')
        await clearInput(app)
      },
    },
    {
      r: 'R13',
      name: 'Shift+Tab cycles default → acceptEdits → plan; the badge shows the real mode',
      async run({ app, project }) {
        await freshChat(app, project)
        const modes = []
        const badges = []
        for (let k = 0; k < MODE_PRESSES; k++) {
          const m = await app.mark()
          await focusInput(app)
          await app.key('Shift+Tab')
          const sent = await app.waitSent('mode', {}, m)
          modes.push(sent.mode)
          await app.waitEvent('stats', {}, m)
          await sleep(BADGE_SETTLE_MS)
          badges.push(await app.text(T('badge-mode')))
          if (sent.mode === 'default') break
        }
        eq(modes.slice(0, 2), ['acceptEdits', 'plan'], 'cycle order')
        eq(modes.at(-1), 'default', 'the cycle returns to default')
        assert(/accept|edit/i.test(badges[0]), `badge for acceptEdits: "${badges[0]}"`)
        assert(/plan/i.test(badges[1]), `badge for plan: "${badges[1]}"`)
        assert(new Set(badges).size === badges.length, `each mode has its own badge: ${badges}`)
        const m = await app.mark()
        await app.click(T('qm-mode'))
        const viaMenu = await app.waitSent('mode', {}, m)
        eq(viaMenu.mode, 'acceptEdits', 'the quick menu Mode button cycles too')
        await app.eval(() => window.__wc.link.send({ t: 'mode', mode: 'default' }))
      },
    },
    {
      r: 'R14',
      name: '/ opens the picker: 5 visible rows, scrolling, SDK + app commands, Esc closes it first',
      async run({ app, project }) {
        await freshChat(app, project)
        await app.typeKeys('/')
        await app.waitVisible(T('slash-popup'))
        const box = await app.eval(() => {
          const pop = document.querySelector('[data-test="slash-popup"]')
          const p = pop.getBoundingClientRect()
          const items = [...pop.querySelectorAll('[data-test="slash-item"]')]
          const inView = items.filter((el) => {
            const r = el.getBoundingClientRect()
            return r.height > 0 && r.top >= p.top - 1 && r.bottom <= p.bottom + 1
          })
          return { total: items.length, inView: inView.length, names: items.map((el) => el.dataset.name), scrolls: pop.scrollHeight > pop.clientHeight }
        })
        eq(box.inView, VISIBLE_SLASH_ROWS, 'rows in view')
        assert(box.total > VISIBLE_SLASH_ROWS && box.scrolls, `the list scrolls (${box.total} items)`)
        for (const n of [...APP_COMMANDS, ...SDK_COMMANDS]) assert(box.names.includes(n), `/${n} is listed`)
        for (let k = 0; k < VISIBLE_SLASH_ROWS + 2; k++) await app.key('ArrowDown')
        assert(await app.eval(() => document.querySelector('[data-test="slash-popup"]').scrollTop > 0), '↓ past the 5th row scrolls')
        const m = await app.mark()
        await app.key('Escape')
        await app.waitHidden(T('slash-popup'))
        assert(!(await app.sent(m, 'interrupt')).length, 'Esc closed the picker, nothing else')
      },
    },
    {
      r: 'R14',
      name: 'Tab completes; Enter runs /context and its output is shown',
      async run({ app, project }) {
        await freshChat(app, project)
        await app.typeKeys('/cont')
        await app.waitVisible(T('slash-popup'))
        const names = await app.eval(() =>
          [...document.querySelectorAll('[data-test="slash-item"]')].filter((el) => window.__e2e.isVisible(el)).map((el) => el.dataset.name),
        )
        assert(names.includes('context'), `filtered list has context: ${names}`)
        await app.key('Tab')
        assert((await inputValue(app)).trim() === '/context', `Tab completed to "${await inputValue(app)}"`)
        const m = await app.mark()
        await app.key('Enter')
        await app.waitFor((f) => window.__e2e.sent.slice(f).some((s) => s.t === 'say' && s.text.trim() === '/context'), {
          args: [m.sent],
          label: 'say /context',
        })
        const notice = await app.waitEvent('notice', { kind: 'command' }, m)
        assert(notice.text.includes('Context Usage'), 'the SDK command answered')
        await app.waitFor(() => document.getElementById('stage').innerText.includes('Context Usage'), { label: '/context output on screen' })
      },
    },
    {
      r: 'R14',
      name: 'app commands: /help, /costume, /model, /clear, /resume, /config, /exit',
      timeout: 120_000,
      async run({ app, project }) {
        await freshChat(app, project)
        for (const [cmd, hook] of [['help', 'help'], ['costume', 'costume-picker']]) {
          await slash(app, cmd)
          await app.waitVisible(T(hook))
          await app.key('Escape')
          await app.waitHidden(T(hook))
        }

        await slash(app, 'model')
        await app.waitVisible(T('model-picker'))
        const values = await app.attrs(T('model-item'), 'data-v')
        for (const v of ['default', 'opus', 'sonnet', 'haiku']) assert(values.includes(v), `model ${v} listed`)
        let m = await app.mark()
        await app.click(T('model-item', { v: 'haiku' }))
        await app.waitSent('model', { model: 'haiku' }, m)
        await app.waitFor(() => /haiku/i.test(document.querySelector('[data-test="badge-model"]')?.textContent ?? ''), { label: 'badge-model shows haiku' })

        m = await app.mark()
        await slash(app, 'clear')
        if (await app.waitVisible('#confirm', CONFIRM_MS).catch(() => false)) await app.click('#confirmYes')
        await app.waitFor(
          (f, cwd) =>
            window.__e2e.sent.slice(f).some((s) => s.t === 'start' && s.cwd === cwd && !s.resume) ||
            window.__e2e.sent.slice(f).some((s) => s.t === 'say' && s.text.trim() === '/clear'),
          { args: [m.sent, project], label: '/clear starts fresh in the same folder' },
        )

        await slash(app, 'resume')
        await waitScreen(app, 'saves')
        await freshChat(app, project)
        await slash(app, 'config')
        await waitScreen(app, 'settings')
        await freshChat(app, project)
        await slash(app, 'exit')
        await waitScreen(app, 'title')
      },
    },
    {
      r: 'R15',
      name: '@ opens a fuzzy file picker that respects .gitignore and inserts the path',
      async run({ app, project }) {
        await freshChat(app, project)
        await app.typeKeys('@load')
        await app.waitVisible(T('at-popup'))
        await app.waitFor(
          () =>
            [...document.querySelectorAll('[data-test="at-item"]')]
              .map((el) => el.dataset.path.replace(/\\/g, '/'))
              .some((p) => p.includes('prompts/loader.ts')),
          {
          label: 'loader.ts in the @ picker',
        })
        await app.key('Enter')
        await app.waitFor(() => document.querySelector('[data-test="chat-input"]').value.replace(/\\/g, '/').includes('src/prompts/loader.ts'), {
          label: 'path inserted',
        })
        await clearInput(app)
        await app.typeKeys('@hidden')
        await sleep(AT_SEARCH_MS)
        const paths = await app.attrs(T('at-item'), 'data-path')
        assert(!paths.some((p) => /secret[\\/]/.test(p)), `.gitignore'd files are not offered: ${paths}`)
        await app.key('Escape')
        await clearInput(app)
      },
    },
    {
      r: 'R16',
      name: '!cmd runs a shell command; the output is shown and logged',
      async run({ app, project }) {
        await freshChat(app, project)
        await app.typeKeys('!')
        await app.waitFor(() => document.querySelector('[data-test="input-mode"]')?.dataset.mode === 'bash', { label: 'bash mode' })
        await app.type('git status')
        const m = await app.mark()
        await app.key('Enter')
        const sent = await app.waitSent('shell', {}, m)
        eq(sent.command.replace(/^!/, ''), 'git status', 'shell command')
        await app.waitEvent('shell_result', {}, m)
        await app.waitFor(() => document.getElementById('stage').innerText.includes('On branch main'), { label: 'shell output on screen' })
        await app.key('Ctrl+L')
        await app.waitVisible(T('log'))
        const log = (await app.texts(T('log-entry'))).join('\n')
        assert(log.includes('git status') && log.includes('On branch main'), 'command and output in LOG')
        await app.key('Escape')
        await app.waitFor(() => document.querySelector('[data-test="input-mode"]')?.dataset.mode !== 'bash', { label: 'back to normal mode' })
      },
    },
    {
      r: 'R17',
      name: 'paste and drop images: thumbnails, sent as image blocks',
      async run({ app, project }) {
        await freshChat(app, project)
        assert(await app.visible(T('chat-attach')), '📎 attach button')
        await app.pasteImage(T('chat-input'))
        await app.waitVisible(T('image-chip'))
        await app.pasteImage(T('chat-input'), { kind: 'drop' })
        await app.waitFor(() => document.querySelectorAll('[data-test="image-chip"]').length === 2, { label: 'dropped image adds a second chip' })
        await focusInput(app)
        await app.type('what is in these pictures')
        const m = await app.mark()
        await app.key('Enter')
        const sent = await app.waitSent('say', { text: 'what is in these pictures' }, m)
        eq(sent.images?.length, 2, 'two images sent')
        assert(sent.images.every((i) => i.mediaType === 'image/png' && i.data.length > 100 && !i.data.startsWith('data:')), 'base64 image blocks')
        await turnEnd(app, m)
        await app.waitFor(() => /2 images/.test(document.querySelector('[data-test="dialogue-text"]').textContent), { label: 'she saw 2 images' })
        eq(await app.count(T('image-chip')), 0, 'chips cleared after sending')
      },
    },
  ],
}
