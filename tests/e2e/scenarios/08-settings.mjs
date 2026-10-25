// R38–R46: deep customization. Every tab renders, fields apply live and persist, the persona preview
// follows the Waifu tab, research works (with the server faked by injected messages), dark mode
// themes every screen.
import { assert, brightSurfaces, byText, eq, fastText, newGame, readAll, say, setField, sleep, T, toTitle, turnEnd, waitScreen } from '../lib.mjs'

const MIN_TABS = 6
const PERSIST_MS = 3000
const PREVIEW_MS = 10_000
const TAB_SETTLE_MS = 150
const PERSIST_POLL_MS = 100
/** Lets a screen's theme transition finish before its colors are read. */
const THEME_SETTLE_MS = 350

const FIELDS = {
  R38: ['displayName', 'callMe', 'honorific', 'pronouns', 'avatar', 'title', 'about', 'nameColor'].map((k) => `profile.${k}`),
  R39: [
    'waifu.name',
    'waifu.series',
    'waifu.relationship',
    'waifu.personality',
    'waifu.formality',
    'waifu.playfulness',
    'waifu.verbosity',
    'waifu.catchphrases',
    'waifu.japanese',
    'waifu.kaomoji',
    'waifu.workVoice',
    'waifu.expressiveness',
    'waifu.customInstructions',
  ],
  R41: [
    'appearance.theme',
    'appearance.accent',
    'appearance.fontSize',
    'appearance.boxOpacity',
    'appearance.background',
    'appearance.petals',
    'appearance.costume',
    'appearance.zoom',
    'appearance.modelsDir',
  ],
  R42: ['textCps', 'punctuationPauses', 'autoDelayMs', 'lipSync', 'idle', 'cursor', 'headpats', 'taps', 'gestures'].map((k) => `motion.${k}`),
  R43: ['claude.model', 'claude.permissionMode', 'claude.defaultDir', 'claude.settingSources'],
  R44: ['enabled', 'key', 'voiceId', 'model', 'language', 'subtitles', 'speed', 'volume', 'styleNotes'].map((k) => `voice.${k}`),
}

const PRESET = {
  id: 'preset-e2e-ram',
  name: 'Ram',
  series: 'Re:Zero',
  notes: 'the older twin',
  createdAt: 1_761_300_000_000,
  profile: {
    summary: "Rem's older twin sister and head maid of the Roswaal mansion.",
    personality: ['blunt', 'proud', 'secretly caring'],
    speechPatterns: ['short, curt sentences', 'refers to herself with quiet pride'],
    catchphrases: ['Hmph.'],
    addressing: 'Mangles the user’s name on purpose; never uses honorifics for him.',
    relationshipCues: ['teases, but always helps in the end'],
    do: ['be blunt', 'praise good work grudgingly'],
    dont: ['gush', 'apologize at length'],
    sampleLines: ['Hmph. That fix was barely adequate. …It works, though.'],
  },
  prompt: 'You are Ram from Re:Zero. Speak curtly and proudly; tease, but get the work done properly.',
  sources: ['https://rezero.fandom.com/wiki/Ram'],
}

const OTHER_PRESET = {
  ...PRESET,
  id: 'preset-e2e-emilia',
  name: 'Emilia',
  notes: '',
  createdAt: PRESET.createdAt + 1,
  prompt: 'You are Emilia from Re:Zero. Speak gently and earnestly; worry a little, and cheer him on.',
  sources: ['https://rezero.fandom.com/wiki/Emilia'],
}

async function openSettings(app) {
  if ((await app.screen()) !== 'settings') {
    await toTitle(app)
    await app.click(T('title-settings'))
    await waitScreen(app, 'settings')
  }
  await app.waitVisible(T('settings-tab'))
}

const tabs = (app) => app.attrs(T('settings-tab'), 'data-tab')

/** Whether a field shows: the hook itself, or the label around a hidden switch checkbox. */
const shows = (app, sel) =>
  app.eval((s) => {
    const el = document.querySelector(s)
    return Boolean(el && (window.__e2e.isVisible(el) || (el.closest('label') && window.__e2e.isVisible(el.closest('label')))))
  }, sel)

/** Clicks through the tabs until `hook` is visible. */
async function showHook(app, hook) {
  await openSettings(app)
  const sel = `#screen-settings ${T(hook)}`
  if (await shows(app, sel)) return
  for (const tab of await tabs(app)) {
    await app.click(T('settings-tab', { tab }))
    await sleep(TAB_SETTLE_MS)
    if (await shows(app, sel)) return
  }
  throw new Error(`no settings tab shows ${hook}`)
}

