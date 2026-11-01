// A 3D waifu card: her .pmx draws in place of the Live2D costume, takes emotions, talks, can be touched, and gives
// way to Live2D when the card goes back to it. The model isn't in the repo (MMD models carry their own licenses):
// set WC_E2E_MMD to a .pmx, or keep the lab's at ui-draft/mmd-lab/assets/reine/PavoliaReine.pmx.
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
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
const text = (app, sel) => app.eval((s) => document.querySelector(s)?.textContent ?? '', sel)
/**
 * The left end of a joint's turn ring (Babylon draws it green) on her canvas, in page pixels: the leftmost green pixel
 * on the rows through the joint's dot.
 */
const ringEnd = (app, joint) => app.eval((j) => {
  const c = document.querySelector('#chara canvas.chara-mmd')
  const dot = document.querySelector(`[data-test="studio-dot-${j}"]`).getBoundingClientRect()
  const r = c.getBoundingClientRect()
  const copy = document.createElement('canvas')
  copy.width = c.width
  copy.height = c.height
  const g = copy.getContext('2d')
  g.drawImage(c, 0, 0)
  const sx = c.width / r.width, sy = c.height / r.height
  const cy = Math.round((dot.top + dot.height / 2 - r.top) * sy)
  const px = g.getImageData(0, 0, c.width, c.height).data
  for (let y = cy - 4; y <= cy + 4; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4
      if (px[i + 1] > 100 && px[i] < 90 && px[i + 2] < 90) return { x: r.left + x / sx, y: r.top + y / sy }
    }
  }
  return null
}, joint)
/** Sets a field's value as the user would, with its input and change events. */
const fire = (app, sel, value) => app.eval(([s, v]) => {
  const el = document.querySelector(s)
  el.value = v
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}, [sel, value])

/** A stand-in for Blender (link/src/blender.ts runs a .mjs with node): it "saves" her head turned 45 degrees to her left. */
function fakeBlender() {
  const file = join(mkdtempSync(join(tmpdir(), 'wc-e2e-blender-')), 'blender.mjs')
  const motionVmd = pathToFileURL(join(ROOT, 'app', 'src', 'character', 'motion-vmd.ts')).href
  writeFileSync(file, [
    "import { writeFileSync } from 'node:fs'",
    `const { motionToVmd } = await import(${JSON.stringify(motionVmd)})`,
    "const a = process.argv.slice(process.argv.indexOf('--') + 1)",
    "setTimeout(() => writeFileSync(a[a.indexOf('--out') + 1], motionToVmd({ pose: { 頭: [0, 45, 0] }, keys: [] }, 'x')), 500)",
    'setTimeout(() => process.exit(0), 1500)',
  ].join('\n'))
  return file
}

