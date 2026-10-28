// Records the promotional videos (PVs) from the real app on the mock session: no Claude, no real data. A scripted
// ~35 s run (a work turn with tools → the casual switch refused mid-task → casual mode → her memory → a headpat →
// an end card) is
// captured with Chrome's screencast and encoded with ffmpeg. Captions and the end card are drawn in the page, in the
// app's own fonts. There is no music: add a sound where the video is posted.
//
//   node scripts/pv/record.mjs mobile     1080×1920 portrait (TikTok, Reels, Shorts) → build/pv/Waifufy-Code-PV-mobile.mp4
//   node scripts/pv/record.mjs desktop    1920×1080 landscape (README, X, YouTube)   → build/pv/Waifufy-Code-PV.mp4
//
// Needs Chrome or Edge and ffmpeg on PATH (or WC_FFMPEG). Uses the e2e driver (tests/e2e/driver.mjs).

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FORMATS = {
  // CSS pixels × device scale = the video size. Mobile is the portrait layout, desktop the 1600×900 stage.
  mobile: { viewport: '540x960@2', size: [1080, 1920], theme: 'light', file: 'Waifufy-Code-PV-mobile.mp4' },
  desktop: { viewport: '1600x900@1.2', size: [1920, 1080], theme: 'dark', file: 'Waifufy-Code-PV.mp4' },
}
const format = process.argv[2] ?? 'mobile'
const F = FORMATS[format]
if (!F) throw new Error(`unknown format "${format}"; use ${Object.keys(FORMATS).join(' or ')}`)

// Read by the driver as it launches: a headless Chrome at exactly the video size.
process.env.WC_E2E_TARGET = 'browser'
process.env.WC_E2E_VIEWPORT = F.viewport
const { launch, stopVite } = await import('../../tests/e2e/driver.mjs')
const { makeProject, readAll, removeTempDirs, sleep, T, turnEnd, waitScreen } = await import('../../tests/e2e/lib.mjs')

const ROOT = new URL('../..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')
const OUT = join(ROOT, 'build', 'pv')
const FRAMES = join(OUT, `frames-${format}`)
const FPS = 30
const FFMPEG = process.env.WC_FFMPEG || 'ffmpeg'
/** Typing pace for her user's lines, ms a key. */
const KEY_MS = 28
const HEADPAT_MS = 2200
const PAT_SWING = 0.6

let app
const frames = []

// ---------------------------------------------------------------- capture

async function startCapture() {
  rmSync(FRAMES, { recursive: true, force: true })
  mkdirSync(FRAMES, { recursive: true })
  app.cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = join(FRAMES, `${String(frames.length).padStart(5, '0')}.jpg`)
    writeFileSync(file, Buffer.from(data, 'base64'))
    frames.push({ file, t: metadata.timestamp })
    void app.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
  })
  await app.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: F.size[0], maxHeight: F.size[1], everyNthFrame: 1 })
}

async function stopCapture() {
  await app.cdp.send('Page.stopScreencast')
}

/** Each frame held until the next one came, as ffmpeg's concat list; then a constant-rate H.264 at the video size. */
function encode() {
  const list = frames.map((f, i) => {
    const next = frames[i + 1]?.t ?? f.t + 1 / FPS
    return `file '${f.file.replaceAll('\\', '/')}'\nduration ${Math.max(0.001, next - f.t).toFixed(4)}`
  })
  // concat repeats the last file's duration only if it is listed again.
  list.push(`file '${frames.at(-1).file.replaceAll('\\', '/')}'`)
  const listFile = join(FRAMES, 'list.txt')
  writeFileSync(listFile, list.join('\n'))
  const [w, h] = F.size
  const out = join(OUT, F.file)
  execFileSync(FFMPEG, [
    '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x05070f,fps=${FPS},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-movflags', '+faststart', out,
  ], { stdio: 'inherit' })
  return out
}

// ---------------------------------------------------------------- captions and the end card

