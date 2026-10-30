// A 3D waifu card: her .pmx draws in place of the Live2D costume, takes emotions, talks, can be touched, and gives
// way to Live2D when the card goes back to it. The model isn't in the repo (MMD models carry their own licenses):
// set WC_E2E_MMD to a .pmx, or keep the lab's at ui-draft/mmd-lab/assets/reine/PavoliaReine.pmx.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ROOT } from '../driver.mjs'
import { assert, eq, fastText, newGame, readAll, say, setField, skip, T, turnEnd } from '../lib.mjs'

const PMX = process.env.WC_E2E_MMD || join(ROOT, 'ui-draft', 'mmd-lab', 'assets', 'reine', 'PavoliaReine.pmx')
/** Its own phone port, so this runs beside an installed app holding the usual one. */
const PHONE_PORT = '47932'
/** What a phone gets at most (link/src/assets.ts PHONE_TEXTURE_MAX). */
const PHONE_TEXTURE_MAX = 1024
/** A TGA's width and height, from its header. */
const tgaSize = (buf) => [buf.readUInt16LE(12), buf.readUInt16LE(14)]
const LOAD_MS = 90_000
const chara = (app, key) => app.eval((k) => document.getElementById('chara').dataset[k], key)

export default {
  name: 'A 3D (MMD) card',
  launch: () => ({ env: { WC_REMOTE_PORT: PHONE_PORT }, settings: { appearance: { model: 'mmd', mmdFile: existsSync(PMX) ? PMX : '' } } }),
  tests: [
    {
      name: 'her 3D model loads in place of the Live2D costume',
      timeout: LOAD_MS + 10_000,
      async run({ app }) {
        if (!existsSync(PMX)) skip(`no MMD model at ${PMX} (set WC_E2E_MMD)`)
        await app.waitFor(() => document.getElementById('chara').dataset.model === 'mmd', { timeout: LOAD_MS, label: '3D model' })
        eq(await app.eval(() => document.querySelectorAll('#chara canvas.chara-mmd').length), 1, 'one 3D canvas')
        const g = await app.eval(() => {
          const c = document.querySelector('#chara canvas.chara-mmd')
          return { w: c.width, h: c.height }
        })
        assert(g.w > 0 && g.h > 0, `the canvas has a size: ${JSON.stringify(g)}`)
      },
    },
    {
      name: 'she takes emotions in a chat, with no page errors',
      timeout: 90_000,
      async run({ app, project }) {
        if (!existsSync(PMX)) skip('no MMD model')
        await newGame(app, project)
        await fastText(app)
        eq(await chara(app, 'model'), 'mmd', 'still 3D in the chat')
        const m = await say(app, 'show me your emotions')
        await turnEnd(app, m)
        await readAll(app)
        const emotions = (await app.attrLog(m, 'data-emotion')).map((a) => a.value)
        assert(emotions.length > 0, 'emotions reach her')
        assert(!app.pageErrors().length, `no page errors: ${JSON.stringify(app.pageErrors())}`)
      },
    },
    {
      name: 'a phone gets her textures scaled down to what its WebView can hold',
      timeout: 60_000,
      async run({ app }) {
        if (!existsSync(PMX)) skip('no MMD model')
        const biggest = readdirSync(dirname(PMX))
          .filter((f) => f.toLowerCase().endsWith('.tga'))
          .sort((a, b) => statSync(join(dirname(PMX), b)).size - statSync(join(dirname(PMX), a)).size)[0]
        if (!biggest) skip('the model has no TGA textures')
        await app.go('settings')
        await app.waitVisible('[data-tab="phone"]')
        await app.click('[data-tab="phone"]')
        await app.waitVisible(T('phone-status'))
        await setField(app, 'phone.enabled', true)
        await app.waitFor(() => !document.querySelector('[data-phone-pair]').hidden, { label: 'phone access on' })
        const res = await fetch(`http://127.0.0.1:${PHONE_PORT}/mmd/${encodeURIComponent(biggest)}`)
        eq(res.status, 200, 'served')
        const [w, h] = tgaSize(Buffer.from(await res.arrayBuffer()))
        assert(Math.max(w, h) <= PHONE_TEXTURE_MAX && w > 0, `${biggest} reached the phone at ${w}×${h}`)
        await setField(app, 'phone.enabled', false)
      },
    },
    {
      name: 'switching the card to Live2D brings the costume back',
      timeout: 60_000,
      async run({ app }) {
        if (!existsSync(PMX)) skip('no MMD model')
        await app.eval(() => window.__wc.store.update((s) => void (s.appearance.model = 'live2d')))
        await app.waitFor(() => ['live2d', 'placeholder'].includes(document.getElementById('chara').dataset.model), { timeout: 30_000, label: 'back to Live2D' })
        eq(await app.eval(() => document.querySelectorAll('#chara canvas.chara-mmd').length), 0, 'the 3D canvas is gone')
      },
    },
  ],
}
