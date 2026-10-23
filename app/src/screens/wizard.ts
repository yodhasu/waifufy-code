import type { Auth, Costume, Emotion, Honorific, Profile, ServerMsg, Settings } from '../../../link/src/protocol.ts'
import type { Ctx, Screen } from '../contracts'
import { esc } from '../ui'
import { addressOf, overlayOpen, relationWord, waifuName } from './title'
import './screens.css'

type StepId = 'welcome' | 'profile' | 'models' | 'login' | 'theme'

const STEPS: { id: StepId; label: string }[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'profile', label: 'Your profile' },
  { id: 'models', label: 'Costumes' },
  { id: 'login', label: 'Claude login' },
  { id: 'theme', label: 'Theme' },
]

const HONORIFICS: { v: Honorific; label: string }[] = [
  { v: 'kun', label: '-kun' },
  { v: 'sama', label: '-sama' },
  { v: 'chan', label: '-chan' },
  { v: 'san', label: '-san' },
  { v: 'senpai', label: '-senpai' },
  { v: 'dono', label: '-dono' },
  { v: 'none', label: 'none' },
  { v: 'custom', label: 'custom…' },
]

const PRONOUNS = ['he/him', 'she/her', 'they/them']

type Theme = Settings['appearance']['theme']
const THEMES: { v: Theme; icon: string; label: string; note: string }[] = [
  { v: 'light', icon: '☀', label: 'Light', note: 'A sunlit room' },
  { v: 'dark', icon: '☾', label: 'Dark', note: 'A moonlit night' },
  { v: 'system', icon: '◐', label: 'System', note: 'Follow Windows' },
]

const AVATAR_PX = 256
const AVATAR_QUALITY = 0.9
const SCAN_TIMEOUT_MS = 20000
/** `claude auth status` normally answers in a second or two; past this the check is treated as finished. */
const AUTH_TIMEOUT_MS = 20000
const COMMA_PAUSE_MS = 180
const STOP_PAUSE_MS = 420
const CHIPS_SHOWN = 6

/** Folder paths compared the way Windows does: case, slash direction and a trailing slash don't matter. */
const normDir = (p: string) => p.trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()

type CostumesMsg = Extract<ServerMsg, { t: 'costumes' }>
type Models = { state: 'checking' } | { state: 'done'; dir: string; list: Costume[] }

/** Square center crop, scaled to AVATAR_PX, so a huge photo never bloats settings.json. */
async function cropAvatar(dataUrl: string) {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const side = Math.min(img.naturalWidth, img.naturalHeight)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = AVATAR_PX
  const g = canvas.getContext('2d')!
  g.imageSmoothingQuality = 'high'
  g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, AVATAR_PX, AVATAR_PX)
  return canvas.toDataURL('image/webp', AVATAR_QUALITY)
}