const CAPTION_CSS = `
/* Over her dress, never her face; on a phone also clear of TikTok's top tabs and bottom caption. */
#pv-cap { position: fixed; left: 50%; top: ${format === 'mobile' ? '54%' : '50%'}; transform: translate(-50%, -12px); z-index: 2147483000;
  width: max-content; max-width: 88vw; padding: .45em 1em .5em; border-radius: .7em; text-align: center; pointer-events: none;
  font: 800 ${format === 'mobile' ? '30px' : '38px'}/1.25 'Zen Maru Gothic', sans-serif; letter-spacing: .02em; color: #fff;
  background: linear-gradient(135deg, rgba(91,141,224,.92), rgba(176,110,220,.92)); box-shadow: 0 10px 34px rgba(20,10,60,.38);
  opacity: 0; transition: opacity .35s, transform .35s; }
#pv-cap.on { opacity: 1; transform: translate(-50%, 0); }
#pv-cap small { display: block; font-size: .55em; font-weight: 500; opacity: .9; margin-top: .2em; }
#pv-end { position: fixed; inset: 0; z-index: 2147483001; display: grid; place-items: center; text-align: center; color: #fff;
  background: radial-gradient(circle at 50% 40%, rgba(91,141,224,.55), rgba(8,8,28,.92) 70%); backdrop-filter: blur(6px);
  opacity: 0; transition: opacity .6s; font-family: 'Zen Maru Gothic', sans-serif; }
#pv-end.on { opacity: 1; }
#pv-end h1 { margin: 0; font: 800 ${format === 'mobile' ? '62px' : '92px'}/1 'Shippori Mincho', serif; letter-spacing: .08em; }
#pv-end h1 span { color: #9ec0ff; }
#pv-end p { margin: .6em 0 0; font-size: ${format === 'mobile' ? '24px' : '30px'}; opacity: .92; }
#pv-end code { display: inline-block; margin-top: 1.2em; padding: .4em .9em; border-radius: .6em; background: rgba(255,255,255,.14);
  font: 600 ${format === 'mobile' ? '20px' : '24px'} 'JetBrains Mono', monospace; }`

async function caption(text, sub = '') {
  await app.eval((css, t, s) => {
    if (!document.getElementById('pv-style')) {
      const st = document.createElement('style')
      st.id = 'pv-style'
      st.textContent = css
      document.head.append(st)
      const el = document.createElement('div')
      el.id = 'pv-cap'
      document.body.append(el)
    }
    const el = document.getElementById('pv-cap')
    el.classList.remove('on')
    setTimeout(() => {
      el.innerHTML = ''
      el.append(t)
      if (s) {
        const small = document.createElement('small')
        small.textContent = s
        el.append(small)
      }
      el.classList.add('on')
    }, t ? 180 : 0)
  }, CAPTION_CSS, text, sub)
  await sleep(250)
}

async function endCard() {
  await caption('')
  await app.eval(() => {
    const el = document.createElement('div')
    el.id = 'pv-end'
    el.innerHTML = `<div><h1>Waifufy <span>Code</span></h1><p>Claude Code, as a visual novel.</p><p>v0.7 · now with casual mode</p><p>Free · open source · Windows &amp; Android</p>
      <code>github.com/yodhasu/waifufy-code</code></div>`
    document.body.append(el)
    requestAnimationFrame(() => el.classList.add('on'))
  })
}

// ---------------------------------------------------------------- acting

/** The chat is up: the composer, or (upright on a phone) the Reply button it waits behind. */
const chatReady = () =>
  app.waitFor(() => window.__e2e.visible('[data-test="chat-input"]') || window.__e2e.visible('[data-test="qm-reply"]'), { label: 'the chat', timeout: 20_000 })

/** Clicks the Work / Casual switch (on a phone, after opening the composer behind Reply). */
async function pressSwitch() {
  if (await app.visible(T('qm-reply'))) await app.click(T('qm-reply'))
  await app.waitVisible(T('chat-mode'))
  await sleep(250)
  await app.click(T('chat-mode'))
}

/** Types a line into the composer key by key, as on camera, and sends it. */
async function sayOnCamera(text) {
  // Upright (the mobile cut) the composer waits behind Reply.
  if (await app.visible(T('qm-reply'))) await app.click(T('qm-reply'))
  await app.waitFor(() => !document.querySelector('[data-test="chat-input"]')?.disabled, { label: 'input enabled' })
  await app.click(T('chat-input'))
  for (const ch of text) {
    await app.key(ch)
    await sleep(KEY_MS)
  }
  await sleep(300)
  const m = await app.mark()
  await app.key('Enter')
  return m
}

