// The pose studio (a 3D card): she stands large at the left, posed by dragging the dots on her joints (character/
// studio.ts); the panel at the right holds the emotion being made, its keys, the picked joint's fine turns, hand
// shapes, mirroring, undo, Blender and a photo. Each change is saved on her card (appearance.motions) as it is made.

import { EMOTIONS, type CustomMotion, type Emotion, type JointPose, type JointTurn, type ServerMsg } from '../../../link/src/protocol.ts'
import { MAX_KEY_T, MAX_KEYS } from '../../../link/src/motions.ts'
import type { CharacterStudio, Ctx, Screen } from '../contracts'
import { esc } from '../ui'
import './studio.css'

/** The three.js side of posing, loaded with the studio (the rest of the app never needs it). */
const kit = () => Promise.all([import('../character/poser.ts'), import('../character/mmd-engine.ts'), import('../character/motion-vmd.ts')])
  .then(([poser, engine, vmd]) => ({ ...poser, ...engine, ...vmd }))
type Kit = Awaited<ReturnType<typeof kit>>

const AXES = ['Bend', 'Turn', 'Tilt'] as const
/** Seconds between a new key and the one before it. */
const KEY_GAP_S = 0.3
const UNDO_MAX = 60
/** A photo at the size of her box on the stage. */
const PHOTO_W = 864
const PHOTO_H = 900

const PART: Record<string, string> = {
  上半身: 'Waist', 上半身2: 'Chest', 下半身: 'Hips', 首: 'Neck', 頭: 'Head', 両目: 'Eyes', 目: 'Eye',
  肩: 'shoulder', 腕: 'arm', 腕捩: 'arm twist', ひじ: 'elbow', 手捩: 'wrist twist', 手首: 'hand',
  親指: 'thumb', 人指: 'index', 中指: 'middle', 薬指: 'ring', 小指: 'little', 足: 'leg', ひざ: 'knee', 足首: 'ankle',
}
const GROUPS: [string, RegExp][] = [
  ['Head and body', /^(上半身2?|下半身|首|頭|両目|[左右]目)$/],
  ['Arms', /^[左右](肩|腕|腕捩|ひじ|手捩|手首)$/],
  ['Hands', /^[左右](親指|人指|中指|薬指|小指)/],
  ['Legs', /^[左右](足|ひざ|足首)$/],
]

/** An MMD bone name in plain words: 左ひじ → "Left elbow", 右人指２ → "Right index 2". */
export function jointLabel(name: string) {
  const m = /^([左右]?)(.+?)([０-３]?)$/.exec(name)!
  const side = m[1] === '左' ? 'Left ' : m[1] === '右' ? 'Right ' : ''
  const digit = m[3] ? ` ${'０１２３'.indexOf(m[3])}` : ''
  return `${side}${PART[m[2]!] ?? m[2]}${digit}`.replace(/^(\w)/, (c) => c.toUpperCase())
}

/** The camera buttons: where each puts it round her (radians), and how far ◀ ▶ turn it. */
const CAMERA = [['Front', 0], ['Side', -Math.PI / 2], ['Back', Math.PI]] as const
const CAM_STEP = Math.PI / 4
/** How long "✓ Saved" shows after a change is saved. */
const SAVED_MS = 1600

const FINGERS: [string, string][] = [['親指', 'Thumb'], ['人指', 'Index'], ['中指', 'Middle'], ['薬指', 'Ring'], ['小指', 'Little']]

/** The finger picker: each hand's fingers, a button per segment from base to tip (the joints this model has). */
function fingersHtml(joints: string[]) {
  return (['左', '右'] as const).map((side) => {
    const rows = FINGERS.map(([f, label]) => {
      const segs = joints.filter((j) => j.startsWith(side + f)).sort()
      return segs.length ? `<span>${label}</span><div class="st-line">${segs.map((j, i) => `<button type="button" data-st="pick" data-joint="${esc(j)}" data-test="st-finger-${esc(j)}" title="${esc(jointLabel(j))}">${i + 1}</button>`).join('')}</div>` : ''
    }).join('')
    return rows ? `<div class="st-hand"><b>${side === '左' ? 'Left' : 'Right'}</b>${rows}</div>` : ''
  }).join('')
}

const HAND_SHAPES = [['open', 'Open'], ['relaxed', 'Relaxed'], ['fist', 'Fist'], ['point', 'Point'], ['peace', 'Peace']] as const

const b64 = (bytes: Uint8Array) => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

