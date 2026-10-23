// R31–R36: Live2D life — costumes, idle variations, cursor tracking, headpats, taps, event gestures.
import { assert, eq, fastText, newGame, readAll, say, sleep, T, turnEnd } from '../lib.mjs'

const MODEL_LOAD_MS = 60_000
/** R31: a variation every 8–20 s, plus slack for the first one. */
const IDLE_WAIT_MS = 24_000
const PAT_STROKES = 6
const PAT_STROKE_MS = 160
const LONG_PAT_MS = 6000
const BUSY_PAT_MS = 3000
const TAP_GAP_MS = 350
const REACTION_SETTLE_MS = 1500
const PROBE_SETTLE_MS = 300
const PERSIST_MS = 1000
/** Lets her head turn toward a new cursor position. */
const TRACK_SETTLE_MS = 600
const BUSY_REACT_MS = 600
const GESTURE_MS = 15_000
/** character/director.ts DEDUPE_MS (2 s), plus slack: the same gesture again within it is ignored. */
const GESTURE_DEDUPE_MS = 2_300
const BUSY_MS = 10_000
/** The "slow" scenario runs past the chat's 20 s threshold for the success gesture. */
const SLOW_TURN_MS = 60_000
/** chat/index.ts SUCCESS_MIN_SECONDS: a turn at least this long ends with the success gesture. */
const SUCCESS_MIN_SECONDS = 20
const BUSY_SAMPLES = 5
const BUSY_SAMPLE_MS = 400
/** A slow reply, so idle variations have time to (wrongly) fire while she speaks. */
const SLOW_CPS = 14
/** Idle variation gesture names (motions.ts IDLE_HOLDS). */
const IDLE_GESTURE = /^idle/
/** Stroke width of a pat as a share of the head radius. */
const PAT_SWING = 0.6
/** The head radius used for probing, at least this many pixels or this share of the canvas width. */
const PROBE_RADIUS_PX = 24
const PROBE_RADIUS_SHARE = 0.04
const DEFAULT_HEAD_RADIUS = 60
/** Where her body is for a body tap, as a share of the canvas height, and below the head in head radii. */
const BODY_Y = 0.6
const BODY_BELOW_HEAD = 4
const FACE_BELOW_CENTER = 0.4
const FACE_TAPS = 4
/** Without #chara[data-head], cursor tracking is checked on a picture of where her head is, as shares of the canvas. */
const HEAD_BOX = { x: 0.3, y: 0.04, width: 0.4, height: 0.32 }
/** Turning her head must change that picture this many times more than her breathing and blinking do. */
const TRACKING_OVER_NOISE = 2
const CURSOR_EDGE_PX = 4
/** Where to probe for her head, as fractions of the canvas, when #chara has no data-head. */
const HEAD_X = [0.5, 0.35, 0.65, 0.25, 0.75, 0.42, 0.58]
const HEAD_Y = [0.14, 0.2, 0.27]

const gestureValues = async (app, from) => (await app.attrLog(from, 'data-gesture')).map((a) => a.value)

/** Strokes back and forth across `p` like a headpat. */
async function pat(app, p, ms = PAT_STROKES * PAT_STROKE_MS) {
  const strokes = Math.max(2, Math.round(ms / PAT_STROKE_MS))
  const path = Array.from({ length: strokes + 1 }, (_, k) => ({ x: p.x + (k % 2 ? p.r : -p.r) * PAT_SWING, y: p.y }))
  await app.mouse.drag(path, ms)
}

/**
 * Her head in client pixels. #chara[data-head="x,y,r"] in stage pixels gives it exactly; without it the
 * canvas is probed with short pats until data-gesture reacts.
 */