/** First-run wizard (R48): welcome, profile, models folder, Claude login, theme. */
export function wizardScreen(): Screen {
  let ctx: Ctx
  let root: HTMLElement
  let body: HTMLElement
  let lineEl: HTMLElement
  let step = 0
  let visited = 0
  let active = false
  let auth: Auth | undefined
  let checkingAuth = false
  let authTimer: number | undefined
  let loginOpened = false
  let models: Models = { state: 'checking' }
  let scanSeq = 0
  let scanning: Promise<unknown> = Promise.resolve()
  let typing: number | undefined
  let spoken = ''

  const s = () => ctx.store.get()
  const stepId = () => STEPS[step].id
  const found = () => models.state === 'done' && models.list.length > 0

  // ---------------------------------------------------------------- her line (a tiny typewriter)

  function say(text: string, emotion?: Emotion) {
    if (text === spoken) return
    stopTyping()
    spoken = text
    if (emotion) ctx.character.emote(emotion)
    const { textCps, punctuationPauses } = s().motion
    if (!textCps) return void (lineEl.textContent = text)
    let n = 0
    lineEl.textContent = ''
    const tick = () => {
      n++
      lineEl.textContent = text.slice(0, n)
      if (n >= text.length) return stopTyping()
      const ch = text[n - 1]
      const pause = !punctuationPauses ? 0 : /[.!?…]/.test(ch) ? STOP_PAUSE_MS : /[,;]/.test(ch) ? COMMA_PAUSE_MS : 0
      // Her mouth closes during punctuation pauses, like the dialogue box (R28).
      ctx.character.setTalking(pause === 0)
      typing = window.setTimeout(tick, 1000 / textCps + pause)
    }
    ctx.character.setTalking(true)
    typing = window.setTimeout(tick, 1000 / textCps)
  }

  function stopTyping() {
    if (typing === undefined) return
    clearTimeout(typing)
    typing = undefined
    lineEl.textContent = spoken
    ctx.character.setTalking(false)
  }

  function speak() {
    const st = s()
    const name = waifuName(st)
    const addr = addressOf(st)
    const id = stepId()
    if (id === 'welcome') {
      const from = st.waifu.series.trim() ? ` from ${st.waifu.series.trim()}` : ''
      say(`Ah, there you are! I'm ${name}${from}. From today on, I'll be your Claude Code ${relationWord(st)}. May I ask a few things before we begin?`, 'smile')
    } else if (id === 'profile') say("First things first… what should I call you? I'd like to get it right.", 'shy')
    else if (id === 'models') {
      if (models.state === 'checking') say('Now, where did I leave my wardrobe…', 'think')
      else if (found()) {
        const n = models.list.length
        say(`I found ${n} outfit${n === 1 ? '' : 's'}, ${addr}! You can change what I wear any time with 👗 in the chat.`, 'happy')
      } else say(`I can't find my costumes… could you show me the folder, ${addr}?`, 'worried')
    } else if (id === 'login') {
      if (!auth || checkingAuth) say("Let me check whether you're signed in to Claude…", 'think')
      else if (auth.loggedIn) say(`You're signed in${auth.email ? ` as ${auth.email}` : ''}. I'm ready to work for you, ${addr}!`, 'delighted')
      else say("I need your Claude login before I can do any real work. It only takes a minute, I promise!", 'worried')
    } else say(`Last one, ${addr}! Do you like working in daylight, or late at night?`, 'smile')
  }

  // ---------------------------------------------------------------- step bodies

  function profileHtml() {
    const p = s().profile
    const name = esc(waifuName(s()))
    return `
      <div class="wz-grid">
        <label class="wz-field"><span>Display name</span>
          <input class="field" data-key="displayName" data-test="set-profile.displayName" maxlength="40" spellcheck="false"></label>
        <label class="wz-field"><span>What ${name} calls you</span>
          <input class="field" data-key="callMe" data-test="set-profile.callMe" maxlength="40" spellcheck="false"></label>
        <div class="wz-field"><span>Honorific</span>
          <div class="wz-pair">
            <select class="field" data-key="honorific" data-test="set-profile.honorific">
              ${HONORIFICS.map((h) => `<option value="${h.v}">${h.label}</option>`).join('')}
            </select>
            <input class="field" data-key="customHonorific" data-test="set-profile.customHonorific" placeholder="-tan" maxlength="16"
              spellcheck="false" ${p.honorific === 'custom' ? '' : 'hidden'}>
          </div></div>
        <label class="wz-field"><span>Pronouns</span>
          <input class="field" data-key="pronouns" data-test="set-profile.pronouns" list="wz-pronouns" maxlength="24" spellcheck="false">
          <datalist id="wz-pronouns">${PRONOUNS.map((x) => `<option value="${x}">`).join('')}</datalist></label>
      </div>
      <div class="wz-avatar-row">
        <div class="wz-avatar"></div>
        <div class="wz-avatar-side">
          <span class="wz-label">Avatar</span>
          <div class="wz-row">
            <button class="btn" data-act="avatar" data-test="set-profile.avatar">Choose image…</button>
            <button class="btn" data-act="avatar-clear">Remove</button>
          </div>
          <small>Center-cropped to a ${AVATAR_PX} px square.</small>
        </div>
      </div>
      <p class="wz-preview"></p>`
  }

  function fillProfile() {
    const p = s().profile
    for (const el of body.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]')) el.value = p[el.dataset.key as keyof Profile]
    refreshProfile()
  }

  /** The bits of the profile step that follow what's typed: avatar, custom honorific, the address preview. */
  function refreshProfile() {
    const st = s()
    const p = st.profile
    const avatar = body.querySelector<HTMLElement>('.wz-avatar')!
    avatar.innerHTML = p.avatar ? `<img src="${esc(p.avatar)}" alt="">` : `<span>${esc((p.displayName.trim() || '?')[0].toUpperCase())}</span>`
    body.querySelector<HTMLButtonElement>('[data-act="avatar-clear"]')!.disabled = !p.avatar
    body.querySelector<HTMLElement>('[data-key="customHonorific"]')!.hidden = p.honorific !== 'custom'
    body.querySelector('.wz-preview')!.innerHTML = `${esc(waifuName(st))} will call you <b>${esc(addressOf(st))}</b>.`
  }

  function modelsHtml() {
    const name = esc(waifuName(s()))
    const dir = models.state === 'done' ? models.dir : s().appearance.modelsDir
    let status = '<div class="wz-status wait">Looking for costumes…</div>'
    let chips = ''
    if (models.state === 'done') {
      const n = models.list.length
      status = n
        ? `<div class="wz-status ok">✓ ${n} costume${n === 1 ? '' : 's'} found</div>`
        : `<div class="wz-status bad">✗ No costume folders found ${dir ? 'here' : 'automatically'}</div>`
      chips = models.list.slice(0, CHIPS_SHOWN).map((c) => `<span class="wz-chip">${esc(c.label)}</span>`).join('')
      if (n > CHIPS_SHOWN) chips += `<span class="wz-chip more">+${n - CHIPS_SHOWN} more</span>`
    }
    return `
      <div class="wz-card">
        <span class="wz-label">Models folder</span>
        <input class="field mono wz-path" readonly data-test="set-appearance.modelsDir" value="${esc(dir)}" title="${esc(dir)}"
          placeholder="Not found automatically">
        ${status}
        ${chips ? `<div class="wz-chips">${chips}</div>` : ''}
        <div class="wz-row"><button class="btn" data-act="browse" data-test="set-appearance.modelsDir-browse">Browse…</button></div>
      </div>
      <p class="wz-note">Each costume is a folder with a <code>.model3.json</code> inside. Without one, ${name} appears as a simple
        placeholder sprite and everything else still works. You can set the folder later in Settings → Appearance.</p>`
  }

  function loginHtml() {
    const name = esc(waifuName(s()))
    const state = !auth || checkingAuth ? 'wait' : auth.loggedIn ? 'ok' : 'bad'
    const icon = { wait: '…', ok: '✓', bad: '✗' }[state]
    const title = { wait: 'Checking your login…', ok: 'Signed in to Claude', bad: 'Not signed in' }[state]
    const sub =
      state === 'ok'
        ? [auth?.email, auth?.subscription, auth?.method].filter(Boolean).join(' · ')
        : state === 'bad'
          ? loginOpened
            ? 'A login window opened. Finish signing in there, then press Check again.'
            : (auth?.error ?? 'Claude Code needs you to sign in once.')
          : ''
    return `
      <div class="wz-card wz-auth ${state}">
        <div class="wz-auth-icon">${icon}</div>
        <div><div class="wz-auth-title">${title}</div><div class="wz-auth-sub">${esc(sub)}</div></div>
      </div>
      <div class="wz-row">
        ${state === 'ok' ? '' : '<button class="btn primary" data-act="login" data-test="wizard-login">Log in</button>'}
        <button class="btn" data-act="check" data-test="wizard-auth-check" ${checkingAuth ? 'disabled' : ''}>Check again</button>
      </div>
      ${state === 'bad' ? `<p class="wz-warn">Without a login ${name} can't reach Claude. You can continue anyway and log in later from the title screen.</p>` : ''}`
  }

  function themeHtml() {
    const cur = s().appearance.theme
    return `
      <div class="wz-themes" role="radiogroup" data-test="set-appearance.theme" data-value="${cur}">
        ${THEMES.map(
          (t) => `<button class="wz-theme" role="radio" data-act="theme" data-v="${t.v}" aria-checked="${t.v === cur}">
            <span class="wz-theme-icon">${t.icon}</span><b>${t.label}</b><small>${t.note}</small></button>`,
        ).join('')}
      </div>
      <p class="wz-note">The whole stage changes as you choose. Accent color, dialogue font, background and petals live in Settings → Appearance.</p>`
  }

  function renderBody() {
    const id = stepId()
    if (id === 'welcome') {
      body.innerHTML = `
        <div class="wz-welcome">
          <h2 class="title-text">Welcome to Waifufy Code</h2>
          <p>Claude Code, as a visual novel. Every habit you already have still works:</p>
          <ul class="wz-keys">
            <li><kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line · <kbd>↑</kbd> history</li>
            <li><kbd>/</kbd> commands · <kbd>@</kbd> files · <kbd>!</kbd> shell</li>
            <li><kbd>Esc</kbd> interrupt · <kbd>Shift</kbd>+<kbd>Tab</kbd> permission mode</li>
          </ul>
          <p class="wz-note">Four quick steps: who you are, where the costumes live, your Claude login, and day or night.</p>
        </div>`
    } else if (id === 'profile') {
      body.innerHTML = profileHtml()
      fillProfile()
    } else if (id === 'models') body.innerHTML = modelsHtml()
    else if (id === 'login') body.innerHTML = loginHtml()
    else body.innerHTML = themeHtml()
    renderFoot()
  }

  function renderFoot() {
    const id = stepId()
    const last = step === STEPS.length - 1
    const next = root.querySelector<HTMLButtonElement>('[data-test="wizard-next"]')!
    next.hidden = last
    next.textContent = id === 'models' && models.state === 'done' && !found() ? 'Skip for now' : id === 'login' && auth && !auth.loggedIn ? 'Continue anyway' : 'Next'
    root.querySelector<HTMLButtonElement>('[data-test="wizard-finish"]')!.hidden = !last
    root.querySelector<HTMLButtonElement>('[data-test="wizard-back"]')!.disabled = step === 0
  }

  function renderStep() {
    const panel = root.querySelector<HTMLElement>('.wz-panel')!
    panel.dataset.step = stepId()
    root.querySelector('.wz-steps')!.innerHTML = STEPS.map(
      (st, k) => `<li><button class="wz-dot${k === step ? ' on' : k < step ? ' done' : ''}" data-step="${k}" ${k > visited ? 'disabled' : ''}
          aria-current="${k === step ? 'step' : 'false'}"><i>${k < step ? '✓' : k + 1}</i><span>${st.label}</span></button></li>`,
    ).join('')
    root.querySelector('.wz-kicker')!.textContent = `Step ${step + 1} of ${STEPS.length} · ${STEPS[step].label}`
    renderBody()
    body.classList.remove('enter')
    void body.offsetWidth
    body.classList.add('enter')
    speak()
    const first = body.querySelector<HTMLElement>('input:not([hidden]), select')
    const button = root.querySelector<HTMLElement>('.wz-foot .btn.primary:not([hidden])')
    ;(first ?? button)?.focus({ preventScroll: true })
  }

  /** Re-renders the current step's body after async news (scan result, login state), keeping focus sane. */
  function refreshIf(id: StepId) {
    if (!active || stepId() !== id) return
    const focused = document.activeElement instanceof HTMLElement && body.contains(document.activeElement) ? document.activeElement.dataset.act : undefined
    renderBody()
    if (focused) body.querySelector<HTMLElement>(`[data-act="${focused}"]`)?.focus({ preventScroll: true })
    speak()
  }

  function go(k: number) {
    const next = Math.max(0, Math.min(STEPS.length - 1, k))
    if (next === step) return
    step = next
    visited = Math.max(visited, step)
    renderStep()
  }

  function finish() {
    stopTyping()
    ctx.store.update((n) => {
      n.onboarded = true
    })
    ctx.router.go('title')
  }

  // ---------------------------------------------------------------- actions

  /** One scan in flight at a time, and a reply only counts for the folder it names, so a Browse never takes detect's answer. */
  function scan(dir: string): Promise<{ dir: string; list: Costume[] }> {
    const want = normDir(dir)
    const run = async () => {
      const reply = ctx.link.next((m): m is CostumesMsg => m.t === 'costumes' && (!want || normDir(m.dir) === want), SCAN_TIMEOUT_MS)
      ctx.link.send(dir ? { t: 'costumes', dir } : { t: 'costumes' })
      const r = await reply.catch(() => undefined)
      return { dir: r?.dir || dir, list: r?.found ? r.list : [] }
    }
    const result = scanning.then(run)
    scanning = result.catch(() => undefined)
    return result
  }

  async function detect() {
    const seq = ++scanSeq
    models = { state: 'checking' }
    refreshIf('models')
    const r = await scan(s().appearance.modelsDir)
    if (seq !== scanSeq) return
    models = { state: 'done', ...r }
    refreshIf('models')
    renderFoot()
  }

  async function browse() {
    const name = waifuName(s())
    const start = models.state === 'done' ? models.dir : s().appearance.modelsDir
    const dir = await ctx.pickFolder(`Where are ${name}'s costume folders?`, start)
    if (!dir) return
    const button = body.querySelector<HTMLButtonElement>('[data-act="browse"]')
    if (button) {
      button.disabled = true
      button.textContent = 'Looking…'
    }
    const r = await scan(dir)
    // A folder without costumes changes nothing, so a detect still in flight keeps its say.
    if (!r.list.length) {
      ctx.toast(`No costume folders in ${dir}. Each one needs a .model3.json inside.`)
      return refreshIf('models')
    }
    scanSeq++
    models = { state: 'done', ...r }
    ctx.store.update((n) => {
      n.appearance.modelsDir = r.dir
      if (!r.list.some((c) => c.id === n.appearance.costume)) n.appearance.costume = r.list[0].id
    })
    refreshIf('models')
    renderFoot()
  }

  function checkAuth() {
    checkingAuth = true
    clearTimeout(authTimer)
    authTimer = window.setTimeout(() => settleAuth(auth), AUTH_TIMEOUT_MS)
    ctx.link.send({ t: 'auth_check' })
    refreshIf('login')
    renderFoot()
  }

  function settleAuth(a: Auth | undefined) {
    clearTimeout(authTimer)
    auth = a ?? { loggedIn: false, error: "Claude Code didn't answer the login check." }
    checkingAuth = false
    if (auth.loggedIn) loginOpened = false
    refreshIf('login')
    if (active) renderFoot()
  }

  async function pickAvatar() {
    const [file] = await ctx.pickImages(false)
    if (!file) return
    const avatar = await cropAvatar(file.dataUrl).catch(() => '')
    if (!avatar) return ctx.toast(`Couldn't read ${file.name} as an image`)
    ctx.store.update((n) => {
      n.profile.avatar = avatar
    })
    if (stepId() === 'profile') refreshProfile()
  }

  function setTheme(v: Theme) {
    ctx.store.update((n) => {
      n.appearance.theme = v
    })
    const group = body.querySelector<HTMLElement>('.wz-themes')
    if (group) group.dataset.value = v
    for (const b of body.querySelectorAll<HTMLElement>('.wz-theme')) b.setAttribute('aria-checked', String(b.dataset.v === v))
  }

  function onInput(e: Event) {
    const el = e.target as HTMLInputElement | HTMLSelectElement
    const key = el.dataset.key as keyof Profile | undefined
    if (!key) return
    const before = s().profile
    // What she calls you follows the display name until it is edited on its own.
    const mirror = key === 'displayName' && before.callMe === before.displayName
    ctx.store.update((n) => {
      ;(n.profile as Record<keyof Profile, string>)[key] = el.value
      if (mirror) n.profile.callMe = el.value
    })
    if (mirror) body.querySelector<HTMLInputElement>('[data-key="callMe"]')!.value = el.value
    if (key === 'honorific' && el.value === 'custom') {
      const custom = body.querySelector<HTMLInputElement>('[data-key="customHonorific"]')!
      custom.hidden = false
      custom.focus()
    }
    refreshProfile()
  }

  function onClick(e: Event) {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')
    const act = b?.dataset.act
    if (act === 'avatar') void pickAvatar()
    else if (act === 'avatar-clear') {
      ctx.store.update((n) => {
        n.profile.avatar = ''
      })
      refreshProfile()
    } else if (act === 'browse') void browse()
    else if (act === 'login') {
      loginOpened = true
      ctx.link.send({ t: 'login' })
      refreshIf('login')
    } else if (act === 'check') checkAuth()
    else if (act === 'theme') setTheme(b!.dataset.v as Theme)
  }

  return {
    mount(el, c) {
      root = el
      ctx = c
      root.innerHTML = `
        <div class="wz-panel panel">
          <header class="wz-head">
            <div class="wz-kicker"></div>
            <ol class="wz-steps"></ol>
          </header>
          <div class="wz-speech" title="Click to finish her line">
            <div class="wz-name"></div>
            <p class="wz-line"></p>
          </div>
          <div class="wz-body"></div>
          <footer class="wz-foot">
            <button class="btn" data-test="wizard-back">Back</button>
            <span class="wz-hint">Enter next · Esc back</span>
            <button class="btn primary" data-test="wizard-next">Next</button>
            <button class="btn primary" data-test="wizard-finish" hidden>Let's begin!</button>
          </footer>
        </div>`
      body = root.querySelector('.wz-body')!
      lineEl = root.querySelector('.wz-line')!

      body.addEventListener('input', onInput)
      body.addEventListener('click', onClick)
      root.querySelector<HTMLElement>('.wz-speech')!.onclick = stopTyping
      root.querySelector<HTMLElement>('.wz-steps')!.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-step]')
        if (b && !b.disabled) go(Number(b.dataset.step))
      })
      root.querySelector<HTMLElement>('[data-test="wizard-back"]')!.onclick = () => go(step - 1)
      root.querySelector<HTMLElement>('[data-test="wizard-next"]')!.onclick = () => go(step + 1)
      root.querySelector<HTMLElement>('[data-test="wizard-finish"]')!.onclick = finish

      addEventListener('keydown', (e) => {
        if (!active || e.defaultPrevented || e.isComposing || e.ctrlKey || e.altKey || e.metaKey || overlayOpen()) return
        const t = e.target as HTMLElement
        if (e.key === 'Enter') {
          // On a theme card Enter picks it and finishes, so ←/→ then Enter is the whole keyboard path of the last step.
          const card = t.closest<HTMLElement>('.wz-theme')
          if (card && !e.repeat) {
            e.preventDefault()
            setTheme(card.dataset.v as Theme)
            return finish()
          }
          // Focused buttons click themselves; anywhere else (a text field, the stage) Enter means Next.
          if (t instanceof HTMLButtonElement || t instanceof HTMLTextAreaElement || e.repeat) return
          e.preventDefault()
          if (step === STEPS.length - 1) finish()
          else go(step + 1)
        } else if (stepId() === 'theme' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          e.preventDefault()
          const at = THEMES.findIndex((x) => x.v === s().appearance.theme)
          const v = THEMES[(at + (e.key === 'ArrowRight' ? 1 : -1) + THEMES.length) % THEMES.length].v
          setTheme(v)
          body.querySelector<HTMLElement>(`.wz-theme[data-v="${v}"]`)?.focus({ preventScroll: true })
        }
      })
      // Back from the login console window: see whether it worked.
      addEventListener('focus', () => {
        if (active && loginOpened && !auth?.loggedIn) checkAuth()
      })

      ctx.link.on((m) => {
        if (m.t === 'auth' || m.t === 'hello') settleAuth(m.auth)
      })
      ctx.store.subscribe((st) => {
        if (active) root.querySelector('.wz-name')!.textContent = waifuName(st)
      })
    },
    show() {
      active = true
      step = 0
      visited = 0
      spoken = ''
      root.querySelector('.wz-name')!.textContent = waifuName(s())
      // 'side', like the character module's default for this screen: she stands to the right of the 720 px panel.
      ctx.character.setPlacement('side')
      ctx.character.gesture('greet')
      renderStep()
      checkAuth()
      void detect()
    },
    hide() {
      active = false
      stopTyping()
    },
    onEscape() {
      if (step === 0) return false
      go(step - 1)
      return true
    },
  }
}