async function persisted(app, pick, expected) {
  const deadline = Date.now() + PERSIST_MS
  let got
  while (Date.now() < deadline) {
    got = pick(app.readSettingsFile() ?? {})
    if (JSON.stringify(got) === JSON.stringify(expected)) return
    await sleep(PERSIST_POLL_MS)
  }
  throw new Error(`settings.json: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`)
}

export default {
  name: 'Settings: profile, waifu, research, appearance, motion, Claude, voice, dark mode',
  tests: [
    {
      r: ['R38', 'R39', 'R41', 'R42', 'R43', 'R44'],
      name: 'every tab renders its fields',
      async run(ctx) {
        const { app } = ctx
        await openSettings(app)
        const list = await tabs(app)
        assert(list.length >= MIN_TABS, `at least ${MIN_TABS} tabs: ${list}`)
        const hooks = new Set()
        for (const tab of list) {
          await app.click(T('settings-tab', { tab }))
          const shown = await app.waitFor(
            () =>
              [...document.querySelectorAll('#screen-settings [data-test^="set-"], #screen-settings [data-test^="research-"]')]
                .filter((el) => window.__e2e.isVisible(el))
                .map((el) => el.dataset.test),
            { label: `tab ${tab} shows fields` },
          )
          for (const h of shown) hooks.add(h)
          // Styled switches hide their checkbox, so presence counts every hook the tab rendered.
          for (const h of await app.attrs('#screen-settings [data-test^="set-"]', 'data-test')) hooks.add(h)
          await app.screenshot(`settings-${tab}`)
        }
        ctx.hooks = hooks
      },
    },
    ...Object.entries(FIELDS).map(([r, paths]) => ({
      r,
      name: `${r} fields are present`,
      async run({ hooks }) {
        assert(hooks, 'the tab walk ran first')
        const missing = paths.filter((p) => ![...hooks].some((h) => h === `set-${p}` || h.startsWith(`set-${p}.`)))
        assert(!missing.length, `missing ${missing.map((p) => `set-${p}`).join(', ')}`)
      },
    })),
    {
      r: 'R44',
      name: 'voice (V0.5.1): on by default with the Rem voice, but silent until a Fish Audio key is stored',
      async run({ app }) {
        await showHook(app, 'set-voice.enabled')
        assert(await app.eval(() => document.querySelector('#screen-settings [data-test="set-voice.enabled"]').checked), 'on by default')
        eq(await app.value(`#screen-settings ${T('set-voice.voiceId')}`), 'd19e2bd4c7464bd98fa2e67044de9a8b', 'the Rem voice id')
        eq(await app.eval(() => document.querySelector('[data-test="voice-status"]').dataset.state), 'nokey', 'no key: off')
        assert(await app.eval(() => document.querySelector('[data-test="set-voice.test"]').disabled), 'nothing to test without a key')
      },
    },
    {
      r: ['R38', 'R45'],
      name: 'profile: name on my nameplate, honorific in how she calls me (next session)',
      timeout: 60_000,
      async run({ app, project }) {
        await showHook(app, 'set-profile.displayName')
        await setField(app, 'profile.displayName', 'Natsuki Subaru')
        await setField(app, 'profile.callMe', 'Subaru')
        await setField(app, 'profile.honorific', 'sama')
        await app.waitFor(() => window.__wc.store.get().profile.honorific === 'sama', { label: 'honorific stored' })
        await persisted(app, (s) => s.profile?.callMe, 'Subaru')
        await newGame(app, project)
        await fastText(app)
        const m = await say(app, 'hello there')
        await turnEnd(app, m)
        await readAll(app)
        const names = (await app.dialogueLog(m)).map((d) => d.name)
        await app.key('Ctrl+O')
        await app.waitVisible(T('log'))
        const log = (await app.texts(T('log-entry', { who: 'user' }))).join('\n')
        await app.key('Escape')
        assert(names.some((n) => n.includes('Natsuki Subaru')) || log.includes('Natsuki Subaru'), 'my display name is on my lines')
        await app.waitFor(() => window.__e2e.dialogue.some((d) => d.text.includes('Subaru-sama')), { label: 'she calls me Subaru-sama' })
      },
    },
    {
      r: ['R39', 'R45'],
      name: 'waifu: the persona preview follows edits; the name is used in chat; Settings says it applies next session',
      timeout: 60_000,
      async run({ app, project }) {
        await showHook(app, 'set-waifu.name')
        const m = await app.mark()
        await setField(app, 'waifu.name', 'Ram')
        await app.waitSent('persona_preview', {}, m)
        await app.waitFor(() => document.querySelector('[data-test="persona-preview"]')?.textContent.includes('Ram'), {
          timeout: PREVIEW_MS,
          label: 'persona-preview mentions Ram',
        })
        assert(/next session/i.test(await app.stageText()), 'Settings says persona changes apply to the next session')
        await newGame(app, project)
        await fastText(app)
        const s = await say(app, 'hello there')
        await turnEnd(app, s)
        await app.waitFor((f) => window.__e2e.dialogue.slice(f).some((d) => d.name.includes('Ram')), { args: [s.dialogue], label: 'nameplate says Ram' })
        await showHook(app, 'set-waifu.name')
        await setField(app, 'waifu.name', 'Rem')
      },
    },
    {
      r: 'R40',
      name: 'research: form, progress, cancel, result preview, Apply, save as preset',
      timeout: 60_000,
      async run({ app }) {
        await showHook(app, 'research-name')
        await app.setValue(T('research-name'), 'Ram')
        await app.setValue(T('research-series'), 'Re:Zero')
        await app.setValue(T('research-notes'), 'the older twin')
        let m = await app.mark()
        await app.click(T('research-start'))
        // `research` is blocked by the harness (it would spend plan budget); the replies are injected.
        await app.waitSent('research', { name: 'Ram', series: 'Re:Zero', notes: 'the older twin' }, m)
        await app.inject({ t: 'research_progress', text: 'Searching the web for Ram (Re:Zero)…' })
        await app.waitText(T('research-progress'), 'Searching the web', { label: 'progress shown' })
        const cancel = (await app.visible(T('research-cancel'))) ? T('research-cancel') : await byText(app, /cancel|stop/i, '#screen-settings')
        assert(cancel, 'a Cancel button while researching')
        await app.click(cancel)
        await app.waitSent('research_cancel', {}, m)

        m = await app.mark()
        await app.click(T('research-start'))
        await app.waitSent('research', {}, m)
        await app.inject({ t: 'research_progress', text: 'Reading the wiki…' })
        await app.inject({ t: 'research_done', preset: PRESET })
        await app.waitVisible(T('research-result'))
        const result = await app.eval((sel) => {
          const el = document.querySelector(sel)
          const fields = [...el.querySelectorAll('textarea, input, [contenteditable]')]
          return { text: el.textContent + fields.map((f) => f.value ?? '').join('\n'), editable: fields.length > 0 }
        }, T('research-result'))
        assert(result.text.includes('Speak curtly'), 'the result previews the tailored prompt')
        assert(result.editable, 'the result can be edited before applying')
        await app.click(T('research-apply'))
        await app.waitFor((id) => {
          const w = window.__wc.store.get().waifu
          return w.activePreset === id || w.name === 'Ram'
        }, { args: [PRESET.id], label: 'Apply fills in the Waifu tab' })
        await app.click(T('research-save'))
        await app.waitFor(() => window.__wc.store.get().presets.length > 0, { label: 'saved as a preset' })
        await app.waitVisible(T('preset-item'))
        await showHook(app, 'set-waifu.name')
        await setField(app, 'waifu.name', 'Rem')
      },
    },
    {
      r: 'R40',
      name: 'switching between saved presets changes her persona; the hand-written one comes back',
      async run({ app }) {
        const before = (await app.settings()).waifu
        // Stored like research_done + Save would; a test run alone has no presets yet.
        await app.eval(
          (list) =>
            window.__wc.store.update((st) => {
              for (const p of list) if (!st.presets.some((x) => x.id === p.id)) st.presets.push(p)
            }),
          [PRESET, OTHER_PRESET],
        )
        await showHook(app, 'preset-item')
        for (const p of [OTHER_PRESET, PRESET]) {
          const item = T('preset-item', { id: p.id })
          await app.waitVisible(item)
          const hook = `${item} ${T('preset-apply')}`
          const apply = (await app.exists(hook)) ? hook : await byText(app, /apply/i, item)
          assert(apply, `an Apply button on the ${p.name} preset`)
          await app.click(apply)
          await app.waitFor(
            (id, name) => window.__wc.store.get().waifu.activePreset === id && window.__wc.store.get().waifu.name === name,
            { args: [p.id, p.name], label: `${p.name} is the active persona` },
          )
        }
        await persisted(app, (st) => st.waifu?.activePreset, PRESET.id)
        const handwritten = (await app.visible(T('preset-handwritten'))) ? T('preset-handwritten') : await byText(app, /hand-?written/i, '#screen-settings')
        assert(handwritten, 'a way back to the hand-written persona')
        await app.click(handwritten)
        await app.waitFor(() => !window.__wc.store.get().waifu.activePreset, { label: 'no preset active' })
        await app.updateSettings({ waifu: { name: before.name, series: before.series } })
      },
    },
    {
      r: ['R41', 'R45', 'R46'],
      name: 'theme Light / Dark / System and accent apply live and persist',
      async run({ app }) {
        await showHook(app, 'set-appearance.theme')
        await setField(app, 'appearance.theme', 'dark')
        await app.waitFor(() => document.documentElement.dataset.theme === 'dark', { label: 'dark theme' })
        eq(await app.eval(() => document.documentElement.dataset.scene), 'night', 'the backdrop turns night')
        await persisted(app, (s) => s.appearance?.theme, 'dark')
        await setField(app, 'appearance.theme', 'light')
        await app.waitFor(() => document.documentElement.dataset.theme === 'light', { label: 'light theme' })
        await setField(app, 'appearance.theme', 'system')
        await app.waitFor(() => document.documentElement.dataset.theme === (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'), {
          label: 'system theme',
        })
        await showHook(app, 'set-appearance.accent')
        await setField(app, 'appearance.accent', '#e05b8d')
        await app.waitFor(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase() === '#e05b8d', {
          label: 'accent applied',
        })
        await setField(app, 'appearance.theme', 'light')
      },
    },
    {
      r: ['R42', 'R45', 'R27'],
      name: 'text speed and motion toggles apply live and persist',
      async run({ app }) {
        await showHook(app, 'set-motion.textCps')
        await setField(app, 'motion.textCps', 30)
        await app.waitFor(() => window.__wc.store.get().motion.textCps === 30, { label: 'textCps 30 in the store' })
        await persisted(app, (s) => s.motion?.textCps, 30)
        for (const key of ['lipSync', 'idle', 'cursor', 'headpats', 'taps', 'gestures', 'punctuationPauses']) {
          await showHook(app, `set-motion.${key}`)
          await setField(app, `motion.${key}`, false)
          await app.waitFor((k) => window.__wc.store.get().motion[k] === false, { args: [key], label: `${key} off` })
          await setField(app, `motion.${key}`, true)
          await app.waitFor((k) => window.__wc.store.get().motion[k] === true, { args: [key], label: `${key} on` })
        }
      },
    },
    {
      r: 'R43',
      name: 'Claude defaults: model and permission mode persist',
      async run({ app }) {
        await showHook(app, 'set-claude.permissionMode')
        await setField(app, 'claude.permissionMode', 'acceptEdits')
        await persisted(app, (s) => s.claude?.permissionMode, 'acceptEdits')
        await setField(app, 'claude.permissionMode', 'default')
        await showHook(app, 'set-claude.model')
        await setField(app, 'claude.model', 'sonnet')
        await persisted(app, (s) => s.claude?.model, 'sonnet')
        await setField(app, 'claude.model', '')
      },
    },
    {
      r: 'R46',
      name: 'dark mode themes every screen and overlay',
      timeout: 120_000,
      async run({ app, project }) {
        await app.updateSettings({ appearance: { theme: 'dark' } })
        await app.waitFor(() => document.documentElement.dataset.theme === 'dark', { label: 'dark theme' })
        const bright = {}
        const check = async (name) => {
          await sleep(THEME_SETTLE_MS)
          await app.screenshot(`dark-${name}`)
          const list = await brightSurfaces(app)
          if (list.length) bright[name] = list
        }
        await toTitle(app)
        await check('title')
        await app.click(T('title-load'))
        await waitScreen(app, 'saves')
        await check('saves')
        await toTitle(app)
        await app.click(T('title-settings'))
        await waitScreen(app, 'settings')
        for (const tab of await tabs(app)) {
          await app.click(T('settings-tab', { tab }))
          await check(`settings-${tab}`)
        }
        await newGame(app, project)
        await fastText(app)
        await check('chat')
        for (const [opener, hook] of [['qm-log', 'log'], ['qm-costume', 'costume-picker']]) {
          await app.click(T(opener))
          await app.waitVisible(T(hook))
          await check(`chat-${hook}`)
          await app.key('Escape')
          await app.waitHidden(T(hook))
        }
        const m = await say(app, 'ask permission to edit')
        await app.waitVisible(T('ask'), 20_000)
        await check('chat-permission')
        await app.click(T('ask-option', { v: 'deny' }))
        await turnEnd(app, m)
        await app.updateSettings({ appearance: { theme: 'light' } })
        assert(!Object.keys(bright).length, `bright surfaces in dark mode: ${JSON.stringify(bright)}`)
      },
    },
  ],
}