async function findHead(ctx) {
  const { app } = ctx
  if (ctx.head) return ctx.head
  const g = await app.eval((fallback) => {
    const chara = document.getElementById('chara')
    const stage = document.getElementById('stage')
    const scale = Number(stage.dataset.scale) || 1
    const sr = stage.getBoundingClientRect()
    const head = chara.dataset.head?.split(',').map(Number)
    if (head && head.length >= 2 && head.every(Number.isFinite)) {
      return { x: sr.left + head[0] * scale, y: sr.top + head[1] * scale, r: (head[2] ?? fallback) * scale, exact: true }
    }
    const r = (chara.querySelector('canvas') ?? chara).getBoundingClientRect()
    return { box: { left: r.left, top: r.top, width: r.width, height: r.height } }
  }, DEFAULT_HEAD_RADIUS)
  if (g.exact) return (ctx.head = g)
  const r = Math.max(PROBE_RADIUS_PX, g.box.width * PROBE_RADIUS_SHARE)
  for (const fy of HEAD_Y) {
    for (const fx of HEAD_X) {
      const p = { x: g.box.left + g.box.width * fx, y: g.box.top + g.box.height * fy, r }
      const m = await app.mark()
      await pat(app, p)
      await sleep(PROBE_SETTLE_MS)
      const values = await gestureValues(app, m)
      if (values.length) {
        ctx.log(`head found by probing at ${Math.round(p.x)},${Math.round(p.y)} (gesture ${values.at(-1)}); set #chara[data-head] to make this exact`)
        await sleep(REACTION_SETTLE_MS)
        return (ctx.head = { ...p, body: { x: p.x, y: g.box.top + g.box.height * BODY_Y } })
      }
    }
  }
  throw new Error('no point on the canvas reacted to a headpat; is the character interactive (#chara canvas pointer-events: auto)?')
}

/** Where her head is drawn, in client pixels: #chara[data-head] when set, else HEAD_BOX of the canvas. */
function headClip(app) {
  return app.eval((box) => {
    const chara = document.getElementById('chara')
    const head = chara.dataset.head?.split(',').map(Number)
    const stage = document.getElementById('stage')
    if (head && head.length >= 3 && head.every(Number.isFinite)) {
      const scale = Number(stage.dataset.scale) || 1
      const sr = stage.getBoundingClientRect()
      const r = head[2] * scale
      return { x: sr.left + head[0] * scale - r, y: sr.top + head[1] * scale - r, width: 2 * r, height: 2 * r }
    }
    const c = (chara.querySelector('canvas') ?? chara).getBoundingClientRect()
    return { x: c.left + c.width * box.x, y: c.top + c.height * box.y, width: c.width * box.width, height: c.height * box.height }
  }, HEAD_BOX)
}

/** Mean difference of two same-size PNGs (base64), 0 (same) to 1, computed in the page. */
function pixelDiff(app, a, b) {
  return app.eval(
    async (x, y) => {
      const load = (d) =>
        new Promise((resolve, reject) => {
          const img = new Image()
          img.onload = () => resolve(img)
          img.onerror = reject
          img.src = `data:image/png;base64,${d}`
        })
      const [ia, ib] = await Promise.all([load(x), load(y)])
      const c = document.createElement('canvas')
      c.width = ia.width
      c.height = ia.height
      const g = c.getContext('2d', { willReadFrequently: true })
      const pixels = (img) => (g.clearRect(0, 0, c.width, c.height), g.drawImage(img, 0, 0), g.getImageData(0, 0, c.width, c.height).data)
      const pa = pixels(ia)
      const pb = pixels(ib)
      let sum = 0
      for (let k = 0; k < pa.length; k += 4) sum += Math.abs(pa[k] - pb[k]) + Math.abs(pa[k + 1] - pb[k + 1]) + Math.abs(pa[k + 2] - pb[k + 2])
      return sum / (pa.length / 4) / (3 * 255)
    },
    a,
    b,
  )
}

/** Gestures whose timestamp falls inside a stretch of data-talking=1. */
function duringSpeech(attrs, gestures) {
  const spans = []
  let since
  for (const a of attrs) {
    if (a.name !== 'data-talking') continue
    if (a.value === '1' && since === undefined) since = a.at
    if (a.value === '0' && since !== undefined) spans.push([since, a.at]), (since = undefined)
  }
  if (since !== undefined) spans.push([since, Infinity])
  return gestures.filter((g) => spans.some(([a, b]) => g.at > a && g.at < b))
}