export default {
  name: 'A 3D (MMD) card',
  launch: () => ({ env: { WC_REMOTE_PORT: PHONE_PORT, WC_BLENDER: fakeBlender() }, settings: { appearance: { model: 'mmd', mmdFile: existsSync(PMX) ? PMX : '' } } }),
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
      name: 'the pose studio: a hand dragged reaches where it is put; rings, knobs, undo, hand shapes and keys save on her card',
      timeout: 90_000,
      async run({ app }) {
        if (!existsSync(PMX)) skip('no MMD model')
        await app.go('settings')
        await app.waitVisible('[data-tab="appearance"]')
        await app.click('[data-tab="appearance"]')
        await app.waitVisible(T('mo-studio'))
        await fire(app, T('mo-emotion'), 'happy')
        eq(await text(app, T('mo-state')), 'Built-in', 'built-in before')
        await app.click(T('mo-studio'))
        await app.waitVisible(T('studio'))
        await app.waitVisible(T('studio-dot-左手首'))
        await new Promise((r) => setTimeout(r, 800))
        const motion = () => app.eval(() => window.__wc.store.get().appearance.motions.happy)

        // Her left hand (screen right) raised out to her side: the dot ends up under the pointer.
        const from = await app.center(T('studio-dot-左手首'))
        const to = { x: from.x + 40, y: from.y - 160 }
        await app.mouse.drag([from, { x: from.x + 20, y: from.y - 80 }, to], 700)
        await new Promise((r) => setTimeout(r, 500))
        const at = await app.center(T('studio-dot-左手首'))
        assert(Math.hypot(at.x - to.x, at.y - to.y) < 30, `her hand is where it was put: ${JSON.stringify(at)} vs ${JSON.stringify(to)}`)
        const m1 = await motion()
        assert(m1?.pose['左腕'] && m1.pose['左ひじ'], `the arm's joints are saved: ${JSON.stringify(m1?.pose)}`)
        await app.screenshot('pose-studio-hand')

        // A click on her head's dot picks it, with rings; its turn knob turns it exactly.
        await app.click(T('studio-dot-頭'))
        await app.waitFor(() => document.querySelector('[data-test="studio-dot-頭"]').classList.contains('on'), { label: 'head picked' })
        eq(await app.eval(() => document.querySelector('[data-test="st-joint"]').value), '頭', 'the panel shows the head')
        await new Promise((r) => setTimeout(r, 400))
        await app.screenshot('pose-studio-rings')
        // Her head's turn ring (green), grabbed at its left end and dragged down along it.
        const ring = await ringEnd(app, '頭')
        assert(ring, 'the turn ring is drawn on her')
        await app.mouse.drag([ring, { x: ring.x, y: ring.y + 20 }, { x: ring.x + 5, y: ring.y + 45 }], 600)
        await new Promise((r) => setTimeout(r, 300))
        const ringed = (await motion()).pose['頭']
        assert(Math.abs(ringed?.[1] ?? 0) > 10, `the ring turned her head: ${JSON.stringify(ringed)}`)
        await app.eval(() => document.querySelector('[data-test="st-knob-turn"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
        await fire(app, T('st-knob-turn'), '40')
        eq((await motion()).pose['頭'][1], 40, 'the head turned by its knob')
        await app.click(T('st-undo'))
        eq((await motion()).pose['頭'], ringed, 'undone')
        await app.click(T('st-redo'))
        eq((await motion()).pose['頭'][1], 40, 'redone')
        assert(await app.eval(() => !document.querySelector('[data-test="st-saved"]').hidden), 'the panel says it was saved')

        // A finger segment picked from the hand grid, the camera turned round to her back.
        await app.click(T('st-finger-右人指２'))
        eq(await app.eval(() => document.querySelector('[data-test="st-joint"]').value), '右人指２', 'the grid picks a finger segment')
        await app.click(T('st-cam-back'))
        await new Promise((r) => setTimeout(r, 300))
        await app.screenshot('pose-studio-back')
        await app.click(T('st-cam-front'))

        await app.click(T('st-hand-right-fist'))
        assert((await motion()).pose['右中指２']?.[2] < -45, 'her right hand makes a fist')
        await app.click(T('st-add-key'))
        eq((await motion()).keys.length, 1, 'a key on the way in')
        await app.click(T('st-play'))
        await new Promise((r) => setTimeout(r, 1500))
        await app.screenshot('pose-studio-played')

        // Esc puts the rings away, then leaves; her own motion shows in Settings.
        await app.click(T('studio-dot-頭'))
        await app.key('Escape')
        await app.waitFor(() => !document.querySelector('[data-test="studio-dot-頭"]').classList.contains('on'), { label: 'rings away' })
        await app.key('Escape')
        await app.waitVisible(T('mo-studio'))
        eq(await text(app, T('mo-state')), 'Her own', 'her own after')
        await app.click(T('mo-studio'))
        await app.waitVisible(T('studio'))
        await app.click(T('st-reset'))
        eq(await motion(), undefined, 'back to built-in')
        await app.click(T('st-done'))
        assert(!app.pageErrors().length, `no page errors: ${JSON.stringify(app.pageErrors())}`)
      },
    },
    {
      name: 'Open in Blender: a save there comes back as her motion (a stand-in for Blender)',
      timeout: 60_000,
      async run({ app }) {
        if (!existsSync(PMX)) skip('no MMD model')
        await app.go('studio', { emotion: 'sad' })
        await app.waitVisible(T('st-blender'))
        await app.click(T('st-blender'))
        // The stand-in "saves" her head turned 45 degrees to her left.
        await app.waitFor(() => window.__wc.store.get().appearance.motions.sad?.pose['頭']?.[1] === 45, { timeout: 20_000, label: 'the motion from Blender' })
        await app.eval(() => {
          const s = document.querySelector('[data-test="st-joint"]')
          s.value = '頭'
          s.dispatchEvent(new Event('change', { bubbles: true }))
        })
        eq(await app.eval(() => document.querySelector('[data-test="st-knob-turn"]').value), '45', 'the studio shows it')
        await app.click(T('st-reset'))
        await app.click(T('st-done'))
        assert(!app.pageErrors().length, `no page errors: ${JSON.stringify(app.pageErrors())}`)
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
