// R48: first run with a models folder that doesn't exist. The wizard says so and asks for the folder.
import { join } from 'node:path'
import { assert, sleep, T, tempDir, waitScreen } from '../lib.mjs'

const MAX_STEPS = 10
const STEP_SETTLE_MS = 300
const DETECT_MS = 10_000
const W = (name) => `#screen-wizard ${T(name)}`

export default {
  name: 'First-run wizard without a models folder',
  // A function, so the folders are only made when this file runs. The configured folder doesn't exist, and an
  // empty home folder hides the places settings.ts looks in when it is missing (modelDirCandidates).
  launch: () => ({
    wizard: true,
    settings: { appearance: { modelsDir: join(tempDir('wc-e2e-gone-'), 'no-such-folder') } },
    env: { USERPROFILE: tempDir('wc-e2e-home-'), WAIFUFY_HOME: '' },
  }),
  tests: [
    {
      r: 'R48',
      name: 'a missing models folder is reported, and the wizard asks for one',
      async run({ app }) {
        await waitScreen(app, 'wizard')
        for (let k = 0; k < MAX_STEPS && !(await app.visible(W('set-appearance.modelsDir'))); k++) {
          assert(!(await app.visible(T('wizard-finish'))), 'the wizard reached Finish without a models folder step')
          await app.click(T('wizard-next'))
          await sleep(STEP_SETTLE_MS)
        }
        await app.waitVisible(W('set-appearance.modelsDir'))
        await app.waitFor(() => /no costume|not found/i.test(document.getElementById('screen-wizard').innerText), {
          timeout: DETECT_MS,
          label: 'the wizard says no costumes were found',
        })
        assert(await app.visible(W('set-appearance.modelsDir-browse')), 'a Browse… button asks for the folder')
        assert(!(await app.settings()).onboarded, 'not onboarded yet')
      },
    },
  ],
}