function html() {
  return `<div class="panel st-panel" data-test="studio">
    <div class="st-head"><h2>Pose studio</h2><button class="btn" type="button" data-st="done" data-test="st-done">Done</button></div>
    <div class="st-row"><label>Emotion</label>
      <select class="field" data-st="emotion" data-test="st-emotion">${EMOTIONS.map((e) => `<option value="${e}">${e}</option>`).join('')}</select>
      <em data-st-state data-test="st-state"></em><em class="st-saved" data-st-saved data-test="st-saved" hidden>✓ Saved</em></div>
    <div class="st-row"><label>Timeline<small>The pose she holds, and keys on the way into it</small></label>
      <div class="st-line"><div class="st-keys" data-st-keys data-test="st-keys"></div>
        <button class="btn" type="button" data-st="add-key" data-test="st-add-key">+ Key</button>
        <button class="btn" type="button" data-st="del-key" data-test="st-del-key">− Key</button>
        <span class="st-time" data-st-timebox>at <input class="field" type="number" min="0" max="${MAX_KEY_T}" step="0.05" data-st="time" data-test="st-time"> s</span>
        <button class="btn" type="button" data-st="play" data-test="st-play">▶ Play</button></div></div>
    <div class="st-row"><label>Joint<small>Click a dot on her, or pick one</small></label>
      <div class="st-line"><select class="field" data-st="joint" data-test="st-joint"></select>
        <button class="btn" type="button" data-st="zero" data-test="st-zero">Relax it</button></div></div>
    <div class="st-row"><label>Fingers<small>Base to tip</small></label><div class="st-fingers" data-st-fingers data-test="st-fingers"></div></div>
    ${AXES.map((a, i) => `<div class="st-row st-knob"><label>${a}</label><input type="range" min="-180" max="180" step="0.5" data-st="knob" data-axis="${i}" data-test="st-knob-${a.toLowerCase()}"><output data-st-out="${i}"></output></div>`).join('')}
    <div class="st-row"><label>Hands</label><div class="st-hands">
      ${(['左', '右'] as const).map((side) => `<div class="st-line"><span class="st-side">${side === '左' ? 'Left' : 'Right'}</span>${HAND_SHAPES.map(([id, label]) => `<button class="btn" type="button" data-st="hand" data-side="${side}" data-shape="${id}" data-test="st-hand-${side === '左' ? 'left' : 'right'}-${id}">${label}</button>`).join('')}</div>`).join('')}
    </div></div>
    <div class="st-row"><label>Mirror</label><div class="st-line">
      <button class="btn" type="button" data-st="mirror" data-from="左" data-test="st-mirror-left">Left onto right</button>
      <button class="btn" type="button" data-st="mirror" data-from="右" data-test="st-mirror-right">Right onto left</button></div></div>
    <div class="st-row"><label>Edit</label><div class="st-line">
      <button class="btn" type="button" data-st="undo" data-test="st-undo" title="Ctrl+Z">Undo</button>
      <button class="btn" type="button" data-st="redo" data-test="st-redo" title="Ctrl+Y">Redo</button>
      <button class="btn danger" type="button" data-st="reset" data-test="st-reset">Back to built-in</button></div></div>
    <div class="st-row"><label>Camera</label><div class="st-line">
      <button class="btn" type="button" data-st="cam" data-by="1" data-test="st-cam-left" title="Turn round her">◀</button>
      ${CAMERA.map(([label, yaw]) => `<button class="btn" type="button" data-st="cam" data-yaw="${yaw}" data-test="st-cam-${label.toLowerCase()}">${label}</button>`).join('')}
      <button class="btn" type="button" data-st="cam" data-by="-1" data-test="st-cam-right" title="Turn round her">▶</button></div></div>
    <div class="st-row"><label>More</label><div class="st-line">
      <button class="btn" type="button" data-st="blender" data-test="st-blender">Open in Blender</button>
      <button class="btn" type="button" data-st="photo" data-test="st-photo">Save photo</button></div></div>
    <p class="st-note">Drag a hand to place it and an elbow to swing its arm; drag her head, neck, chest, waist or a shoulder to turn it (Shift tilts). Click a dot for rings that turn it exactly. Right-drag (or the camera buttons) turns the camera round her, the wheel zooms. Every change saves itself on her waifu card as you make it, for the emotion picked above; a posed leg lets go of the floor.</p>
    <p class="st-note" data-st-none hidden>The pose studio needs a 3D card: choose a .pmx model in Settings → Appearance.</p>
  </div>`
}