export default {
  name: 'Character: costumes, idle, tracking, headpats, taps, gestures',
  async setup({ app, project }) {
    await newGame(app, project)
    await fastText(app)
    await app.updateSettings({ motion: { idle: true, cursor: true, headpats: true, taps: true, gestures: true } })
  },
  tests: [
    {
      r: ['R36', 'R37'],
      name: 'a real Live2D model loads from the models folder',
      async run({ app }) {
        const model = await app.waitFor(() => document.getElementById('chara').dataset.model, { timeout: MODEL_LOAD_MS, label: '#chara[data-model]' })
        eq(model, 'live2d', `data-model (models folder: ${(await app.settings()).appearance.modelsDir})`)
        assert(await app.chara('data-costume'), 'data-costume is set')
      },
    },
    {
      r: 'R36',
      name: '👗 opens the costume picker; switching swaps the model live, keeps the emotion, and is remembered',
      timeout: 120_000,
      async run({ app }) {
        const current = await app.chara('data-costume')
        await app.eval(() => window.__wc.character.emote('smile'))
        await app.waitFor(() => document.getElementById('chara').dataset.emotion === 'smile', { label: 'emotion smile' })
        await app.click(T('qm-costume'))
        await app.waitVisible(T('costume-picker'))
        const ids = await app.attrs(T('costume-item'), 'data-id')
        assert(ids.length >= 2, `several Rem costumes found (${ids.length})`)
        const target = ids.find((id) => id !== current)
        await app.click(T('costume-item', { id: target }))
        await app.waitFor((id) => document.getElementById('chara').dataset.costume === id, {
          args: [target],
          timeout: MODEL_LOAD_MS,
          label: `costume ${target}`,
        })
        eq(await app.chara('data-model'), 'live2d', 'still a Live2D model')
        eq(await app.chara('data-emotion'), 'smile', 'the emotion survives the swap')
        eq((await app.settings()).appearance.costume, target, 'the choice is stored')
        await sleep(PERSIST_MS)
        eq(app.readSettingsFile()?.appearance.costume, target, 'and persisted')
        if (await app.visible(T('costume-picker'))) await app.key('Escape')
      },
    },
    {
      r: 'R31',
      name: 'idle life: a variation plays within 8–20 s while she is quiet',
      timeout: 60_000,
      async run({ app }) {
        await readAll(app)
        const m = await app.mark()
        await app.waitFor(
          (f, src) => window.__e2e.attrs.slice(f).some((a) => a.name === 'data-gesture' && new RegExp(src).test(a.value ?? '')),
          { args: [m.attrs, IDLE_GESTURE.source], timeout: IDLE_WAIT_MS, label: 'an idle variation (data-gesture idle-normal02, -normal03 or -smile)' },
        )
        const talk = await app.attrLog(m, 'data-talking')
        assert(!talk.some((a) => a.value === '1'), 'she was not speaking')
      },
    },
    {
      r: 'R31',
      name: 'idle variations never play while she speaks',
      timeout: 120_000,
      async run({ app }) {
        await app.updateSettings({ motion: { textCps: SLOW_CPS, autoDelayMs: 0 } })
        try {
          const m = await say(app, 'show me your emotions')
          await turnEnd(app, m)
          await readAll(app, { timeout: 90_000 })
          const attrs = await app.attrLog(m)
          const idle = attrs.filter((a) => a.name === 'data-gesture' && IDLE_GESTURE.test(a.value ?? ''))
          const bad = duringSpeech(attrs, idle)
          assert(!bad.length, `idle variations while data-talking=1: ${bad.map((g) => g.value)}`)
        } finally {
          await fastText(app)
        }
      },
    },
    {
      r: 'R32',
      name: 'cursor tracking follows the pointer anywhere in the window',
      async run({ app }) {
        const size = await app.eval(() => ({ w: innerWidth, h: innerHeight }))
        const at = async (x) => (await app.mouse.move(x, size.h / 2), await sleep(TRACK_SETTLE_MS))
        await at(CURSOR_EDGE_PX)
        const left = await app.chara('data-focus')
        if (left !== null) {
          await at(size.w - CURSOR_EDGE_PX)
          const right = await app.chara('data-focus')
          const lx = Number(left.split(',')[0])
          const rx = Number(right.split(',')[0])
          assert(lx < rx && lx < 0 && rx > 0, `focus x follows the cursor: left ${left}, right ${right}`)
          return
        }
        // No data-focus: compare pictures of her head. Two at the same spot measure breathing and blinking.
        const clip = await headClip(app)
        const left1 = await app.capture(clip)
        await sleep(TRACK_SETTLE_MS)
        const left2 = await app.capture(clip)
        await at(size.w - CURSOR_EDGE_PX)
        const right = await app.capture(clip)
        await at(CURSOR_EDGE_PX)
        const left3 = await app.capture(clip)
        const noise = Math.max(await pixelDiff(app, left1, left2), await pixelDiff(app, left2, left3))
        const moved = await pixelDiff(app, left2, right)
        assert(moved > TRACKING_OVER_NOISE * noise, `her head turns with the cursor: change ${moved.toFixed(4)} vs idle noise ${noise.toFixed(4)}`)
      },
    },
    {
      r: 'R33',
      name: 'headpats react and escalate the longer you pat',
      timeout: 120_000,
      async run(ctx) {
        const { app } = ctx
        const head = await findHead(ctx)
        await sleep(REACTION_SETTLE_MS)
        const m = await app.mark()
        await pat(app, head, LONG_PAT_MS)
        await sleep(REACTION_SETTLE_MS)
        const values = [...new Set(await gestureValues(app, m))]
        assert(values.length >= 2, `pat tiers escalate (gestures: ${values})`)
        ctx.patGestures = values
      },
    },
    {
      r: 'R33',
      name: 'while she works, a headpat gets a scolding instead',
      timeout: 60_000,
      async run(ctx) {
        const { app } = ctx
        const head = await findHead(ctx)
        const m = await say(app, 'use some tools please')
        await app.waitFor(() => document.getElementById('chara').dataset.busy === '1', { timeout: BUSY_MS, label: 'data-busy=1' })
        await app.waitEvent('tool', {}, m)
        // A reaction already playing (her line's gesture) holds the pat back, so keep stroking past it.
        const p = await app.mark()
        await pat(app, head, BUSY_PAT_MS)
        await sleep(BUSY_REACT_MS)
        const busy = await gestureValues(app, p)
        assert(busy.length > 0, 'a reaction while busy')
        assert(busy.some((v) => !ctx.patGestures?.includes(v)), `the busy reaction (${busy}) differs from normal pats (${ctx.patGestures})`)
        await turnEnd(app, m)
        await app.waitFor(() => document.getElementById('chara').dataset.busy === '0', { label: 'data-busy=0 after the turn' })
        await readAll(app)
      },
    },
    {
      r: 'R34',
      name: 'taps: the face gets surprised then pouts as taps repeat; the body gets shy',
      timeout: 60_000,
      async run(ctx) {
        const { app } = ctx
        const head = await findHead(ctx)
        await sleep(REACTION_SETTLE_MS)
        const face = { x: head.x, y: head.y + head.r * FACE_BELOW_CENTER }
        const m = await app.mark()
        for (let k = 0; k < FACE_TAPS; k++) {
          await app.clickAt(face.x, face.y)
          await sleep(TAP_GAP_MS)
        }
        const faceValues = [...new Set(await gestureValues(app, m))]
        assert(faceValues.length >= 2, `repeated face taps escalate (${faceValues})`)
        await sleep(REACTION_SETTLE_MS)
        const body = head.body ?? { x: head.x, y: head.y + head.r * BODY_BELOW_HEAD }
        const b = await app.mark()
        await app.clickAt(body.x, body.y)
        await sleep(TAP_GAP_MS * 2)
        const bodyValues = await gestureValues(app, b)
        assert(bodyValues.length > 0, 'a body tap reacts')
        assert(bodyValues.at(-1) !== faceValues[0], `the body reaction (${bodyValues.at(-1)}) differs from the face one`)
      },
    },
    {
      r: 'R35',
      name: 'event gestures: permission, danger, git push, errors, interrupt; a busy pose while working',
      timeout: 120_000,
      async run({ app, project }) {
        await newGame(app, project)
        await fastText(app)
        // Gesture names are contracts.ts `Gesture`; data-gesture may carry a prefix or suffix around them.
        const expectGesture = async (name, from) =>
          app.waitFor((n, f) => window.__e2e.attrs.slice(f).some((a) => a.name === 'data-gesture' && (a.value ?? '').includes(n)), {
            args: [name, from.attrs],
            timeout: GESTURE_MS,
            label: `data-gesture ${name}`,
          })

        let m = await say(app, 'ask permission to edit')
        await app.waitEvent('ask_permission', {}, m, 20_000)
        await expectGesture('confirm', m)
        await app.click(T('ask-option', { v: 'allow' }))
        await turnEnd(app, m)

        m = await say(app, 'do something dangerous')
        await app.waitEvent('ask_permission', {}, m, 20_000)
        await expectGesture('danger', m)
        await app.click(T('ask-option', { v: 'deny' }))
        await turnEnd(app, m)

        m = await say(app, 'push it to main')
        await turnEnd(app, m)
        await expectGesture('push', m)

        m = await say(app, 'show me an api error')
        await turnEnd(app, m)
        await expectGesture('fail', m)

        // Not logged in is an error too (R35 "errors (sad)"), even though its line offers Log in. The director
        // ignores a repeat of the same gesture within DEDUPE_MS, so the second error comes after that window.
        await sleep(GESTURE_DEDUPE_MS)
        m = await say(app, 'trigger an error')
        await turnEnd(app, m)
        await expectGesture('fail', m)

        m = await say(app, 'use some tools please')
        await app.waitFor(() => document.getElementById('chara').dataset.busy === '1', { timeout: BUSY_MS, label: 'busy pose while working' })
        await app.waitEvent('tool', {}, m)
        await app.key('Escape')
        await app.waitEvent('turn_end', { interrupted: true }, m)
        await expectGesture('interrupt', m)
      },
    },
    {
      r: 'R35',
      name: 'a long turn: she holds a working pose between lines and plays success at the end',
      timeout: 90_000,
      async run({ app, project }) {
        await newGame(app, project)
        await fastText(app)
        const m = await say(app, 'do the slow rebuild')
        // Between her lines a tool runs; she must still be in her working pose then.
        const tool = await app.waitEvent('tool', { name: 'Bash' }, m, BUSY_MS)
        const busy = []
        for (let k = 0; k < BUSY_SAMPLES; k++) {
          busy.push(await app.chara('data-busy'))
          await sleep(BUSY_SAMPLE_MS)
        }
        assert(!(await app.events(m, 'tool_done')).some((d) => d.id === tool.id), 'the samples were taken while the tool ran')
        assert(busy.every((b) => b === '1'), `data-busy stays 1 between lines (${busy})`)
        const end = await turnEnd(app, m, SLOW_TURN_MS)
        assert(end.ok && end.seconds >= SUCCESS_MIN_SECONDS, `the turn was long (${end.seconds?.toFixed(1)} s)`)
        await app.waitFor((f) => window.__e2e.attrs.slice(f).some((a) => a.name === 'data-gesture' && (a.value ?? '').includes('success')), {
          args: [m.attrs],
          timeout: GESTURE_MS,
          label: 'data-gesture success after a long turn',
        })
        await readAll(app)
      },
    },
  ],
}
