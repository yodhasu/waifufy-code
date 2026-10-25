// Her voice (docs/V0.5.md R71–R73): off without a Fish Audio key; with one, each paragraph's Japanese line is
// spoken, the text and the subtitle follow the audio clock, and her mouth follows the clip's loudness.
// The mock link synthesizes a pulsing tone whose length follows the line (link/src/tts.ts mockClip).
import { assert, eq, newGame, readAll, say, sleep, T, turnEnd } from '../lib.mjs'

const MOCK_LINE = /^はい、レムにお任せください。\d+$/
const VOICE_MS = 15_000

const status = (app) => app.eval(() => document.querySelector('[data-test="voice-status"]')?.dataset.state)

async function openVoiceTab(app) {
  await app.go('settings')
  await app.waitVisible('[data-tab="voice"]')
  await app.click('[data-tab="voice"]')
  await app.waitVisible(T('voice-status'))
}

export default {
  name: 'Voice: Fish Audio key, Japanese lines, text and lips in sync with the audio',
  tests: [
    {
      r: 'R71',
      name: 'with no key stored she stays silent: the tab says why, and no clip is ever asked for',
      timeout: 60_000,
      async run({ app, project }) {
        await openVoiceTab(app)
        eq(await status(app), 'nokey', 'status without a key')
        assert(await app.eval(() => document.querySelector('[data-test="set-voice.enabled"]').checked), 'voice is on by default')
        eq(await app.value(T('set-voice.voiceId')), 'd19e2bd4c7464bd98fa2e67044de9a8b', 'the Rem voice is the default')
        await newGame(app, project)
        const m = await say(app, 'hello there')
        await turnEnd(app, m)
        await readAll(app)
        eq((await app.sent(m, 'tts')).length, 0, 'no tts request')
        eq((await app.events(m, 'voice')).length, 0, 'no voice lines without a key')
      },
    },
    {
      r: 'R71',
      name: 'saving a key turns her voice on; the key never appears in settings',
      timeout: 30_000,
      async run({ app }) {
        await openVoiceTab(app)
        await app.click(T('set-voice.key'))
        await app.type('fish-test-key-123')
        await app.click(T('set-voice.key-save'))
        await app.waitFor(() => document.querySelector('[data-test="voice-status"]').dataset.state === 'on', { label: 'status on' })
        eq(await app.value(T('set-voice.key')), '', 'the field is cleared')
        const s = await app.settings()
        assert(!JSON.stringify(s).includes('fish-test-key-123'), 'the key is not in settings')
      },
    },
    {
      r: 'R72',
      name: 'each paragraph speaks its Japanese line: text, subtitle and her mouth follow the clip',
      timeout: 90_000,
      async run({ app, project }) {
        await newGame(app, project)
        // A slow typewriter: a voiced page must follow the audio, not this.
        await app.updateSettings({ motion: { textCps: 2 } })
        const m = await say(app, 'show me your emotions')
        const line = await app.waitEvent('voice', {}, m)
        assert(MOCK_LINE.test(line.text), `a Japanese line: ${line.text}`)
        const tts = await app.waitSent('tts', {}, m)
        assert(MOCK_LINE.test(tts.text), 'the line is what gets synthesized')
        await app.waitFor(() => document.querySelector('[data-test="dialogue"]').dataset.voice === 'playing', { timeout: VOICE_MS, label: 'voice playing' })
        assert(await app.eval(() => document.getElementById('chara').dataset.voice === '1'), 'her mouth follows the voice')
        // Mid-clip: part of the page and part of the subtitle are out, neither all.
        await sleep(500)
        const mid = await app.eval(() => {
          const d = document.querySelector('[data-test="dialogue"]')
          return { text: d.querySelector('[data-test="dialogue-text"]').textContent, ja: d.querySelector('[data-test="dialogue-ja"]') }
        })
        const ja = await app.eval(() => {
          const el = document.querySelector('[data-test="dialogue-ja"]')
          return { hidden: el.hidden, text: el.textContent }
        })
        assert(!ja.hidden && ja.text.length > 0, `the subtitle shows: "${ja.text}"`)
        await app.screenshot('voice/playing')
        assert(mid.text.length > 0, 'text is coming out')
        // At 2 chars/s the page would take tens of seconds; with the voice it ends with the clip (~2 s).
        await app.waitFor(() => !document.querySelector('[data-test="dialogue"]').dataset.voice, { timeout: VOICE_MS, label: 'the clip ends' })
        const page = await app.eval(() => document.querySelector('[data-test="dialogue-text"]').textContent)
        assert(page.length > mid.text.length, `the page completed with the voice (${mid.text.length} → ${page.length} chars)`)
        eq(await app.eval(() => document.getElementById('chara').dataset.voice), '0', 'mouth handed back')
        await turnEnd(app, m)
        await app.updateSettings({ motion: { textCps: 0 } })
        await readAll(app)
      },
    },
    {
      r: 'R73',
      name: 'turning the page cuts her line; Focus mode keeps her quiet',
      timeout: 90_000,
      async run({ app, project }) {
        await newGame(app, project)
        await app.updateSettings({ motion: { textCps: 2 } })
        const m = await say(app, 'show me your emotions')
        await app.waitFor(() => document.querySelector('[data-test="dialogue"]').dataset.voice === 'playing', { timeout: VOICE_MS, label: 'voice playing' })
        // First click finishes the text (the voice runs on), the second turns the page and cuts it.
        await app.click(T('dialogue'))
        await app.waitFor(() => document.querySelector('[data-test="dialogue-advance"]').classList.contains('show'), { timeout: VOICE_MS, label: 'a next page' })
        const before = (await app.sent(m, 'tts')).length
        await app.click(T('dialogue'))
        await sleep(200)
        const v = await app.eval(() => document.querySelector('[data-test="dialogue"]').dataset.voice ?? '')
        assert(v === 'waiting' || v === 'playing', `the next paragraph speaks its own line (${v})`)
        assert((await app.sent(m, 'tts')).length >= before, 'its clip was asked for')
        await turnEnd(app, m)
        await app.updateSettings({ motion: { textCps: 0 } })
        await readAll(app)
        await app.key('Ctrl+Shift+F')
        await app.waitFor(() => document.documentElement.dataset.focus === '1', { label: 'focus on' })
        const f = await say(app, 'show me your emotions')
        await turnEnd(app, f)
        await sleep(300)
        eq(await app.eval(() => document.querySelector('[data-test="dialogue"]').dataset.voice ?? ''), '', 'no voice in Focus mode')
        await app.key('Ctrl+Shift+F')
        await readAll(app)
      },
    },
    {
      r: 'R71',
      name: 'a key Fish refuses: one toast, a LOG line, and the text goes on unvoiced',
      timeout: 60_000,
      async run({ app, project }) {
        await openVoiceTab(app)
        await app.click(T('set-voice.key'))
        await app.type('mock-fail')
        await app.click(T('set-voice.key-save'))
        // Another speed is another clip: the link's cache holds the earlier tests' lines.
        await app.updateSettings({ voice: { speed: 1.05 } })
        await newGame(app, project)
        const m = await say(app, 'show me your emotions')
        await app.waitText('#toast', /voice is unavailable: Fish Audio rejected the API key/, { label: 'the voice toast' })
        await turnEnd(app, m)
        await readAll(app)
        const page = await app.eval(() => document.querySelector('[data-test="dialogue-text"]').textContent)
        assert(page.length > 0, 'her text still shows')
        await app.key('Ctrl+O')
        await app.waitVisible(T('log'))
        assert((await app.texts(T('log-entry'))).some((t) => /Voice: Fish Audio rejected/.test(t)), 'the LOG says why')
        await app.key('Escape')
        await app.updateSettings({ voice: { speed: 1 } })
      },
    },
    {
      r: 'R71',
      name: 'removing the key turns her silent again',
      timeout: 30_000,
      async run({ app }) {
        await openVoiceTab(app)
        await app.click(T('set-voice.key-remove'))
        await app.waitFor(() => document.querySelector('[data-test="voice-status"]').dataset.state === 'nokey', { label: 'status nokey' })
        await app.go('title')
      },
    },
  ],
}