export function studioScreen(): Screen {
  let ctx: Ctx
  let root: HTMLElement
  let k: Kit | undefined
  let studio: CharacterStudio | undefined
  let emotion: Emotion = 'normal'
  /** -1: the held pose; otherwise a key's index. */
  let sel = -1
  let joint = ''
  let draft: CustomMotion = { pose: {}, keys: [] }
  let undo: CustomMotion[] = []
  let redo: CustomMotion[] = []
  let visible = false
  let jointsHtml = ''
  let fingers = ''
  let savedTimer: number | undefined
  /** A drag on her is under way (its first move took an undo step). */
  let dragging = false
  /** The picked joint has its rings on her. */
  let ringed = false

  const q = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!
  const stored = () => ctx.store.get().appearance.motions[emotion]
  /** What she shows: the held pose, or a key over it. */
  const shown = (): JointPose => (sel < 0 ? draft.pose : { ...draft.pose, ...draft.keys[sel]!.pose })
  const turnOf = (): JointTurn => shown()[joint] ?? [0, 0, 0]

  /** The pose she shows, edited: the held pose takes it, or the selected key keeps what differs from the held one. */
  function edited(p: JointPose) {
    if (sel < 0) return void (draft.pose = p)
    const key: JointPose = {}
    for (const [n, v] of Object.entries(p)) {
      const h = draft.pose[n] ?? [0, 0, 0]
      if (v.some((x, i) => x !== h[i])) key[n] = v
    }
    for (const n of Object.keys(draft.pose)) if (!p[n]) key[n] = [0, 0, 0]
    draft.keys[sel]!.pose = key
  }

  function step() {
    undo.push(structuredClone(draft))
    if (undo.length > UNDO_MAX) undo.shift()
    redo = []
  }

  function save() {
    const m = structuredClone(draft)
    ctx.store.update((s) => void (s.appearance.motions = { ...s.appearance.motions, [emotion]: m }))
    refresh()
    flashSaved()
  }

  function flashSaved() {
    const el = q('[data-st-saved]')
    el.hidden = false
    clearTimeout(savedTimer)
    savedTimer = window.setTimeout(() => (el.hidden = true), SAVED_MS)
  }

  function pick(j: string) {
    joint = j
    studio?.select(joint)
    ringed = true
    refresh()
  }

  /** A change made in the panel: one undo step, shown on her, saved. */
  function change(fn: () => void) {
    step()
    fn()
    studio?.set(shown())
    save()
  }

  function load(e: Emotion) {
    emotion = e
    sel = -1
    undo = []
    redo = []
    const m = stored()
    draft = m ? structuredClone(m) : { pose: k!.emotionPose(e), keys: [] }
    // Her face follows the emotion being posed.
    ctx.character.emote(e)
    studio?.set(shown())
    refresh()
  }

  function refresh() {
    if (!visible) return
    const joints = ctx.character.joints()
    q('[data-st-none]').hidden = !!studio
    if (!joints.includes(joint)) joint = joints.includes('頭') ? '頭' : (joints[0] ?? '')
    const opts = GROUPS.map(([label, re]) => {
      const list = joints.filter((j) => re.test(j)).map((j) => `<option value="${esc(j)}">${esc(jointLabel(j))}</option>`).join('')
      return list ? `<optgroup label="${label}">${list}</optgroup>` : ''
    }).join('')
    const select = q<HTMLSelectElement>('[data-st="joint"]')
    if (opts !== jointsHtml) (jointsHtml = opts), (select.innerHTML = opts)
    select.value = joint
    const f = fingersHtml(joints)
    if (f !== fingers) (fingers = f), (q('[data-st-fingers]').innerHTML = f)
    for (const b of root.querySelectorAll<HTMLElement>('[data-st="pick"]')) b.classList.toggle('on', b.dataset.joint === joint)
    q<HTMLSelectElement>('[data-st="emotion"]').value = emotion
    q('[data-st-state]').textContent = stored() ? 'Her own, on her card' : 'Built-in'
    q('[data-st-keys]').innerHTML = [`<button type="button" data-st="key" data-k="-1">Hold</button>`, ...draft.keys.map((key, i) => `<button type="button" data-st="key" data-k="${i}">${key.t.toFixed(2)} s</button>`)].join('')
    for (const b of root.querySelectorAll<HTMLElement>('[data-st="key"]')) b.classList.toggle('on', Number(b.dataset.k) === sel)
    q('[data-st-timebox]').hidden = sel < 0
    if (sel >= 0) q<HTMLInputElement>('[data-st="time"]').value = String(draft.keys[sel]!.t)
    q<HTMLButtonElement>('[data-st="add-key"]').disabled = draft.keys.length >= MAX_KEYS
    q<HTMLButtonElement>('[data-st="del-key"]').disabled = sel < 0
    q<HTMLButtonElement>('[data-st="reset"]').disabled = !stored()
    q<HTMLButtonElement>('[data-st="undo"]').disabled = !undo.length
    q<HTMLButtonElement>('[data-st="redo"]').disabled = !redo.length
    for (const b of root.querySelectorAll<HTMLButtonElement>('[data-st="blender"], [data-st="photo"]')) b.disabled = !studio || ctx.link.remote
    knobs()
  }

  function knobs() {
    turnOf().forEach((v, i) => {
      const knob = q<HTMLInputElement>(`[data-st="knob"][data-axis="${i}"]`)
      knob.value = String(v)
      knob.disabled = !joint || !studio
      q(`[data-st-out="${i}"]`).textContent = `${v}°`
    })
  }

  // ---------------------------------------------------------------- Blender

  async function openBlender(exe?: string) {
    if (!k) return
    ctx.link.send({ t: 'blender_open', emotion, vmd: b64(k.motionToVmd(draft, ctx.store.get().waifu.name || 'waifu')), ...(exe ? { exe } : {}) })
  }

  async function onServer(m: ServerMsg) {
    if (m.t === 'photo_saved') return ctx.toast(m.error ? `The photo wasn't saved: ${m.error}` : 'Photo saved.', 3200)
    if (m.t !== 'blender') return
    if (m.state === 'open') return ctx.toast(`Blender is opening her ${m.emotion} pose. Save there (Ctrl+S) and it comes back here.`, 6000)
    if (m.state === 'error') return ctx.toast(`Blender: ${m.error}`, 8000)
    if (m.state === 'missing') {
      const yes = await ctx.confirm('Blender not found', 'Blender (with its MMD Tools extension) edits her motion. Point to blender.exe if it is installed, or install it from blender.org first.', 'Find blender.exe', 'Not now')
      if (!yes) return
      const exe = await ctx.pickFile('Find blender.exe', 'Blender', ['exe'])
      if (exe && m.emotion === emotion) void openBlender(exe)
      return
    }
    if (!m.vmd || m.card !== ctx.store.get().card) return ctx.toast('A save from Blender was for another card, so it was left out.', 5000)
    let motion: CustomMotion
    try {
      motion = (k ??= await kit()).motionFromVmd(unb64(m.vmd))
    } catch (e) {
      return ctx.toast(`That save from Blender couldn't be read: ${e instanceof Error ? e.message : e}`, 6000)
    }
    ctx.store.update((s) => void (s.appearance.motions = { ...s.appearance.motions, [m.emotion]: motion }))
    if (visible && m.emotion === emotion) {
      step()
      draft = structuredClone(motion)
      sel = -1
      studio?.set(shown())
      refresh()
    }
    ctx.toast(`Her ${m.emotion} motion came over from Blender.`, 3200)
  }

  async function photo() {
    const path = await ctx.pickSavePath('Save a photo of her', `${ctx.store.get().waifu.name || 'waifu'}-${emotion}.jpg`, 'Photo', ['jpg'])
    if (!path) return
    // The rings would be in the photo.
    studio?.select(undefined)
    ringed = false
    const data = await ctx.character.snapshot(PHOTO_W, PHOTO_H)
    if (data) ctx.link.send({ t: 'photo_save', path, data })
    else ctx.toast('The photo couldn\'t be taken.', 3200)
  }

  // ---------------------------------------------------------------- events

  function onKey(e: KeyboardEvent) {
    if (!visible || (e.target as HTMLElement).matches('input[type="number"], input[type="text"], textarea')) return
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) e.preventDefault(), history(undo, redo)
    else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) e.preventDefault(), history(redo, undo)
  }

  function history(from: CustomMotion[], to: CustomMotion[]) {
    const prev = from.pop()
    if (!prev) return
    to.push(structuredClone(draft))
    draft = prev
    if (sel >= draft.keys.length) sel = -1
    studio?.set(shown())
    save()
  }

  return {
    mount(r, c) {
      root = r
      ctx = c
      root.innerHTML = html()
      ctx.link.on((m) => void onServer(m))
      addEventListener('keydown', onKey)

      root.addEventListener('input', (e) => {
        const t = e.target as HTMLInputElement
        if (t.dataset.st !== 'knob' || !joint || !k) return
        const v = [...turnOf()] as JointTurn
        v[Number(t.dataset.axis)] = Number(t.value)
        const p = { ...shown(), [joint]: k.limit(joint, v) }
        edited(p)
        studio?.set(shown())
        q(`[data-st-out="${t.dataset.axis}"]`).textContent = `${shown()[joint]![Number(t.dataset.axis)]}°`
      })

      root.addEventListener('pointerdown', (e) => {
        // A knob's drag is one undo step, taken before it moves.
        if ((e.target as HTMLElement).dataset.st === 'knob') step()
      })

      root.addEventListener('change', (e) => {
        const t = e.target as HTMLInputElement
        switch (t.dataset.st) {
          case 'knob':
            return save()
          case 'emotion':
            return load(t.value as Emotion)
          case 'joint':
            return pick(t.value)
          case 'time': {
            const key = draft.keys[sel]
            if (!key) return
            change(() => {
              key.t = Math.max(0, Math.min(MAX_KEY_T, Math.round(Number(t.value) * 100) / 100 || 0))
              draft.keys.sort((a, b) => a.t - b.t)
              sel = draft.keys.indexOf(key)
            })
          }
        }
      })

      root.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-st]')
        if (!b || (b as HTMLButtonElement).disabled) return
        switch (b.dataset.st) {
          case 'done':
            return ctx.router.back()
          case 'pick':
            return pick(b.dataset.joint!)
          case 'cam':
            return b.dataset.by ? studio?.turn(Number(b.dataset.by) * CAM_STEP, true) : studio?.turn(Number(b.dataset.yaw))
          case 'key':
            sel = Number(b.dataset.k)
            studio?.set(shown())
            return refresh()
          case 'add-key':
            // A new key starts as the pose shown now, a little after the last key.
            return change(() => {
              const t = Math.min(MAX_KEY_T, Math.round(((draft.keys.at(-1)?.t ?? -KEY_GAP_S) + KEY_GAP_S) * 100) / 100)
              draft.keys.push({ t, pose: sel < 0 ? {} : structuredClone(draft.keys[sel]!.pose) })
              sel = draft.keys.length - 1
            })
          case 'del-key':
            return change(() => {
              draft.keys.splice(sel, 1)
              sel = -1
            })
          case 'zero':
            if (!joint) return
            return change(() => {
              const p = { ...shown() }
              delete p[joint]
              edited(p)
            })
          case 'hand':
            if (!k) return
            return change(() => edited({ ...shown(), ...k!.HANDS[b.dataset.shape as keyof Kit['HANDS']](b.dataset.side as '左' | '右') }))
          case 'mirror':
            if (!k) return
            return change(() => edited(k!.mirror(shown(), b.dataset.from as '左' | '右')))
          case 'undo':
            return history(undo, redo)
          case 'redo':
            return history(redo, undo)
          case 'play':
            studio?.select(undefined)
            ringed = false
            return studio?.play(structuredClone(draft))
          case 'reset':
            step()
            ctx.store.update((s) => {
              const { [emotion]: _, ...rest } = s.appearance.motions
              s.appearance.motions = rest
            })
            draft = { pose: k!.emotionPose(emotion), keys: [] }
            sel = -1
            studio?.set(shown())
            refresh()
            return flashSaved()
          case 'blender':
            return void openBlender()
          case 'photo':
            return void photo()
        }
      })
    },
    async show(params) {
      visible = true
      ctx.character.setPlacement('studio')
      k ??= await kit()
      if (!visible) return
      studio = ctx.character.studio()
      studio?.begin(
        {},
        (p, done) => {
          // A drag on her: its first move is one undo step; it is saved when it ends. A click moved nothing.
          if (done && !dragging) return
          if (!dragging) step(), (dragging = true)
          edited(p)
          knobs()
          if (done) (dragging = false), save()
        },
        (j) => {
          ringed = !!j
          if (j) joint = j
          refresh()
        },
      )
      const e = params?.emotion
      load(typeof e === 'string' && (EMOTIONS as readonly string[]).includes(e) ? (e as Emotion) : emotion)
    },
    hide() {
      visible = false
      studio?.end()
      studio = undefined
      // She goes back to the emotion she shows, with her new motion for it.
      ctx.character.emote('normal')
    },
    onEscape() {
      // Esc puts the rings away first, then leaves.
      if (ringed && studio) {
        studio.select(undefined)
        ringed = false
      } else ctx.router.back()
      return true
    },
  }
}