/** Finds her head by short pats until she reacts (as tests/e2e/scenarios/07-character.mjs does), in client px. */
async function findHead() {
  const box = await app.eval(() => {
    const r = (document.querySelector('#chara canvas') ?? document.getElementById('chara')).getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  })
  const r = Math.max(14, box.width * 0.05)
  for (const fy of [0.14, 0.2, 0.27, 0.34, 0.08, 0.42, 0.5]) {
    for (const fx of [0.5, 0.42, 0.58, 0.34, 0.66]) {
      const p = { x: box.left + box.width * fx, y: box.top + box.height * fy, r }
      const m = await app.mark()
      await pat(p, 500)
      await sleep(500)
      if ((await app.attrLog(m, 'data-gesture')).length) return p
    }
  }
  throw new Error('could not find her head for the headpat')
}

async function pat(p, ms) {
  const strokes = Math.max(2, Math.round(ms / 160))
  const path = Array.from({ length: strokes + 1 }, (_, k) => ({ x: p.x + (k % 2 ? p.r : -p.r) * PAT_SWING * 3, y: p.y }))
  await app.mouse.drag(path, ms)
}

// ---------------------------------------------------------------- the script

try {
  mkdirSync(OUT, { recursive: true })
  app = await launch({ target: 'browser', tag: `pv-${format}` })
  const look = { appearance: { theme: F.theme, petals: true }, motion: { textCps: 60, autoDelayMs: 700, idle: true, cursor: true, headpats: true, gestures: true } }
  await app.updateSettings(look)
  // The mock session reports no Claude login; a PV shows a logged-in app.
  await app.inject({ t: 'auth', auth: { loggedIn: true, email: 'you@example.com', subscription: 'max' } })
  // Off camera: a Slack sign-in on the mock workspace, and where her head is in the chat.
  await app.eval(() => window.__wc.link.send({ t: 'slack_signin', clientId: 'pv' }))
  const project = makeProject('booking-agent')
  await app.go('chat', { cwd: project })
  await waitScreen(app, 'chat')
  await chatReady()
  await sleep(1500)
  const head = await findHead()
  await app.go('title')
  await waitScreen(app, 'title')
  await app.inject({ t: 'auth', auth: { loggedIn: true, email: 'you@example.com', subscription: 'max' } })
  // Starting the off-camera session made the link broadcast its saved settings, which can predate the change above.
  await app.updateSettings(look)
  await sleep(1500)

  await startCapture()
  await caption('Waifufy Code 0.7', 'work mode · casual mode')
  await sleep(2200)

  // Work mode: a real turn, tools, her face changing as she works.
  await app.go('chat', { cwd: project })
  await waitScreen(app, 'chat')
  await chatReady()
  await caption('Work mode: the real Claude Code', 'tools · quests · subagents · MCP')
  let m = await sayOnCamera('fix the failing tests with your tools')
  await sleep(1800)

  // Mid-task the switch is refused, in character. (Upright on a phone, Reply is STOP while she works: no switch to press.)
  if (format === 'desktop') {
    await caption('No slacking off mid-task')
    await pressSwitch()
    await app.waitEvent('aside', {}, m, 10_000)
  }
  await turnEnd(app, m, 60_000)
  await readAll(app, { settleMs: 700 })

  // Work done: casual mode, her own chat harness on the same history.
  await caption('Work done? Casual mode', 'her own chat harness · GPT or Claude')
  m = await app.mark()
  await pressSwitch()
  await app.waitEvent('chat_mode', { mode: 'casual' }, m, 10_000)
  await readAll(app, { settleMs: 500 })
  m = await sayOnCamera('finally done for today. long day')
  await turnEnd(app, m, 30_000)
  await readAll(app, { settleMs: 600 })

  await caption('She remembers', 'long-term memory, looked up for free')
  m = await sayOnCamera('my sister mia is visiting this weekend')
  await turnEnd(app, m, 30_000)
  await readAll(app, { settleMs: 500 })
  m = await sayOnCamera('wait, who did i say was visiting?')
  await turnEnd(app, m, 30_000)
  await readAll(app, { settleMs: 600 })

  // A headpat, and feelings that move with it.
  await caption('Feelings that change with you', 'joy · sadness · anger · surprise · fear')
  await sleep(500)
  await pat(head, HEADPAT_MS)
  await sleep(1300)

  await endCard()
  await sleep(2800)
  await stopCapture()
  console.log(`captured ${frames.length} frames over ${(frames.at(-1).t - frames[0].t).toFixed(1)} s`)
  console.log(`wrote ${encode()}`)
} finally {
  await app?.close()
  await stopVite?.()
  removeTempDirs()
}
