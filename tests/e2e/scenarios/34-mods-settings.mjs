// The Mods tab (WC-20): every mod with its status and an enable switch (permissions shown before the first
// enable), declared settings drawn as native controls, secrets that never reach a file, and a mod's own settings
// page in the `settings` slot. Fixture mods: tests/e2e/fixtures/mods (probe is seeded on, boom and knobs are not).
// Tagged M2, the mod work's own tag (M1 is the panel slots).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, eq, T } from '../lib.mjs'

const MODS = fileURLToPath(new URL('../fixtures/mods', import.meta.url))
const row = (id) => T('mod-row', { id })
const field = (key) => T(`set-mods.knobs.${key}`)
const switchOf = (id) => `${row(id)} ${T(`set-mods.${id}`)} + i`

/** Waits for a `report` from the knobs settings page whose params satisfy `pred`, after `from`. */
function reported(app, pred, from = 0) {
  return app.waitFor(
    (src, f) => {
      const test = new Function('p', `return (${src})(p)`)
      return window.__e2e.sent.slice(f).find((e) => e.t === 'mod-call' && e.id === 'knobs' && e.method === 'report' && e.params && test(e.params))
    },
    { args: [pred.toString(), from.sent ?? from], label: `the knobs page reports ${pred}` },
  )
}

async function openMods(app) {
  await app.go('settings')
  await app.waitVisible('[data-tab="mods"]')
  await app.click('[data-tab="mods"]')
  await app.waitVisible(row('probe'))
}

export default {
  name: 'Mods: the Mods tab, declared and secret settings, the settings page',
  launch: () => ({
    settings: { plugins: { probe: true } },
    env: { WC_MODS_DIR: MODS },
  }),
  tests: [
    {
      r: 'M2',
      name: 'the Mods tab lists the fixture mods with their status, and the built-in plugins under Built-in',
      async run({ app }) {
        await openMods(app)
        await app.waitText(`${row('probe')} ${T('mod-status')}`, 'running')
        const rows = await app.eval(() =>
          Object.fromEntries(
            [...document.querySelectorAll('[data-test="mod-row"]')].map((r) => [
              r.dataset.id,
              { status: r.querySelector('[data-test="mod-status"]').textContent.trim(), on: r.querySelector('input[data-test^="set-mods."]').checked },
            ]),
          ),
        )
        eq(rows.probe, { status: 'running', on: true }, 'probe runs')
        eq(rows.knobs, { status: 'off', on: false }, 'knobs is off')
        assert(rows.boom, 'boom is listed')
        eq(await app.eval(() => !!document.querySelector('[data-test="mods-builtin"], [data-test^="set-plugins."]')), false, 'no built-in group is left')
      },
    },
    {
      r: 'M2',
      name: 'the first enable shows the permission list; confirming enables, and a second enable skips it',
      async run({ app }) {
        const m = await app.mark()
        await app.click(switchOf('knobs'))
        await app.waitVisible(`${row('knobs')} ${T('mod-perms')}`)
        eq(await app.texts(`${row('knobs')} ${T('mod-perm')}`), ['events.turn', 'notify'], 'the requested permissions')
        eq((await app.sent(m, 'mod-enable')).length, 0, 'nothing is enabled before the user confirms')
        await app.click(`${row('knobs')} ${T('mod-perms-ok')}`)
        await app.waitSent('mod-enable', { id: 'knobs', enabled: true }, m)
        await app.waitText(`${row('knobs')} ${T('mod-status')}`, 'running')
        // Off and on again: approved once, so no list this time.
        const m2 = await app.mark()
        await app.click(switchOf('knobs'))
        await app.waitSent('mod-enable', { id: 'knobs', enabled: false }, m2)
        await app.waitText(`${row('knobs')} ${T('mod-status')}`, 'off')
        await app.click(switchOf('knobs'))
        await app.waitSent('mod-enable', { id: 'knobs', enabled: true }, m2)
        assert(!(await app.exists(`${row('knobs')} ${T('mod-perms')}`)), 'no permission list the second time')
        await app.waitText(`${row('knobs')} ${T('mod-status')}`, 'running')
      },
    },
    {
      r: 'M2',
      name: 'changing a number setting reaches the backend (the settings page shows the new value)',
      async run({ app }) {
        await app.waitVisible(field('limit'))
        eq(await app.value(field('limit')), '3', 'the default is painted')
        const m = await app.mark()
        await app.setValue(field('limit'), '7')
        await app.waitSent('mod-settings', { id: 'knobs', values: { limit: 7 } }, m)
        await reported(app, (p) => p.settings && p.settings.limit === 7, m)
        // One field at a time must not wipe the others.
        await app.setValue(field('name'), 'Ram')
        await reported(app, (p) => p.settings && p.settings.limit === 7 && p.settings.name === 'Ram', m)
        eq(await app.value(field('limit')), '7', 'the number stays painted')
      },
    },
    {
      r: 'M2',
      name: 'a secret field value reaches the backend but never appears in mod-data/<id>/settings.json',
      async run({ app }) {
        const m = await app.mark()
        await app.setValue(field('token'), 'hunter2')
        await app.waitSent('mod-settings', { id: 'knobs', values: { token: 'hunter2' } }, m)
        await reported(app, (p) => p.settings && p.settings.token === 'hunter2', m)
        const file = readFileSync(join(app.dataDir, 'mod-data', 'knobs', 'settings.json'), 'utf8')
        assert(!file.includes('hunter2'), 'the secret is not in the file')
        assert(file.includes('"limit": 7'), `the plain values are: ${file}`)
        assert(!JSON.stringify(app.readSettingsFile()).includes('hunter2'), 'nor in the app settings')
      },
    },
    {
      r: 'M2',
      name: 'after the link reconnects the app re-sends the stored secret',
      async run({ app }) {
        const m = await app.mark()
        await app.eval(() => window.__e2e.dropLinks())
        await app.waitSent('mod-settings', { id: 'knobs', values: { token: 'hunter2' } }, m, 15_000)
      },
    },
    {
      r: 'M2',
      name: 'the custom settings page renders in the settings slot under the mod row',
      async run({ app }) {
        await app.waitVisible(`${row('knobs')} ${T('mod-panel', { id: 'knobs' })} iframe`)
        eq(await app.eval(() => document.querySelector('[data-test="mod-row"][data-id="knobs"] iframe').getAttribute('sandbox')), 'allow-scripts', 'sandboxed like a panel')
        await reported(app, (p) => p.page === 'settings')
      },
    },
    {
      r: 'M2',
      name: 'a new settings-page URL (a restarted link has a new token) remounts the page',
      async run({ app }) {
        const sel = `${row('knobs')} iframe`
        const before = await app.eval((s) => document.querySelector(s).src, sel)
        const mods = (await app.events(0, 'mods')).at(-1).mods.map((m) => (m.id === 'knobs' ? { ...m, settingsPageUrl: m.settingsPageUrl + '?t=2' } : m))
        await app.inject({ t: 'mods', mods })
        await app.waitFor((s, old) => document.querySelector(s)?.src.endsWith('?t=2') && document.querySelector(s).src !== old, { args: [sel, before], label: 'the settings page iframe is mounted with the new URL' })
        // The same list again must not remount it.
        await app.eval((s) => void (window.__frame = document.querySelector(s)), sel)
        await app.inject({ t: 'mods', mods })
        eq(await app.eval((s) => window.__frame === document.querySelector(s), sel), true, 'an unchanged URL keeps the frame')
      },
    },
  ],
}
