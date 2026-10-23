// R48: first run. A fresh data dir with no settings.json opens the welcome wizard.
import { assert, brightSurfaces, byText, eq, setField, sleep, T, waitScreen } from '../lib.mjs'

const MAX_STEPS = 10
const STEP_SETTLE_MS = 300
const STEP_FADE_MS = 4000
const DETECT_MS = 5000
const PERSIST_MS = 3000
const PERSIST_POLL_MS = 100
/** A step counts as shown once every field on it is this opaque (or fully hidden). */
const OPAQUE = 0.95
const THEME_SETTLE_MS = 350
/** A hook inside the wizard: the settings page has the same `set-*` hooks. */
const W = (name) => `#screen-wizard ${T(name)}`
const LOGGED_OUT = { t: 'auth', auth: { loggedIn: false, error: 'Not logged in · Please run /login' } }

/** Visible `set-*` hooks on the wizard's current step, once its entrance animation has settled. */
async function stepFields(app) {
  let last
  const deadline = Date.now() + STEP_FADE_MS
  for (;;) {
    await sleep(STEP_SETTLE_MS)
    const now = await app.eval(() =>
      JSON.stringify(
        [...document.querySelectorAll('#screen-wizard [data-test^="set-"]')].filter((el) => window.__e2e.isVisible(el)).map((el) => el.dataset.test),
      ),
    )
    const opaque = await app.eval(
      (limit) =>
        [...document.querySelectorAll('#screen-wizard [data-test^="set-"]')].every((el) => {
          let alpha = 1
          for (let n = el; n; n = n.parentElement) alpha *= Number(getComputedStyle(n).opacity)
          return alpha === 0 || alpha > limit
        }),
      OPAQUE,
    )
    if ((now === last && opaque) || Date.now() > deadline) return JSON.parse(now)
    last = now
  }
}

export default {
  name: 'First-run wizard',
  launch: { wizard: true },
  tests: [
    {
      r: 'R48',
      name: 'a fresh data dir opens the wizard, not the title',
      async run({ app }) {
        await waitScreen(app, 'wizard')
        await app.waitVisible(T('wizard-next'))
        assert(!(await app.settings()).onboarded, 'settings are not onboarded yet')
      },
    },
    {
      r: ['R46', 'R48'],
      name: 'the wizard is themed in dark mode too',
      async run({ app }) {
        await app.updateSettings({ appearance: { theme: 'dark' } })
        try {
          await app.waitFor(() => document.documentElement.dataset.theme === 'dark', { label: 'dark theme' })
          await sleep(THEME_SETTLE_MS)
          await app.screenshot('dark-wizard')
          const bright = await brightSurfaces(app)
          assert(!bright.length, `bright surfaces on the dark wizard: ${bright}`)
        } finally {
          await app.updateSettings({ appearance: { theme: 'light' } })
        }
      },
    },
    {
      r: 'R48',
      name: 'walks every step: models folder, login check, profile; Back works',
      async run(ctx) {
        const { app } = ctx
        const seen = (ctx.wizard = { steps: 0, modelsDir: undefined, login: false, profile: false, back: false })
        const first = await stepFields(app)
        for (let k = 0; k < MAX_STEPS; k++) {
          // The real account may be logged in; a logged-out status must surface a Log in action.
          await app.inject(LOGGED_OUT)
          await sleep(STEP_SETTLE_MS)
          const fields = await stepFields(app)
          ctx.log(`step ${k}: ${fields.join(' ') || '(no fields)'}`)
          if (fields.includes('set-appearance.modelsDir')) {
            // The folder is scanned when the step opens; give the detection a moment to fill the field.
            seen.modelsDir = await app
              .waitFor((sel) => document.querySelector(sel).value, { args: [W('set-appearance.modelsDir')], timeout: DETECT_MS })
              .catch(() => '')
          }
          if ((await app.visible(W('wizard-login'))) || (await byText(app, /log\s*in/i, '#screen-wizard'))) seen.login = true
          if (fields.includes('set-profile.displayName')) {
            await setField(app, 'profile.displayName', 'Natsuki Subaru')
            seen.profile = true
          }
          if (fields.includes('set-profile.callMe')) await setField(app, 'profile.callMe', 'Subaru')
          if (await app.visible(T('wizard-finish'))) break
          await app.click(T('wizard-next'))
          seen.steps++
          await sleep(STEP_SETTLE_MS)
          if (k === 0 && (await app.visible(T('wizard-back')))) {
            await app.click(T('wizard-back'))
            await sleep(STEP_SETTLE_MS)
            seen.back = JSON.stringify(await stepFields(app)) === JSON.stringify(first)
            await app.click(T('wizard-next'))
            await sleep(STEP_SETTLE_MS)
          }
        }
        assert(await app.visible(T('wizard-finish')), `no wizard-finish after ${seen.steps} steps`)
        assert(seen.back, 'wizard-back returns to the previous step')
      },
    },
    {
      r: 'R48',
      name: 'detects the models folder',
      async run({ app, wizard }) {
        const dir = wizard?.modelsDir ?? (await app.settings()).appearance.modelsDir
        assert(dir && dir.trim().length > 0, 'the models folder is pre-filled (detected)')
      },
    },
    {
      r: ['R48', 'R24'],
      name: 'a logged-out account shows a Log in action',
      async run({ app, wizard }) {
        let login = wizard?.login
        // Run on its own (`run.mjs R24`), the step walk above didn't happen: walk forward to the login check.
        for (let k = 0; !login && k < MAX_STEPS && !(await app.visible(T('wizard-finish'))); k++) {
          await app.inject(LOGGED_OUT)
          await sleep(STEP_SETTLE_MS)
          login = (await app.visible(W('wizard-login'))) || Boolean(await byText(app, /log\s*in/i, '#screen-wizard'))
          if (login) break
          await app.click(T('wizard-next'))
          await sleep(STEP_SETTLE_MS)
        }
        assert(login, 'some wizard step shows a "Log in" button when auth.loggedIn is false')
      },
    },
    {
      r: ['R48', 'R38'],
      name: 'Finish saves the profile, marks onboarded and opens the title',
      async run({ app, wizard }) {
        await app.click(T('wizard-finish'))
        await waitScreen(app, 'title')
        assert((await app.settings()).onboarded, 'store: onboarded')
        const deadline = Date.now() + PERSIST_MS
        let file
        while (Date.now() < deadline && !(file = app.readSettingsFile())?.onboarded) await sleep(PERSIST_POLL_MS)
        assert(file?.onboarded, 'settings.json in WC_DATA_DIR says onboarded')
        if (wizard?.profile) eq(file.profile.displayName, 'Natsuki Subaru', 'profile name from the wizard')
      },
    },
  ],
}
