// Mod panels (WC-20): the app mounts an enabled mod's panel in a sandboxed iframe in its chat slot and bridges
// it to the link. The fixture panels (tests/e2e/fixtures/mods) report what they see through
// `waifufy.call('report', …)`, which the test reads off the app's socket: the frame is cross-origin to the page.
// Tagged M1, the mod work's own tag (R1–R82 predate it).
import { fileURLToPath } from 'node:url'
import { assert, eq, newGame, T } from '../lib.mjs'

const MODS = fileURLToPath(new URL('../fixtures/mods', import.meta.url))
const panel = (id) => T('mod-panel', { id })

/** Waits for a `report` from the probe panel whose params carry `key`, after `from`; resolves the params. */
async function reported(app, key, from = 0) {
  const m = await app.waitFor(
    (k, f) => window.__e2e.sent.slice(f).find((e) => e.t === 'mod-call' && e.id === 'probe' && e.method === 'report' && e.params && k in e.params),
    { args: [key, from.sent ?? from], label: `the probe panel reports ${key}` },
  )
  return m.params[key]
}

const rootAccent = (app) => app.eval(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())

export default {
  name: 'Mods: sandboxed panel slots in the chat',
  launch: () => ({
    settings: { plugins: { probe: true, boom: true } },
    env: { WC_MODS_DIR: MODS },
  }),
  tests: [
    {
      r: 'M1',
      name: 'the fixture panel appears in chat.left inside a sandboxed iframe (sandbox attr equals "allow-scripts")',
      async run({ app, project }) {
        await newGame(app, project)
        await app.waitVisible(`${panel('probe')} iframe`)
        const f = await app.eval(() => {
          const el = document.querySelector('[data-test="mod-panel"][data-id="probe"]')
          const frame = el.querySelector('iframe')
          return { left: !!el.closest('.chat-left'), sandbox: frame.getAttribute('sandbox'), title: frame.title, src: frame.src }
        })
        eq(f.left, true, 'the panel sits in the left column')
        eq(f.sandbox, 'allow-scripts', 'the sandbox allows scripts and nothing else')
        eq(f.title, 'Probe panel', 'the frame is titled with the mod name')
        assert(/^http:\/\/127\.0\.0\.1:\d+\/mods\/probe\/[0-9a-f]+\/ui\/index\.html$/.test(f.src), `the served panel URL: ${f.src}`)
        // The built-in left-column order holds: badges, then plugin/mod slots, then the footer.
        const order = await app.eval(() => [...document.querySelector('.chat-left').children].map((e) =>
          e.classList.contains('badges') ? 'badges' : e.querySelector('[data-test="mod-panel"]') ? 'mod' : e.classList.contains('left-foot') ? 'foot' : 'other'))
        assert(order.indexOf('mod') > order.indexOf('badges') && order.indexOf('foot') > order.indexOf('mod'), `between badges and footer: ${order}`)
      },
    },
    {
      r: 'M1',
      name: 'the panel cannot read the parent document (access throws)',
      async run({ app }) {
        eq(await reported(app, 'parentDoc'), 'threw', 'window.parent.document throws inside the frame')
      },
    },
    {
      r: 'M1',
      name: 'a panel call round-trips to its backend',
      async run({ app }) {
        eq(await reported(app, 'echo'), { n: 1 }, 'the backend echoed the params back to the panel')
      },
    },
    {
      r: 'M1',
      name: 'a backend push reaches the panel',
      async run({ app }) {
        eq(await reported(app, 'tick'), { n: 2 }, 'the pushed tick arrived in the panel')
      },
    },
    {
      r: 'M1',
      name: 'theme vars arrive in the panel, and again when the theme changes',
      async run({ app }) {
        eq(await reported(app, 'accent'), await rootAccent(app), 'the panel got the app accent on ready')
        const m = await app.mark()
        await app.updateSettings({ appearance: { accent: '#e05b8d' } })
        eq(await reported(app, 'accent', m), '#e05b8d', 'the changed accent was re-sent')
      },
    },
    {
      r: 'M1',
      name: 'the _app events: theme.set sets app vars, notify shows a toast',
      async run({ app }) {
        await app.inject({ t: 'mod-event', id: '_app', type: 'theme.set', payload: { '--mod-probe': '7px', color: 'red' } })
        await app.waitFor(() => getComputedStyle(document.documentElement).getPropertyValue('--mod-probe').trim() === '7px', { label: 'the var is set on :root' })
        eq(await app.eval(() => document.documentElement.style.color), '', 'a key that is not a CSS variable is ignored')
        await app.inject({ t: 'mod-event', id: '_app', type: 'notify', payload: { modId: 'probe', text: 'Build finished' } })
        await app.waitFor(() => document.getElementById('toast').classList.contains('show') && document.getElementById('toast').textContent.includes('Build finished'), { label: 'the toast shows the text' })
      },
    },
    {
      r: 'M1',
      name: 'the crash fixture shows mod-error in chat.right; Disable removes the panel',
      async run({ app }) {
        await app.waitVisible(`${panel('boom')} ${T('mod-error')}`, 15_000)
        eq(await app.eval(() => !!document.querySelector('[data-test="mod-panel"][data-id="boom"]').closest('.chat-right')), true, 'the panel sits in the right column')
        await app.waitVisible(`${panel('boom')} ${T('mod-retry')}`)
        const m = await app.mark()
        await app.click(`${panel('boom')} ${T('mod-disable')}`)
        await app.waitSent('mod-enable', { id: 'boom', enabled: false }, m)
        await app.waitFor(() => !document.querySelector('[data-test="mod-panel"][data-id="boom"]'), { label: 'the boom panel is gone' })
        eq(await app.eval(() => !!document.querySelector('[data-test="mod-panel"][data-id="probe"] iframe')), true, 'the other panel stays')
      },
    },
    {
      r: 'M1',
      name: 'after a link reconnect the app asks for mods again and tells each panel',
      async run({ app }) {
        const m = await app.mark()
        await app.eval(() => window.__e2e.dropLinks())
        await app.waitSent('mods', {}, m, 10_000)
        eq(await reported(app, 'reconnected', m), true, 'the panel got the reconnected event')
        assert((await reported(app, 'accent', m)) !== undefined, 'the theme was re-sent')
      },
    },
  ],
}
