// The Config screen (R38–R46): tabs on the left, the live character on the right reacting to every change,
// and a preview dialogue box under her that shows text size, opacity and speed as they are tuned.
// Every field is bound by its dotted settings path (`data-bind`), so one handler writes all of them through
// the store, and sync() paints the whole screen back from the store after each change.

import type {
  Appearance, CardSummary, ClaudeSettings, Costume, Emotion, MotionSettings, PersonaPreset, Profile, RemoteStatus, ResearchProfile, ServerMsg, Settings, Waifu,
} from '../../../link/src/protocol.ts'
import qrcode from 'qrcode-generator'
import { AFFECTION_LEVELS } from '../../../link/src/affection.ts'
import { addressOf } from '../../../link/src/address.ts'
import { DEFAULT_VOICE_ID, REM_VOICE_STYLE } from '../../../link/src/voice-style.ts'
import { SLACK_MANIFEST, SLACK_REDIRECT_URL } from '../../../link/src/slack-app.ts'
import type { Ctx, Screen } from '../contracts'
import { clearPairing, savedPairing } from '../pair'
import { lowSpec, setLowSpec } from '../lowspec'
import { esc } from '../ui'
import { CUSTOM_PERSONALITY, PERSONALITIES, personalityById } from './personas'
import './settings.css'

// ---------------------------------------------------------------- data

const TABS = [
  { id: 'cards', label: 'Cards', icon: '❖', blurb: 'Waifu cards: each one is a whole character, with her persona, model, voice and love meter. Swap between sessions.' },
  { id: 'you', label: 'You', icon: '♡', blurb: 'Who you are to her: your name, how she addresses you, your nameplate.' },
  { id: 'waifu', label: 'Waifu', icon: '✿', blurb: 'Her name, personality and way of speaking.' },
  { id: 'roleplay', label: 'Roleplay', icon: '✦', blurb: 'Research any character and turn them into a persona preset.' },
  { id: 'appearance', label: 'Appearance', icon: '❀', blurb: 'Theme, colors, the dialogue box, the scene and her costume.' },
  { id: 'motion', label: 'Text & Motion', icon: '♪', blurb: 'How fast she talks and how alive she feels.' },
  { id: 'claude', label: 'Claude', icon: '⚙', blurb: 'Defaults for new sessions, passed straight to Claude Code.' },
  { id: 'casual', label: 'Casual', icon: '♡', blurb: 'Casual mode: her own chat harness, its model, her memory and how she learns.' },
  { id: 'voice', label: 'Voice', icon: '♫', blurb: 'Her spoken voice through Fish Audio, in sync with the text and her lips.' },
  { id: 'slack', label: 'Slack', icon: '✉', blurb: 'Your unread Slack messages in the chat, and Slack tools for her.' },
  { id: 'phone', label: 'Phone', icon: '☏', blurb: 'Chat with her from your Android phone while Claude Code keeps working here.' },
  { id: 'about', label: 'About', icon: '❦', blurb: 'Version, your data, and credits.' },
] as const
type TabId = (typeof TABS)[number]['id']

/**
 * The defaults from link/src/settings.ts, which can't be imported into the app (it uses node:fs).
 * Keep in sync. `appearance.modelsDir` is left out: its default is resolved on the link side.
 */
const DEFAULTS: {
  profile: Profile
  waifu: Waifu
  appearance: Omit<Appearance, 'modelsDir'>
  motion: MotionSettings
  claude: ClaudeSettings
  voice: Settings['voice']
  casual: Settings['casual']
} = {
  profile: {
    displayName: 'Master', callMe: 'Master', honorific: 'kun', customHonorific: '', pronouns: 'he/him', title: 'Developer', about: '',
    avatar: '', nameColor: '#c9973f',
  },
  waifu: {
    name: 'Rem',
    series: 'Re:Zero − Starting Life in Another World',
    relationship: 'maid',
    relationshipCustom: '',
    personalityPreset: 'devoted',
    personality: personalityById('devoted')!.text,
    formality: 60,
    playfulness: 40,
    verbosity: 45,
    catchphrases: [],
    japanese: true,
    kaomoji: false,
    workVoice: 'full',
    expressiveness: 'normal',
    customInstructions: '',
    activePreset: '',
  },
  appearance: {
    theme: 'system', accent: '#5b8de0', fontSize: 21, boxOpacity: 0.94, background: 'auto', petals: true, costume: 'ac_base_rem01', zoom: 1,
    model: 'live2d', mmdFile: '',
  },
  motion: {
    textCps: 14, punctuationPauses: true, autoDelayMs: 1200, lipSync: true, idle: true, cursor: true, headpats: true, taps: true, gestures: true,
  },
  claude: { model: '', permissionMode: 'default', defaultDir: '', settingSources: ['user', 'project', 'local'] },
  voice: {
    enabled: true, voiceId: DEFAULT_VOICE_ID, model: 's2.1-pro-free', language: 'ja', speed: 1, volume: 80, subtitles: true,
    styleNotes: REM_VOICE_STYLE, pronunciations: '',
  },
  casual: {
    provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-luna', reasoningEffort: 'none', claudeModel: 'sonnet',
    toolModel: 'haiku', shareWork: true, learning: true, idleMin: 60, judgeThreshold: 7, learnWith: 'claude', toWork: 'ask', initiative: true, boundaries: '',
  },
}

/** What "Reset section to defaults" restores on each tab. Roleplay and About hold nothing to reset. */
const RESET: Partial<Record<TabId, (s: Settings) => void>> = {
  you: (s) => void (s.profile = structuredClone(DEFAULTS.profile)),
  waifu: (s) => void (s.waifu = structuredClone(DEFAULTS.waifu)),
  appearance: (s) => void (s.appearance = { ...structuredClone(DEFAULTS.appearance), modelsDir: s.appearance.modelsDir, mmdFile: s.appearance.mmdFile }),
  voice: (s) => void (s.voice = structuredClone(DEFAULTS.voice)),
  casual: (s) => void (s.casual = structuredClone(DEFAULTS.casual)),
  motion: (s) => void (s.motion = structuredClone(DEFAULTS.motion)),
  claude: (s) => void (s.claude = structuredClone(DEFAULTS.claude)),
}

type Opt = { v: string; label: string; hint?: string }

const HONORIFICS: Opt[] = [
  { v: 'kun', label: '-kun', hint: 'Warm and familiar, usually for boys' },
  { v: 'sama', label: '-sama', hint: 'Deep respect: "my lord"' },
  { v: 'chan', label: '-chan', hint: 'Cute and affectionate' },
  { v: 'san', label: '-san', hint: 'Polite, neutral' },
  { v: 'senpai', label: '-senpai', hint: 'You are her senior' },
  { v: 'dono', label: '-dono', hint: 'Old-fashioned, samurai-polite' },
  { v: 'none', label: 'none', hint: 'Just your name' },
  { v: 'custom', label: 'custom…', hint: 'Write your own' },
]

const RELATIONSHIPS: Opt[] = [
  { v: 'maid', label: 'Maid & master' },
  { v: 'childhood', label: 'Childhood friend' },
  { v: 'senpai', label: 'Senpai', hint: 'She is your senior' },
  { v: 'kouhai', label: 'Kouhai', hint: 'She looks up to you' },
  { v: 'partner', label: 'Partner' },
  { v: 'rival', label: 'Rival' },
  { v: 'custom', label: 'Custom…' },
]

const RELATIONSHIP_LINES: Record<string, string> = {
  maid: 'I am your maid, {you}. Please rely on me for anything.',
  childhood: 'We\'ve known each other forever, {you}. Of course I\'ll help!',
  senpai: 'Leave it to your senpai, {you}. Watch and learn.',
  kouhai: 'I\'ll do my very best, {you}! Please watch over me!',
  partner: 'Let\'s build this together, {you}. Side by side.',
  rival: 'Hmph. Try to keep up with me, {you}.',
  custom: 'Whatever we are to each other, I\'m with you, {you}.',
}

const WORK_VOICES: Opt[] = [
  { v: 'full', label: 'Full', hint: 'In character everywhere, even in reports, summaries and code explanations.' },
  { v: 'balanced', label: 'Balanced', hint: 'In character in chat; reports and explanations are plain with a light touch of her voice.' },
  { v: 'work', label: 'Work mode', hint: 'Plain, professional output. Her character shows only in short asides and her expressions.' },
]

const EXPRESSIVENESS: Opt[] = [
  { v: 'low', label: 'Low', hint: 'A tag now and then; calm, steady poses.' },
  { v: 'normal', label: 'Normal', hint: 'One emotion per paragraph.' },
  { v: 'high', label: 'High', hint: 'Several emotions per paragraph; she reacts to everything.' },
]

const MODEL_KINDS: Opt[] = [
  { v: 'live2d', label: 'Live2D', hint: 'A 2D rigged costume from the models folder below' },
  { v: 'mmd', label: '3D (MMD)', hint: 'A .pmx model, with MMD shading and physics' },
]

const THEMES: Opt[] = [
  { v: 'light', label: '☀ Light' },
  { v: 'dark', label: '☾ Dark' },
  { v: 'system', label: '◐ System' },
]

const BACKGROUNDS: Opt[] = [
  { v: 'day', label: 'Day' },
  { v: 'night', label: 'Night' },
  { v: 'auto', label: 'Follow theme' },
]

const ACCENTS: Opt[] = [
  { v: '#5b8de0', label: 'Ice blue' },
  { v: '#e58fb1', label: 'Sakura pink' },
  { v: '#9c86dc', label: 'Lavender' },
  { v: '#d4ad5c', label: 'Gold' },
  { v: '#3fae84', label: 'Mint' },
  { v: '#d9536f', label: 'Crimson' },
  { v: '#4fb3d9', label: 'Sky' },
  { v: '#6c7a96', label: 'Slate' },
]

const NAME_COLORS: Opt[] = [
  { v: '#c9973f', label: 'Gold' },
  { v: '#5b8de0', label: 'Blue' },
  { v: '#e58fb1', label: 'Pink' },
  { v: '#9c86dc', label: 'Lavender' },
  { v: '#3fae84', label: 'Mint' },
  { v: '#d9536f', label: 'Crimson' },
  { v: '#e08a3c', label: 'Amber' },
  { v: '#4a5578', label: 'Ink' },
]

const MODEL_ALIASES: Opt[] = [
  { v: '', label: 'CLI default' },
  { v: 'opus', label: 'Opus' },
  { v: 'sonnet', label: 'Sonnet' },
  { v: 'haiku', label: 'Haiku' },
  { v: 'fable', label: 'Fable' },
]
const CUSTOM_MODEL = 'custom'

const PERMISSION_MODES: Opt[] = [
  { v: 'default', label: 'Default', hint: 'Asks before edits and commands, like the CLI.' },
  { v: 'acceptEdits', label: 'Accept edits', hint: 'Edits files without asking; still asks before commands.' },
  { v: 'plan', label: 'Plan', hint: 'Read-only: she investigates and proposes a plan first.' },
  { v: 'auto', label: 'Auto', hint: 'The model decides what is safe to run, where supported.' },
  { v: 'bypassPermissions', label: 'Bypass permissions', hint: 'Never asks. Dangerous: only for sandboxes.' },
]

const SETTING_SOURCES: { v: 'user' | 'project' | 'local'; label: string; hint: string }[] = [
  { v: 'user', label: 'User', hint: '~/.claude: your global settings, CLAUDE.md, commands, skills and agents.' },
  { v: 'project', label: 'Project', hint: '.claude/settings.json and CLAUDE.md checked into the repo.' },
  { v: 'local', label: 'Local', hint: '.claude/settings.local.json: your private overrides for the repo.' },
]

const MOTION_TOGGLES: { path: keyof MotionSettings; label: string; hint: string; off: string; on: string }[] = [
  { path: 'lipSync', label: 'Lip sync', hint: 'Her mouth moves while the text is typing.', on: 'Mm-hm, I\'ll move my lips again.', off: '…I\'ll talk with my mouth closed, then.' },
  { path: 'idle', label: 'Idle motions', hint: 'Small poses every few seconds while she waits.', on: 'I won\'t stand still anymore!', off: 'I\'ll stand very, very still.' },
  { path: 'cursor', label: 'Cursor tracking', hint: 'Her head and eyes follow your cursor.', on: 'I\'ll keep my eyes on you, {you}.', off: 'I won\'t look… promise.' },
  { path: 'headpats', label: 'Headpats', hint: 'Press and drag across her head.', on: 'Headpats are allowed again… ehehe.', off: 'No more headpats? Hmph.' },
  { path: 'taps', label: 'Tap reactions', hint: 'Clicking her face or body gets a reaction.', on: 'You can poke me again. Gently!', off: 'No poking, then.' },
  { path: 'gestures', label: 'Event gestures', hint: 'Reacts to permission prompts, risky commands, pushes and errors.', on: 'I\'ll react to everything again!', off: 'I\'ll keep a calm face while we work.' },
]

const TAB_LINES: Record<TabId, [string, Emotion]> = {
  cards: ['Someone new, {you}? …I\'ll be right here in my card when you come back.', 'pout'],
  you: ['Tell me about yourself, {you}. I want to know everything.', 'smile'],
  waifu: ['Is this… about me? Please be gentle, {you}.', 'shy'],
  roleplay: ['Shall I study someone new? Just tell me who, {you}.', 'think'],
  appearance: ['How do I look, {you}?', 'shy'],
  motion: ['Is this pace comfortable, {you}? I can speak faster… or slower, just for you.', 'smile'],
  claude: ['These go straight to Claude Code. I\'ll use them from the next session.', 'nod'],
  casual: ['Just the two of us, talking about anything… I\'d like that, {you}.', 'shy'],
  voice: ['My voice… is still a secret. Soon, {you}!', 'shy'],
  slack: ['I can keep an eye on your messages, {you}. I\'ll only send what you approve.', 'nod'],
  phone: ['Take me with you, {you}? I\'ll keep working here while you\'re away.', 'shy'],
  about: ['Thank you for choosing me, {you}.', 'happy'],
}
const SPEED_SAMPLE = 'Ah, {you}! Is this pace comfortable? I can speak faster, slower… or all at once, if you like.'

const LIST_FIELDS = ['personality', 'speechPatterns', 'catchphrases', 'relationshipCues', 'do', 'dont', 'sampleLines'] as const
type ListField = (typeof LIST_FIELDS)[number]
const LIST_LABELS: Record<ListField, string> = {
  personality: 'Personality', speechPatterns: 'Speech patterns', catchphrases: 'Catchphrases', relationshipCues: 'Relationship cues',
  do: 'Do', dont: 'Don\'t', sampleLines: 'Sample lines',
}

// R27: speech pace, its slider range, and the punctuation pauses the chat typewriter uses.
const CPS_SPEECH = 14
const CPS_MIN = 6
const CPS_MAX = 60
/** The slider's last notch stands for "instant" (textCps 0). */
const CPS_INSTANT_NOTCH = CPS_MAX + 1
const PAUSE_COMMA_MS = 180
const PAUSE_STOP_MS = 420
const CHARS_PER_WORD = 5.5

const AVATAR_PX = 256
/** Portraits are cropped from a bit above center, where faces usually are. */
const AVATAR_FOCUS_Y = 0.3
const AVATAR_QUALITY = 0.92
const MAX_CATCHPHRASES = 12
const MAX_CATCHPHRASE_LEN = 60
const PREVIEW_DEBOUNCE_MS = 450
/** Reactions to changes stay at least this far apart, so dragging through options doesn't make her twitch. */
const REACT_GAP_MS = 900
const MAX_LOG_LINES = 300
const CLOCK_MS = 1000
/** What Chromium reports as the key while an IME is composing. */
const IME_KEYCODE = 229
const MS_PER_S = 1000
const S_PER_MIN = 60
/** How long a reveal waits for the link's app_error (a missing folder) before assuming Explorer opened. */
const REVEAL_WAIT_MS = 1500
/** How long after a card request an app_error is taken as its refusal. */
const CARD_REPLY_MS = 3000
/**
 * "Use default" stores an empty models folder, and the link resolves an empty folder from settings.json, which the
 * store writes 400 ms after the last change. The costumes request waits until that save has landed.
 */
const SAVE_SETTLE_MS = 900
/** What the link's research_error says for a run this screen cancelled. */
const RESEARCH_CANCELLED = 'Research cancelled.'

// Slider ranges (zoom is the range documented in protocol.ts) and field lengths.
const SLIDER_MAX = 100
const SLIDER_STEP = 5
const FONT_MIN = 16
const FONT_MAX = 30
const OPACITY_MIN = 0.5
const OPACITY_MAX = 1
const OPACITY_STEP = 0.02
const ZOOM_MIN = 0.6
const ZOOM_MAX = 2.5
const ZOOM_STEP = 0.05
const AUTO_DELAY_MAX_MS = 5000
const AUTO_DELAY_STEP_MS = 100
const USER_NAME_MAX_LEN = 40
const CHARACTER_NAME_MAX_LEN = 80
const SERIES_MAX_LEN = 120
const HONORIFIC_MAX_LEN = 20
const PRONOUNS_MAX_LEN = 30
const TITLE_MAX_LEN = 60
const RELATIONSHIP_MAX_LEN = 120
const ABOUT_MAX_LEN = 2000
const PERSONALITY_MAX_LEN = 2000
const INSTRUCTIONS_MAX_LEN = 4000
const NOTES_MAX_LEN = 600

// ---------------------------------------------------------------- helpers

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement

function getAt(s: Settings, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], s)
}

function setAt(s: Settings, path: string, v: unknown) {
  const keys = path.split('.')
  const last = keys.pop()!
  const parent = keys.reduce<Record<string, unknown>>((o, k) => o[k] as Record<string, unknown>, s as unknown as Record<string, unknown>)
  parent[last] = v
}

const band = (v: number, labels: string[]) => labels[Math.min(labels.length - 1, Math.floor((v / SLIDER_MAX) * labels.length))]

const FORMAT: Record<string, (v: number) => string> = {
  'waifu.formality': (v) => band(v, ['Very casual', 'Casual', 'Polite', 'Formal', 'Very formal']),
  'waifu.playfulness': (v) => band(v, ['Serious', 'Composed', 'Warm', 'Playful', 'Mischievous']),
  'waifu.verbosity': (v) => band(v, ['Terse', 'Brief', 'Balanced', 'Chatty', 'Very chatty']),
  'appearance.fontSize': (v) => `${v}px`,
  'appearance.boxOpacity': (v) => `${Math.round(v * 100)}%`,
  'appearance.zoom': (v) => `${v.toFixed(2)}×`,
  'motion.textCps': (v) =>
    v === 0 ? 'Instant' : `${v} chars/s · ≈${Math.round((v * S_PER_MIN) / CHARS_PER_WORD)} wpm${v === CPS_SPEECH ? ' · speech pace' : ''}`,
  'motion.autoDelayMs': (v) => `${(v / MS_PER_S).toFixed(1)} s`,
  'voice.speed': (v) => `${v.toFixed(2)}×`,
  'voice.volume': (v) => `${v}%`,
}

const VOICE_MODEL_OPTS: Opt[] = [
  { v: 's2.1-pro-free', label: 'Free', hint: 'Fish Audio\'s free developer tier: fair use, best effort, no latency guarantee.' },
  { v: 's2.1-pro', label: 'Paid', hint: 'The same model with an SLA: about $15 per million bytes of text (thousands of lines).' },
]
const VOICE_LANGS: Opt[] = [
  { v: 'ja', label: 'Japanese', hint: 'The text stays English; she speaks a Japanese line for each paragraph.' },
  { v: 'en', label: 'English', hint: 'She reads her own lines aloud.' },
]
/** The Test voice line in each language. */
const VOICE_SAMPLE = {
  ja: 'はい、レムです。今日も一緒に頑張りましょうね。',
  en: 'Hello, {you}. This is my voice. Shall we get to work?',
}

/** Settings value ⇄ slider position, for sliders whose scale isn't the stored value. */
const CONVERTERS: Record<string, { toInput(v: number): number; fromInput(n: number): number }> = {
  cps: { toInput: (v) => (v === 0 ? CPS_INSTANT_NOTCH : v), fromInput: (n) => (n >= CPS_INSTANT_NOTCH ? 0 : n) },
}

const sameValue = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const isHexColor = (c: string) => /^#[0-9a-f]{6}$/i.test(c)
/** Folder paths compared the way the link resolves them: either slash, no trailing separator, any case. */
const samePath = (a: string, b: string) => sameValue(a.replace(/[\\/]+/g, '/').replace(/\/$/, ''), b.replace(/[\\/]+/g, '/').replace(/\/$/, ''))
const isAbsolutePath = (p: string) => /^([a-z]:)?[\\/]/i.test(p)
const stripTags = (line: string) => line.replace(/\[[a-z]+\]\s*/gi, '').trim()

function shortUrl(u: string) {
  try {
    const url = new URL(u)
    return url.hostname.replace(/^www\./, '') + (url.pathname.length > 1 ? decodeURIComponent(url.pathname) : '')
  } catch {
    return u
  }
}

async function cropAvatar(dataUrl: string) {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const side = Math.min(img.naturalWidth, img.naturalHeight)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = AVATAR_PX
  const g = canvas.getContext('2d')!
  g.imageSmoothingQuality = 'high'
  const sx = (img.naturalWidth - side) / 2
  const sy = (img.naturalHeight - side) * AVATAR_FOCUS_Y
  g.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_PX, AVATAR_PX)
  return canvas.toDataURL('image/webp', AVATAR_QUALITY)
}

// ---------------------------------------------------------------- templates

function row(label: string, control: string, hint = '', extra = '') {
  return `<div class="set-row" ${extra}><div class="set-label">${label}${hint ? `<small>${hint}</small>` : ''}</div><div class="set-control">${control}</div></div>`
}

const text = (path: string, attrs = '') => `<input class="field" type="text" data-test="set-${path}" data-bind="${path}" spellcheck="false" ${attrs}>`

const area = (path: string, rows: number, attrs = '') =>
  `<textarea class="field" data-test="set-${path}" data-bind="${path}" rows="${rows}" ${attrs}></textarea>`

function range(path: string, min: number, max: number, step: number, conv = '', marks = '') {
  return `<div class="set-range">
    <input type="range" min="${min}" max="${max}" step="${step}" data-test="set-${path}" data-bind="${path}" ${conv ? `data-conv="${conv}"` : ''}>
    <output data-out="${path}"></output>${marks}
  </div>`
}

function toggle(path: string, label: string, hint: string) {
  return `<label class="set-toggle"><input type="checkbox" data-test="set-${path}" data-bind="${path}"><i></i>
    <span><b>${label}</b><small>${hint}</small></span></label>`
}

/** A choice group: buttons with `data-v`; `data-value` on the group mirrors the setting (for tests and CSS). */
function seg(path: string, opts: Opt[], variant: 'row' | 'list' | 'swatch' = 'row', test = `set-${path}`) {
  const body = opts
    .map((o) => {
      if (variant === 'swatch') return `<button type="button" data-v="${esc(o.v)}" title="${esc(o.label)}" style="--sw: ${esc(o.v)}"></button>`
      if (variant === 'list') return `<button type="button" data-v="${esc(o.v)}"><b>${o.label}</b><small>${o.hint ?? ''}</small></button>`
      return `<button type="button" data-v="${esc(o.v)}" ${o.hint ? `title="${esc(o.hint)}"` : ''}>${o.label}</button>`
    })
    .join('')
  return `<div class="set-seg ${variant}" data-test="${test}" data-seg="${path}">${body}</div>`
}

const card = (title: string, body: string, cls = '', attrs = '') => `<section class="set-card ${cls}" ${attrs}><h4>${title}</h4>${body}</section>`

const note = (html: string) => `<p class="set-note">${html}</p>`

function youPane() {
  return `<div class="set-cols">
    ${card(
      'Identity',
      row('Display name', text('profile.displayName', `maxlength="${USER_NAME_MAX_LEN}"`), 'On your nameplate') +
        row('She calls you', text('profile.callMe', `maxlength="${USER_NAME_MAX_LEN}"`), 'Before the honorific') +
        row(
          'Honorific',
          seg('profile.honorific', HONORIFICS) +
            text('profile.customHonorific', `maxlength="${HONORIFIC_MAX_LEN}" placeholder="e.g. -oniichan" data-when="profile.honorific=custom"`),
        ) +
        `<div class="set-address" data-test="address-preview"></div>` +
        row('Pronouns', text('profile.pronouns', `list="set-pronouns" maxlength="${PRONOUNS_MAX_LEN}"`)) +
        row('Title / role', text('profile.title', `list="set-titles" maxlength="${TITLE_MAX_LEN}"`), 'She knows what you do') +
        `<datalist id="set-pronouns"><option value="he/him"><option value="she/her"><option value="they/them"></datalist>
        <datalist id="set-titles"><option value="Developer"><option value="Senior Engineer"><option value="Student"><option value="Founder">
          <option value="Hacker"><option value="Data Scientist"><option value="Game Developer"></datalist>`,
    )}
    ${card(
      'Portrait & nameplate',
      `<div class="set-avatar-row">
        <div class="set-avatar" data-test="avatar-preview"></div>
        <div class="set-avatar-actions">
          <button class="btn" type="button" data-act="avatar-pick" data-test="set-profile.avatar">Choose image…</button>
          <button class="btn" type="button" data-act="avatar-remove" data-test="set-profile.avatar-remove">Remove</button>
          <small>Cropped to a ${AVATAR_PX}px square.</small>
        </div>
      </div>` +
        row(
          'Nameplate',
          `<div class="set-colorline">${seg('profile.nameColor', NAME_COLORS, 'swatch', 'set-profile.nameColor-swatches')}
          <input type="color" data-test="set-profile.nameColor" data-bind="profile.nameColor" title="Any color"></div>`,
        ) +
        `<div class="set-plate-sample" data-test="nameplate-sample">
          <div class="set-plate user"><span class="set-plate-av" data-plate-av></span><b data-plate-name></b></div>
          <p data-plate-line></p>
        </div>`,
    )}
    ${card(
      'About you',
      area('profile.about', 5, `maxlength="${ABOUT_MAX_LEN}" placeholder="Your stack, your projects, how you like to work, what makes you smile…"`) +
        note('She reads this at the start of every session. Persona changes apply from the next session.'),
      'wide',
    )}
  </div>`
}

function waifuPane() {
  const presetCards = [
    ...PERSONALITIES.map((p) => ({ v: p.id, label: p.label, jp: p.jp, blurb: p.blurb })),
    { v: CUSTOM_PERSONALITY, label: 'Custom', jp: '自由', blurb: 'Your own words, kept as you write them.' },
  ]
    .map((p) => `<button type="button" data-v="${p.v}"><b>${esc(p.label)}</b><i>${p.jp}</i><small>${esc(p.blurb)}</small></button>`)
    .join('')
  return `<div class="set-cols">
    <p class="set-note set-banner wide" data-test="persona-active"></p>
    ${card(
      'Character',
      row('Name', text('waifu.name', `maxlength="${CHARACTER_NAME_MAX_LEN}"`)) +
        row('Series', text('waifu.series', `maxlength="${SERIES_MAX_LEN}"`)) +
        row(
          'Relationship',
          seg('waifu.relationship', RELATIONSHIPS) +
            text(
              'waifu.relationshipCustom',
              `maxlength="${RELATIONSHIP_MAX_LEN}" placeholder="e.g. a fellow adventurer from the guild" data-when="waifu.relationship=custom"`,
            ),
        ),
    )}
    ${card(
      'Speech style',
      row('Formality', range('waifu.formality', 0, SLIDER_MAX, SLIDER_STEP)) +
        row('Playfulness', range('waifu.playfulness', 0, SLIDER_MAX, SLIDER_STEP)) +
        row('Verbosity', range('waifu.verbosity', 0, SLIDER_MAX, SLIDER_STEP), 'Work stays complete') +
        row(
          'Catchphrases',
          `<div class="set-chips"><span class="set-chip-list" data-chip-list></span><input class="set-chip-input" data-test="set-waifu.catchphrases" data-chip-input
            maxlength="${MAX_CATCHPHRASE_LEN}" placeholder="Type and press Enter"></div>`,
        ) +
        toggle('waifu.japanese', 'Japanese words & honorifics', 'Hai, sugoi, -kun, ganbatte…') +
        toggle('waifu.kaomoji', 'Kaomoji', '(｡•̀ᴗ-)✧ in her lines now and then'),
    )}
    ${card(
      'Personality',
      `<div class="set-seg cards" data-test="set-waifu.personalityPreset" data-seg="waifu.personalityPreset">${presetCards}</div>` +
        area('waifu.personality', 4, `maxlength="${PERSONALITY_MAX_LEN}"`),
      'wide',
    )}
    ${card('In character at work', seg('waifu.workVoice', WORK_VOICES, 'list'))}
    ${card('Emotion expressiveness', seg('waifu.expressiveness', EXPRESSIVENESS, 'list'))}
    ${card(
      'Custom instructions',
      area(
        'waifu.customInstructions',
        4,
        `maxlength="${INSTRUCTIONS_MAX_LEN}" placeholder="Anything else: house rules, running jokes, how to celebrate a green build…"`,
      ),
      'wide',
    )}
    ${card(
      'Persona preview',
      `<pre class="set-persona" data-test="persona-preview"></pre>` +
        note('This is the exact text appended to Claude Code\'s system prompt. It applies from the next session.'),
      'wide',
    )}
  </div>`
}

function roleplayPane() {
  return `<div class="set-rp">
    <div class="set-rp-left">
      ${card(
        'Research a character',
        `<label class="set-cf"><span>Character</span><input class="field" data-test="research-name" data-research="name" maxlength="${CHARACTER_NAME_MAX_LEN}"></label>
        <label class="set-cf"><span>Series</span><input class="field" data-test="research-series" data-research="series" maxlength="${SERIES_MAX_LEN}"></label>
        <label class="set-cf"><span>Notes<small>optional: a version, an arc, a vibe</small></span>
          <textarea class="field" data-test="research-notes" data-research="notes" rows="2" maxlength="${NOTES_MAX_LEN}"
            placeholder="e.g. after episode 18, more confident"></textarea></label>
        <div class="set-actions">
          <button class="btn primary" type="button" data-act="research-start" data-test="research-start">✦ Research</button>
          <button class="btn danger" type="button" data-act="research-cancel" data-test="research-cancel">Cancel</button>
          <span class="set-rp-status" data-test="research-status"></span>
        </div>
        <div class="set-rp-log" data-test="research-progress"></div>
        <p class="set-rp-error" data-test="research-error"></p>` +
          note('Research uses Haiku 5.5 with web search and fetch. It\'s cheap and takes about 1–2 minutes; results are saved to your library.'),
      )}
      ${card(
        'Preset library',
        `<div class="set-lib" data-lib></div>
        <button class="btn" type="button" data-act="preset-handwritten" data-test="preset-handwritten">Use hand-written persona</button>`,
      )}
    </div>
    <div class="set-rp-right" data-test="research-result"></div>
  </div>`
}

function appearancePane() {
  return `<div class="set-cols">
    ${card(
      'Theme',
      row('Mode', seg('appearance.theme', THEMES)) +
        row(
          'Accent',
          `<div class="set-colorline">${seg('appearance.accent', ACCENTS, 'swatch', 'set-appearance.accent-swatches')}
          <input type="color" data-test="set-appearance.accent" data-bind="appearance.accent" title="Any color"></div>`,
        ),
    )}
    ${card(
      'Dialogue box',
      row('Font size', range('appearance.fontSize', FONT_MIN, FONT_MAX, 1)) +
        row('Opacity', range('appearance.boxOpacity', OPACITY_MIN, OPACITY_MAX, OPACITY_STEP)) +
        note('The box under her shows the result →'),
    )}
    ${card('Scene', row('Background', seg('appearance.background', BACKGROUNDS)) + toggle('appearance.petals', 'Sakura petals', 'Petals drifting across the window.'))}
    ${card(
      'Framing',
      row('Zoom', range('appearance.zoom', ZOOM_MIN, ZOOM_MAX, ZOOM_STEP)) +
        note('Or turn the wheel over her. On a 3D card, right-drag turns the camera round her, middle-drag (or Shift + right-drag) moves it up and down, and a right double-click puts it back; she keeps following your cursor.'),
    )}
    ${card(
      'Model',
      row('Drawn as', seg('appearance.model', MODEL_KINDS)) +
        `<div class="set-path" data-when="appearance.model=mmd">${text('appearance.mmdFile', 'placeholder="Path to her .pmx file"')}
          <button class="btn" type="button" data-act="mmd-browse" data-test="set-appearance.mmdFile-browse">Browse…</button></div>` +
        note('Saved on her waifu card. A 3D model is drawn with MMD shading, outlines and physics, and plays her emotions with its face morphs; if it can\'t load, her Live2D costume stands in. The model stays on this computer and is never put in an exported card.'),
      'wide',
    )}
    ${card(
      'Costume',
      `<div class="set-seg costumes" data-test="set-appearance.costume" data-seg="appearance.costume"></div>
      <p class="set-empty" data-costume-empty>No costumes found. Point the models folder below at your Live2D models.</p>`,
      'wide',
      'data-when="appearance.model=live2d"',
    )}
    ${card(
      'Models folder',
      // Not data-bound: the folder is written once the path is finished, since every write makes her rescan it.
      `<div class="set-path"><input class="field" type="text" data-test="set-appearance.modelsDir" data-dir-input spellcheck="false"
          placeholder="Default: your Downloads costume folder, then waifufy's assets">
        <button class="btn" type="button" data-act="models-browse" data-test="set-appearance.modelsDir-browse">Browse…</button>
        <button class="btn" type="button" data-act="models-default" data-test="set-appearance.modelsDir-default">Use default</button></div>
      <p class="set-found" data-test="models-found"></p>` +
        note('A folder of costume folders, each holding a <code>.model3.json</code>. Live2D models aren\'t bundled: bring your own.'),
      'wide',
      'data-when="appearance.model=live2d"',
    )}
  </div>`
}

function motionPane() {
  const at = (v: number) => (((v - CPS_MIN) / (CPS_INSTANT_NOTCH - CPS_MIN)) * 100).toFixed(2)
  const marks = `<div class="set-marks">
    <span class="speech" style="left: ${at(CPS_SPEECH)}%">▲ Speech pace</span><span style="left: 100%">Instant</span>
  </div>`
  return `<div class="set-cols">
    ${card(
      'Text',
      row('Text speed', range('motion.textCps', CPS_MIN, CPS_INSTANT_NOTCH, 1, 'cps', marks)) +
        `<div class="set-actions">
          <button class="btn" type="button" data-act="cps-default" data-test="set-motion.textCps-default">Speech pace</button>
          <button class="btn" type="button" data-act="sample" data-test="settings-sample">▶ Play sample</button>
        </div>` +
        toggle('motion.punctuationPauses', 'Punctuation pauses', 'A breath at commas, a longer one at full stops, like real speech.') +
        row('Auto-advance delay', range('motion.autoDelayMs', 0, AUTO_DELAY_MAX_MS, AUTO_DELAY_STEP_MS), 'Extra wait in AUTO'),
      'wide',
    )}
    ${card('Character', `<div class="set-toggles">${MOTION_TOGGLES.map((t) => toggle(`motion.${t.path}`, t.label, t.hint)).join('')}</div>`, 'wide')}
  </div>`
}

function claudePane() {
  const models = [...MODEL_ALIASES, { v: CUSTOM_MODEL, label: 'Custom…' }].map((o) => `<option value="${o.v}">${o.label}</option>`).join('')
  return `<div class="set-cols">
    ${card(
      'New sessions',
      row(
        'Default model',
        `<div class="set-path"><select class="field" data-test="set-claude.model" data-model-select>${models}</select>
        <input class="field" type="text" data-test="set-claude.model-custom" data-model-custom spellcheck="false" placeholder="Model id, e.g. claude-opus-5-5"></div>`,
        '/model still switches mid-session',
      ) +
        row(
          'New Game opens',
          `<div class="set-path">${text('claude.defaultDir', 'placeholder="The last folder you used"')}
          <button class="btn" type="button" data-act="dir-browse" data-test="set-claude.defaultDir-browse">Browse…</button>
          <button class="btn" type="button" data-act="dir-clear" data-test="set-claude.defaultDir-clear">Clear</button></div>`,
          'Default folder',
        ) +
        `<p class="set-note" data-last-dir></p>`,
      'wide',
    )}
    ${card('Default permission mode', seg('claude.permissionMode', PERMISSION_MODES, 'list') + note('Shift+Tab cycles the mode during a session, as in the CLI.'))}
    ${card(
      'Setting sources',
      SETTING_SOURCES.map(
        (o) => `<label class="set-toggle"><input type="checkbox" data-test="set-claude.settingSources.${o.v}" data-source="${o.v}"><i></i>
          <span><b>${o.label}</b><small>${o.hint}</small></span></label>`,
      ).join('') +
        note('Which Claude Code configuration sessions load, like the CLI\'s <code>--setting-sources</code>. Turning one off also skips its CLAUDE.md, permissions, hooks and commands. Applies from the next session.'),
    )}
  </div>`
}

function voicePane() {
  return `<div class="set-cols">
    ${card(
      'Voice',
      `<p class="set-voice-status" data-voice-status data-test="voice-status"></p>` +
        toggle('voice.enabled', 'Her voice', 'Speak her lines aloud, in step with the text and her lips.') +
        row(
          'Fish Audio key',
          `<div class="set-path"><input class="field" type="password" data-voice-key data-test="set-voice.key" autocomplete="off" spellcheck="false" placeholder="Paste your API key">
          <button class="btn" type="button" data-act="voice-key-save" data-test="set-voice.key-save">Save</button>
          <button class="btn" type="button" data-act="voice-key-remove" data-test="set-voice.key-remove">Remove</button></div>`,
          'Kept by the app, never in settings',
        ) +
        note('Get a key at <code>fish.audio/app/api-keys</code>. Without one she stays silent, as before.') +
        row('Voice id', text('voice.voiceId', `placeholder="${DEFAULT_VOICE_ID}"`), 'From the voice page on fish.audio') +
        row('Model', seg('voice.model', VOICE_MODEL_OPTS)) +
        row('Language', seg('voice.language', VOICE_LANGS)) +
        `<div data-when="voice.language=ja">${toggle('voice.subtitles', 'Japanese subtitle', 'Show her Japanese line under the English while she speaks it.')}</div>` +
        row('Speed', range('voice.speed', 0.7, 1.4, 0.05)) +
        row('Volume', range('voice.volume', 0, 100, 5)) +
        `<div class="set-actions"><button class="btn" type="button" data-act="voice-test" data-test="set-voice.test">▶ Test voice</button></div>`,
      'wide',
    )}
    ${card(
      'How she speaks <span data-when="voice.language=ja">Japanese</span><span data-when="voice.language=en">English</span>',
      area('voice.styleNotes', 8, 'maxlength="4000"') +
        note('One note per line: her register, how she refers to herself, her sentence endings. Applying a researched preset fills it in for the language picked above; the default is Rem\'s Japanese (docs/research/rem-voice.md). These notes are part of her persona, so changes here, to Language and to the key apply from the next session; speed, volume and subtitles apply at once.'),
      'wide',
    )}
    ${card(
      'Pronunciation',
      area('voice.pronunciations', 5, 'maxlength="2000" placeholder="Pavolia Reine = Pah-VOH-lee-ah RAY-neh"') +
        note('Words the voice says wrong, one per line: <code>word = how to say it</code>. Only the voice uses them; the text keeps the real spelling. Applying a researched preset fills these in too.'),
      'wide',
    )}
  </div>`
}

const CASUAL_PROVIDERS: Opt[] = [
  { v: 'openai', label: 'OpenAI-compatible API', hint: 'GPT, OpenRouter, a local server… with your key. Without a key, Claude answers.' },
  { v: 'claude', label: 'Claude', hint: 'Through your Claude subscription, stripped of Claude Code: no extra key or bill.' },
]
const TO_WORK: Opt[] = [
  { v: 'ask', label: 'Ask', hint: 'Ask each time you switch back to work' },
  { v: 'compact', label: 'Compact', hint: 'Work starts from a summary of the chat' },
  { v: 'keep', label: 'Keep', hint: 'Work keeps the full context' },
]
const LEARN_WITH: Opt[] = [
  { v: 'claude', label: 'Claude', hint: 'Reflects and judges on your subscription' },
  { v: 'casual', label: 'The casual model', hint: 'Uses the same API as casual chat' },
]

function casualPane() {
  return `<div class="set-cols">
    ${card(
      'Who answers',
      `<p class="set-voice-status" data-casual-status data-test="casual-status"></p>` +
        seg('casual.provider', CASUAL_PROVIDERS, 'list') +
        row(
          'API key',
          `<div class="set-path"><input class="field" type="password" data-casual-key data-test="set-casual.key" autocomplete="off" spellcheck="false" placeholder="Paste your API key">
          <button class="btn" type="button" data-act="casual-key-save" data-test="set-casual.key-save">Save</button>
          <button class="btn" type="button" data-act="casual-key-remove" data-test="set-casual.key-remove">Remove</button></div>`,
          'Kept by the app, never in settings',
        ) +
        row('API address', text('casual.baseUrl', 'placeholder="https://api.openai.com/v1"'), 'Any OpenAI-compatible /chat/completions') +
        row('Model', text('casual.model', 'placeholder="gpt-6-luna"')) +
        row('Reasoning effort', text('casual.reasoningEffort', 'placeholder="none"'), 'Sent as reasoning_effort when set') +
        row('Claude model', text('casual.claudeModel', 'placeholder="sonnet"'), 'When Claude answers') +
        note('Casual mode is a much smaller harness than Claude Code: her own prompt and short replies, on the same history as work mode. The history stays cached between turns, so a long evening of chatting costs cents, not dollars.'),
      'wide',
    )}
    ${card(
      'Tools and work',
      row('Toolkit model', text('casual.toolModel', 'placeholder="haiku"'), 'Claude Code with your tools and MCP servers') +
        note('When casual chat needs something talking cannot give (the web, your Slack, a file), she hands it to Claude Code with your own tools and MCP servers, then answers from its report. It only looks things up and never edits files; asking for real work offers to switch to work mode.') +
        toggle('casual.shareWork', 'Work lines in casual chat', "She remembers this session's work conversation in casual mode. Off keeps your work out of the casual model's requests.") +
        row('Back to work', seg('casual.toWork', TO_WORK), 'Compact: work starts from a summary') +
        note('Either way, every earlier line of the session stays searchable: she and Claude Code both have a <code>search_history</code> tool.'),
      'wide',
    )}
    ${card(
      'Messaging first',
      toggle('casual.initiative', 'She can message first', 'In casual mode she decides on her own when to say something, and when to stay quiet. She waits while you type.') +
        row('Boundaries', area('casual.boundaries', 3, 'maxlength="2000" placeholder="Rules she never breaks, in your words: nothing after 23:00, at most two messages while I\'m at work…"'), 'Your rules win over her personality') +
        note('How often she reaches out, and what she does when you\'re away (waiting, a huffy line, checking in, pinging), is her personality\'s call. A draft left in the box for 20 minutes counts as you being away.'),
      'wide',
    )}
    ${card(
      'Learning',
      toggle('casual.learning', 'Reflect after a quiet spell', 'She remembers facts and moments, learns what works with you, and is judged on how she did.') +
        row('Quiet for', range('casual.idleMin', 5, 240, 5), 'Minutes before she reflects') +
        row('Revise below', range('casual.judgeThreshold', 0, 10, 0.5), 'Judge score out of 10') +
        row('Who reflects', seg('casual.learnWith', LEARN_WITH)) +
        note('Below the score, a critic rewrites only her chat style and example lines, and the rewrite is kept only if it beats the old one on a replay of your real messages. Her character, personality and feelings are never edited. Her memory lives in the data folder under <code>memory/</code>.'),
      'wide',
    )}
  </div>`
}

function slackPane() {
  return `<div class="set-cols">
    ${card(
      'Slack',
      `<p class="set-voice-status" data-slack-status data-test="slack-status"></p>` +
        row('Client ID', text('slack.clientId', 'placeholder="From the app\'s Basic Information page" autocomplete="off"'), 'Not a secret: sign-in uses PKCE') +
        `<div class="set-actions">
          <button class="btn primary" type="button" data-act="slack-signin" data-test="set-slack.signin">Sign in with Slack</button>
          <button class="btn" type="button" data-act="slack-cancel" data-test="set-slack.cancel" hidden>Cancel</button>
          <button class="btn" type="button" data-act="slack-signout" data-test="set-slack.signout">Sign out</button>
        </div>` +
        note('Signing in opens Slack in your browser. The sign-in is kept by the app, never in settings. In the chat, <b>SLACK</b> (or <code>/slack</code>) opens your unread messages.'),
      'wide',
    )}
    ${card(
      'Set up the app (once per workspace)',
      `<ol class="set-steps">
        <li>Open <code>api.slack.com/apps</code> → <b>Create New App</b> → <b>From a manifest</b>, and pick your workspace.</li>
        <li>Paste this manifest and create the app.</li>
        <li>On its <b>Basic Information</b> page, copy the <b>Client ID</b> into the field above. No secret, no install step: signing in installs it for you.</li>
      </ol>
      <pre class="set-persona" data-test="slack-manifest">${esc(SLACK_MANIFEST)}</pre>
      <div class="set-actions">
        <button class="btn" type="button" data-act="slack-copy-manifest" data-test="set-slack.copy">Copy manifest</button>
        <button class="btn" type="button" data-act="slack-apps" data-test="set-slack.apps">Open api.slack.com/apps</button>
      </div>` +
        note(`Your own app keeps Slack's normal limits; a shared one would be held to one history read a minute. If your workspace restricts apps, an admin may need to approve it. Sign-in returns to <code>${esc(SLACK_REDIRECT_URL)}</code>, so that port must be free.`),
      'wide',
    )}
    ${card(
      'What she can do',
      `<ul class="set-credits">
        <li>Read your unread conversations, any conversation or thread, and search, without asking.</li>
        <li>Mark conversations read.</li>
        <li><b>Send messages as you only after you approve each one</b>, in every permission mode.</li>
      </ul>` + note('Her Slack tools join from the next session after you sign in. Messages are never saved by the app.'),
      'wide',
    )}
  </div>`
}

function phonePane() {
  return `<div class="set-cols">
    ${card(
      'Phone access',
      `<div data-phone-desktop>` +
        `<label class="set-toggle"><input type="checkbox" data-phone-enabled data-test="set-phone.enabled"><i></i>
          <span><b>Let my phone connect</b><small>Your phone joins the chat running here, over your Wi-Fi or Tailscale. Claude Code stays on this computer.</small></span></label>` +
        `<p class="set-voice-status" data-phone-status data-test="phone-status"></p>` +
        `<div class="set-phone-pair" data-phone-pair hidden>
          <div class="set-qr" data-phone-qr data-test="phone-qr"></div>
          <div class="set-phone-side">
            <ol class="set-steps">
              <li>Install the Waifufy Code app on your Android phone (the APK from the release page).</li>
              <li>Open it and scan this code. Or copy the pairing link to your phone and paste it there.</li>
            </ol>
            <div class="set-actions">
              <button class="btn" type="button" data-act="phone-copy" data-test="set-phone.copy">Copy pairing link</button>
              <button class="btn" type="button" data-act="phone-reset" data-test="set-phone.reset">New pairing code</button>
            </div>
          </div>
        </div>` +
        note('The code lets a phone in: only show it to your own. Each phone that scans it gets a key of its own and stays paired for good, so it reconnects by itself and never needs this screen again; a new pairing code only changes what new phones scan. The first time, Windows may ask whether Waifufy Code may use the network: allow private networks. Away from home, Tailscale on both devices keeps it working.') +
        `<div class="set-devices" data-phone-devices hidden>
          <h5>Paired phones</h5>
          <div data-test="phone-devices"></div>
          ${note('Remove a phone you no longer use (or lost): it is disconnected and can only come back by scanning the code.')}
        </div>` +
        `</div>` +
        `<div data-phone-remote hidden>
          <p class="set-voice-status" data-phone-paired data-test="phone-paired"></p>
          <label class="set-toggle"><input type="checkbox" data-lowspec data-test="set-phone.lowspec"><i></i>
            <span><b>Low-spec mode</b><small>No character on this phone: a chat room instead of the visual novel. Her voice still reads each line, and everything else works. Much lighter on a slower phone. This phone only.</small></span></label>
          <div class="set-actions"><button class="btn" type="button" data-act="phone-unpair" data-test="set-phone.unpair">Unpair this phone</button></div>
          ${note('Settings here are your computer\'s: changes apply there too.')}
        </div>`,
      'wide',
    )}
  </div>`
}

function cardsPane() {
  return `<div class="set-cols">
    ${card(
      'Your waifu cards',
      `<div class="set-cards" data-test="cards-list"><p class="set-empty">Loading cards…</p></div>` +
        note('Swapping loads her persona, research presets, model, voice and love meter for the next session. Your own profile and app settings stay. What she remembers about you stays with each card on this computer and is never exported.'),
      'wide',
    )}
    ${card(
      'Add a card',
      `<div class="set-actions">
        <button class="btn" type="button" data-act="card-new" data-test="card-new">New card</button>
        <button class="btn" type="button" data-act="card-copy" data-test="card-copy">Duplicate current</button>
        <button class="btn" type="button" data-act="card-import" data-test="card-import">Import…</button>
      </div>` + note('A new card starts as the default character with an empty love meter: change her on the Waifu, Appearance and Voice tabs. Import reads a <code>.waifu.json</code> file.'),
      'wide',
    )}
  </div>`
}

function aboutPane() {
  return `<div class="set-cols">
    ${card(
      'Waifufy Code',
      `<p class="set-version" data-test="about-version"></p>` +
        row('Data folder', `<div class="set-path"><code class="set-pathtext" data-about-data></code>
          <button class="btn" type="button" data-act="reveal-data" data-test="about-open-data" disabled>Open</button></div>`, 'Settings, saves, thumbnails') +
        row('Logs', `<div class="set-path"><code class="set-pathtext" data-about-logs></code>
          <button class="btn" type="button" data-act="reveal-logs" data-test="about-open-logs" disabled>Open</button></div>`) +
        `<div class="set-actions"><button class="btn" type="button" data-act="wizard" data-test="settings-wizard">Replay the welcome wizard</button></div>`,
      'wide',
    )}
    ${card(
      'Credits & licensing',
      `<ul class="set-credits">
        <li>A fan-made visual novel skin for <b>Claude Code</b>, built on the Claude Agent SDK. Claude and Claude Code belong to Anthropic.</li>
        <li><b>Live2D and MMD models are third-party</b> and are not bundled. Bring your own and respect their licenses; the default character
          belongs to her creators and publishers.</li>
        <li>Live2D Cubism Core © Live2D Inc., under the Live2D Proprietary Software License.</li>
        <li>Rendering: PixiJS and untitled-pixi-live2d-engine; 3D (MMD) cards: Babylon.js and babylon-mmd, with Bullet physics. Desktop shell: Tauri.</li>
        <li>Fonts: Zen Maru Gothic, Shippori Mincho and JetBrains Mono, under the SIL Open Font License.</li>
      </ul>`,
      'wide',
    )}
  </div>`
}

const PANES: Record<TabId, () => string> = {
  cards: cardsPane, you: youPane, waifu: waifuPane, roleplay: roleplayPane, appearance: appearancePane, motion: motionPane, claude: claudePane,
  casual: casualPane, voice: voicePane, slack: slackPane, phone: phonePane, about: aboutPane,
}

// ---------------------------------------------------------------- screen

export function settingsScreen(): Screen {
  let ctx: Ctx
  let root: HTMLElement
  let visible = false
  let tab: TabId = 'you'
  /** The waifu cards as the link last listed them; undefined until it has. */
  let deck: { list: CardSummary[]; active: string } | undefined
  /** When a card request last went out, so a refusal (an app_error) right after it is shown. */
  let cardAskAt = 0
  let costumes: Costume[] = []
  let models: { dir: string; found: boolean } | undefined
  /**
   * The folder this screen last asked the link about. The character asks too (for the saved folder), so costumes
   * replies for other folders are ignored; undefined while no request of ours is out.
   */
  let pendingDir: string | undefined
  let costumesTimer: number | undefined
  let about: { version: string; dataDir: string } | undefined
  /** Phone access as the link last reported it (desktop windows only). */
  let phone: RemoteStatus | undefined
  let customModel = false
  let research = { running: false, log: [] as string[], error: '', startedAt: 0 }
  /** A cancel was sent and its "Research cancelled." error hasn't come back yet, so it can't be blamed on a newer run. */
  let cancelPending = false
  /** The user's own personality text, kept while a preset card is tried on so "Custom" brings it back. */
  let customText = ''
  /** The screen Settings was opened from. Return goes back to a live chat, which router.back() never does. */
  let openedFrom: string | undefined
  /** The preset shown in the editable result card. */
  let cardId = ''
  let renderedCardId: string | undefined
  let renaming = ''
  let previewTimer: number | undefined
  let typingTimer: number | undefined
  let clockTimer: number | undefined
  let talking = false
  let lastReact = 0

  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)!
  const qa = <T extends HTMLElement = HTMLElement>(sel: string) => [...root.querySelectorAll<T>(sel)]
  const fill = (line: string, s = ctx.store.get()) => line.replaceAll('{you}', addressOf(s))

  // A blur commits a field, and the store change repaints the screen. Rebuilding the button under the cursor between
  // mousedown and mouseup would swallow its click, so markup is replaced only when it actually changed.
  const painted = new WeakMap<Element, string>()
  function paint(el: Element, html: string) {
    if (painted.get(el) === html) return
    painted.set(el, html)
    el.innerHTML = html
  }

  // ---------------------------------------------------------------- her reactions + the preview box

  function react(e: Emotion) {
    if (!ctx.store.get().motion.gestures || performance.now() - lastReact < REACT_GAP_MS) return
    lastReact = performance.now()
    ctx.character.emote(e)
  }

  function talk(on: boolean) {
    if (on && !ctx.store.get().motion.lipSync) on = false
    if (on === talking) return
    talking = on
    ctx.character.setTalking(on)
  }

  function stopTyping() {
    clearTimeout(typingTimer)
    typingTimer = undefined
    talk(false)
  }

  /** Types a line into the preview box at the configured speed, with the same pauses as the chat typewriter. */
  function say(line: string, e?: Emotion) {
    stopTyping()
    if (e) react(e)
    const full = fill(line)
    const box = q('[data-preview-text]')
    box.dataset.full = full
    const m = ctx.store.get().motion
    if (!visible || m.textCps === 0) return void (box.textContent = full)
    let i = 0
    const step = () => {
      if (i >= full.length) return stopTyping()
      const c = full[i++]
      box.textContent = full.slice(0, i)
      const atBreak = i >= full.length || /\s/.test(full[i])
      const pause = !m.punctuationPauses || !atBreak ? 0 : /[,;、]/.test(c) ? PAUSE_COMMA_MS : /[.!?…。！？]/.test(c) ? PAUSE_STOP_MS : 0
      // The mouth keeps moving across spaces and closes only for the punctuation pauses (R28).
      talk(pause === 0)
      typingTimer = window.setTimeout(step, MS_PER_S / m.textCps + pause)
    }
    step()
  }

  // ---------------------------------------------------------------- writing settings

  function write(path: string, v: unknown) {
    ctx.store.update((s) => {
      const prev = structuredClone(s.profile)
      if (path === 'waifu.personalityPreset' && s.waifu.personalityPreset === CUSTOM_PERSONALITY) customText = s.waifu.personality
      setAt(s, path, v)
      if (path === 'waifu.personality') {
        const preset = personalityById(s.waifu.personalityPreset)
        if (preset && preset.text !== s.waifu.personality) s.waifu.personalityPreset = CUSTOM_PERSONALITY
      }
      if (path === 'waifu.personalityPreset') {
        const preset = personalityById(String(v))
        if (preset) s.waifu.personality = preset.text
        else if (customText) s.waifu.personality = customText
      }
      // "What she calls you" follows the display name until the user sets it apart.
      if (path === 'profile.displayName' && prev.callMe === prev.displayName) s.profile.callMe = String(v)
    })
  }

  /** A change the user finished (blur, click, slider release): she reacts to it. */
  function commit(path: string) {
    const s = ctx.store.get()
    const toggleInfo = MOTION_TOGGLES.find((t) => `motion.${t.path}` === path)
    if (toggleInfo) {
      const on = s.motion[toggleInfo.path] as boolean
      // Turning gestures off should still get one last reaction, so ask before the setting gates it.
      if (path === 'motion.gestures' && !on) ctx.character.emote('nod')
      return say(on ? toggleInfo.on : toggleInfo.off, on ? 'happy' : 'pout')
    }
    switch (path) {
      case 'profile.displayName':
      case 'profile.callMe':
      case 'profile.honorific':
      case 'profile.customHonorific':
        return say('{you}… I like the sound of that.', 'shy')
      case 'profile.nameColor':
      case 'profile.title':
      case 'profile.pronouns':
        return react('nod')
      case 'profile.about':
        return say('I\'ll remember all of that, {you}.', 'smile')
      case 'waifu.name':
        return say(`From now on, please call me ${s.waifu.name || '…'}.`, 'smile')
      case 'waifu.relationship':
        return say(RELATIONSHIP_LINES[s.waifu.relationship], 'smile')
      case 'waifu.personalityPreset': {
        const p = personalityById(s.waifu.personalityPreset)
        return p ? say(p.sample, p.emotion) : say('In your own words, then. I\'ll treasure them, {you}.', 'happy')
      }
      case 'waifu.japanese':
        return say(s.waifu.japanese ? 'Hai, {you}! Ganbarimasu!' : 'Understood. Plain words from now on.', 'nod')
      case 'waifu.kaomoji':
        return say(s.waifu.kaomoji ? 'Yay, {you}! (｡•̀ᴗ-)✧' : 'No more faces… okay.', s.waifu.kaomoji ? 'delighted' : 'pout')
      case 'waifu.formality':
      case 'waifu.playfulness':
      case 'waifu.verbosity':
      case 'waifu.workVoice':
      case 'waifu.expressiveness':
        return react('think')
      case 'appearance.theme':
        // The resolved theme, so "System" on a dark OS gets the dark line (applyAppearance has already run).
        return say(document.documentElement.dataset.theme === 'dark' ? 'Oh! It got dark… I\'m right here, {you}.' : 'Nice and bright!', 'surprised')
      case 'appearance.accent':
        return react('happy')
      case 'appearance.background':
      case 'appearance.petals':
        return react('delighted')
      case 'appearance.fontSize':
      case 'appearance.boxOpacity':
        return say('Can you read me clearly, {you}?', 'nod')
      case 'appearance.zoom':
        return react('shy')
      case 'appearance.costume':
        // The character watches appearance.costume and swaps (with its costume gesture) on the store write itself;
        // calling setCostume as well would load the model twice.
        return say('How do I look, {you}?')
      case 'motion.textCps':
      case 'motion.punctuationPauses':
        return say(SPEED_SAMPLE)
      case 'claude.permissionMode':
        return react(s.claude.permissionMode === 'bypassPermissions' ? 'worried' : 'nod')
    }
  }

  function readField(el: Field): unknown {
    if (el instanceof HTMLInputElement && el.type === 'checkbox') return el.checked
    if (el instanceof HTMLInputElement && el.type === 'range') {
      const n = Number(el.value)
      return el.dataset.conv ? CONVERTERS[el.dataset.conv].fromInput(n) : n
    }
    return el.value
  }

  function onField(t: EventTarget | null, committed: boolean) {
    if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement)) return
    const d = t.dataset
    if (d.bind) {
      const v = readField(t)
      // The 'input' event already wrote it; a blur alone shouldn't repaint the screen.
      if (!committed || v !== getAt(ctx.store.get(), d.bind)) write(d.bind, v)
      if (committed) commit(d.bind)
    } else if (d.dirInput !== undefined && committed) {
      const dir = t.value.trim()
      if (dir === ctx.store.get().appearance.modelsDir) return
      if (!dir) return useDefaultModels()
      setModelsDir(dir)
    } else if (d.source && committed) {
      const on = new Set(qa<HTMLInputElement>('[data-source]').filter((c) => c.checked).map((c) => c.dataset.source))
      ctx.store.update((s) => void (s.claude.settingSources = SETTING_SOURCES.map((o) => o.v).filter((v) => on.has(v))))
    } else if (d.modelSelect !== undefined && committed) {
      customModel = t.value === CUSTOM_MODEL
      if (!customModel) return write('claude.model', t.value)
      // Starts from the model in use, so picking "Custom…" alone changes nothing until an id is typed.
      const custom = q<HTMLInputElement>('[data-model-custom]')
      custom.value = ctx.store.get().claude.model
      sync()
      custom.focus()
      custom.select()
    } else if (d.modelCustom !== undefined) {
      const id = t.value.trim()
      if (id && id !== ctx.store.get().claude.model) write('claude.model', id)
    } else if (d.card && committed) {
      writeCard(t)
    } else if (d.chipInput !== undefined && committed) {
      addChip(t as HTMLInputElement)
    }
  }

  function addChip(input: HTMLInputElement) {
    const phrase = input.value.trim()
    input.value = ''
    if (!phrase) return
    ctx.store.update((s) => {
      const list = s.waifu.catchphrases
      if (!list.some((c) => sameValue(c, phrase)) && list.length < MAX_CATCHPHRASES) list.push(phrase)
    })
    say(`“${phrase}” …like that, {you}?`, 'happy')
  }

  // ---------------------------------------------------------------- research presets

  const presetOf = (id: string, s = ctx.store.get()) => s.presets.find((p) => p.id === id)

  function cardValue(p: PersonaPreset, key: string) {
    if (key === 'name' || key === 'series' || key === 'prompt') return p[key]
    if (key === 'summary' || key === 'addressing') return p.profile[key]
    return p.profile[key as ListField].join('\n')
  }

  function writeCard(el: Field) {
    const key = el.dataset.card!
    const v = el.value
    ctx.store.update((s) => {
      const p = presetOf(cardId, s)
      if (!p) return
      if (key === 'name' || key === 'series' || key === 'prompt') p[key] = key === 'prompt' ? v : v.trim()
      else if (key === 'summary' || key === 'addressing') p.profile[key] = v
      else p.profile[key as keyof Omit<ResearchProfile, 'summary' | 'addressing'>] = v.split('\n').map((l) => l.trim()).filter(Boolean)
    })
  }

  function flushCard() {
    for (const el of qa<Field>('[data-card]')) writeCard(el)
  }

  function applyPreset(id: string) {
    if (id === cardId) flushCard()
    const p = presetOf(id)
    if (!p) return
    ctx.store.update((s) => {
      s.waifu.activePreset = p.id
      if (p.name) s.waifu.name = p.name
      // The series always follows, so an original character doesn't stay "from Re:Zero".
      s.waifu.series = p.series
      // Catchphrases that came from any preset give way to this one's; the ones the user typed stay.
      const fromPresets = new Set(s.presets.flatMap((x) => x.profile.catchphrases))
      const own = s.waifu.catchphrases.filter((c) => !fromPresets.has(c))
      s.waifu.catchphrases = [...own, ...p.profile.catchphrases].slice(0, MAX_CATCHPHRASES)
      // How she speaks and how her name is said come along, when the research was for the language her voice speaks.
      if (p.voice && p.voice.language === s.voice.language) {
        if (p.voice.styleNotes.trim()) s.voice.styleNotes = p.voice.styleNotes
        if (p.voice.pronunciations.trim()) s.voice.pronunciations = p.voice.pronunciations
      }
    })
    ctx.toast(`${p.name} is now her persona. It takes effect from the next session.`)
    say(stripTags(p.profile.sampleLines[0] ?? '') || 'Nice to meet you, {you}.', 'delighted')
  }

  async function deletePreset(id: string) {
    const p = presetOf(id)
    if (!p) return
    const yes = await ctx.confirm('Delete preset?', `“${p.name}” will be removed from your library.`, 'Delete', 'Keep')
    if (!yes) return
    ctx.store.update((s) => {
      s.presets = s.presets.filter((x) => x.id !== id)
      if (s.waifu.activePreset === id) s.waifu.activePreset = ''
    })
    if (cardId === id) cardId = ''
    react('worried')
  }

  function startResearch() {
    const val = (k: string) => q<HTMLInputElement>(`[data-research="${k}"]`).value.trim()
    const name = val('name')
    if (!name) {
      q('[data-research="name"]').focus()
      return ctx.toast('Who should she research? Enter a character name first.')
    }
    research = { running: true, log: [], error: '', startedAt: Date.now() }
    ctx.link.send({ t: 'research', name, series: val('series'), notes: val('notes') })
    ctx.character.setBusy(true)
    say(`Let me study ${name}… give me a minute or two, {you}.`, 'think')
    renderResearch()
    startClock()
  }

  function cancelResearch() {
    if (!research.running) return
    ctx.link.send({ t: 'research_cancel' })
    research.running = false
    cancelPending = true
    research.log.push('Cancelled.')
    ctx.character.setBusy(false)
    react('sigh')
    renderResearch()
  }

  function startClock() {
    clearInterval(clockTimer)
    clockTimer = window.setInterval(() => (research.running && visible ? renderStatus() : clearInterval(clockTimer)), CLOCK_MS)
  }

  function onServer(m: ServerMsg) {
    switch (m.t) {
      case 'persona_preview':
        if (!root) return
        q('[data-test="persona-preview"]').textContent = m.text
        q('[data-test="persona-preview"]').classList.remove('pending')
        return
      case 'costumes': {
        // A reply for the character's own request (the folder saved on disk) can come first and be for another folder.
        // The link resolves the folder it was given, so a relative path can't be matched and its first reply is taken.
        const mine = pendingDir !== undefined && (pendingDir === '' || !isAbsolutePath(pendingDir) || samePath(m.dir, pendingDir))
        if (!mine) return
        pendingDir = undefined
        costumes = m.list
        models = { dir: m.dir, found: m.found }
        return void (visible && renderCostumes())
      }
      case 'cards': {
        const was = deck?.active
        deck = { list: m.list, active: m.active }
        const now = m.list.find((c) => c.id === m.active)
        if (was && was !== m.active && now && visible) {
          ctx.toast(`${now.name}'s card is in. She takes over from the next session.`)
          say('Nice to meet you, {you}.', 'shy')
        }
        return void (root && renderCards())
      }
      case 'app_error':
        // A card request the link refused (a session still running, a card gone) comes back only as this.
        if (Date.now() - cardAskAt < CARD_REPLY_MS) ctx.toast(m.message)
        return
      case 'card_file':
        if (m.error) return ctx.toast(`${m.op === 'export' ? 'Export' : 'Import'} failed: ${m.error}`)
        if (m.op === 'export') return ctx.toast(`Card saved to ${m.path}. Your memories with her stay here.`)
        ctx.toast('Card imported. Switch to it from the list.')
        return react('surprised')
      case 'hello':
        about = { version: m.version, dataDir: m.dataDir }
        return void (visible && renderAbout())
      case 'voice_key':
        return void (visible && renderVoice())
      case 'casual_key':
        return void (visible && renderCasual())
      case 'remote_status':
        phone = m.status
        return void (root && renderPhone())
      case 'research_progress':
        if (!research.running) return
        research.log.push(...m.text.split('\n').filter((l) => l.trim()))
        research.log.splice(0, Math.max(0, research.log.length - MAX_LOG_LINES))
        return void (visible && renderResearch())
      case 'research_done': {
        const preset = m.preset
        research.running = false
        research.log.push(`Done: ${preset.name}.`)
        // The link saved it into settings.presets already; this keeps the local store right if its broadcast is still in flight.
        if (!presetOf(preset.id)) ctx.store.update((s) => void s.presets.push(preset))
        cardId = preset.id
        ctx.toast(`Research done: ${preset.name}. Review the result in Settings → Roleplay, then Apply.`)
        if (!visible) return
        ctx.character.setBusy(false)
        say(`I've learned all about ${preset.name}, {you}! Take a look.`, 'delighted')
        return renderResearch()
      }
      case 'research_error':
        if (cancelPending && m.message === RESEARCH_CANCELLED) return void (cancelPending = false)
        if (!research.running) return
        research.running = false
        research.error = m.message
        if (!visible) return void ctx.toast(`Research failed: ${m.message}`)
        ctx.character.setBusy(false)
        say('I couldn\'t finish the research… I\'m sorry, {you}.', 'sad')
        return renderResearch()
    }
  }

  // ---------------------------------------------------------------- rendering

  /** Blurs the field being edited, so its 'change' (and the save it triggers) runs before the pane is hidden. */
  function commitFocused() {
    const a = document.activeElement
    if ((a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || a instanceof HTMLSelectElement) && root.contains(a)) a.blur()
  }

  function setTab(id: TabId, greet = true) {
    if (id !== tab) commitFocused()
    tab = id
    for (const b of qa('[data-test="settings-tab"]')) b.classList.toggle('on', b.dataset.tab === id)
    for (const p of qa('[data-pane]')) p.hidden = p.dataset.pane !== id
    const info = TABS.find((t) => t.id === id)!
    q('[data-pane-title]').textContent = info.label
    q('[data-pane-blurb]').textContent = info.blurb
    q('[data-act="reset"]').hidden = !RESET[id]
    q(`[data-pane="${id}"]`).scrollTop = 0
    if (id === 'waifu') schedulePreview(0)
    if (id === 'appearance') {
      const dir = ctx.store.get().appearance.modelsDir
      requestCostumes(dir, dir ? 0 : SAVE_SETTLE_MS)
    }
    if (id === 'about' && !about) ctx.link.send({ t: 'hello' })
    if (id === 'cards') ctx.link.send({ t: 'cards' })
    if (id === 'roleplay') {
      const s = ctx.store.get()
      const name = q<HTMLInputElement>('[data-research="name"]')
      const series = q<HTMLInputElement>('[data-research="series"]')
      if (!name.value && !series.value) {
        name.value = s.waifu.name
        series.value = s.waifu.series
      }
    }
    if (greet) say(...TAB_LINES[id])
  }

  function schedulePreview(ms = PREVIEW_DEBOUNCE_MS) {
    clearTimeout(previewTimer)
    q('[data-test="persona-preview"]').classList.add('pending')
    previewTimer = window.setTimeout(() => ctx.link.send({ t: 'persona_preview', settings: ctx.store.get() }), ms)
  }

  function requestCostumes(dir: string, delayMs = 0) {
    clearTimeout(costumesTimer)
    models = undefined
    // Replies that arrive before our request is out belong to someone else.
    pendingDir = undefined
    if (visible) renderCostumes()
    const send = () => {
      pendingDir = dir
      ctx.link.send({ t: 'costumes', dir })
    }
    if (delayMs) costumesTimer = window.setTimeout(send, delayMs)
    else send()
  }

  function setModelsDir(dir: string) {
    // Asked before the store write: the character rescans on that write and takes the first costumes reply, which
    // is then this one, for the new folder (its own request reads settings.json, which lags the store).
    requestCostumes(dir)
    write('appearance.modelsDir', dir)
    say('Let me see what I can wear from there, {you}.', 'think')
  }

  function useDefaultModels() {
    write('appearance.modelsDir', '')
    requestCostumes('', SAVE_SETTLE_MS)
    q<HTMLInputElement>('[data-dir-input]').value = ''
  }

  function renderCostumes() {
    const s = ctx.store.get()
    // Until the link answers for the folder shown, the costumes the character already knows stand in.
    const list = models ? costumes : ctx.character.costumes()
    const grid = q('[data-seg="appearance.costume"]')
    paint(grid, list.map((c) => `<button type="button" data-v="${esc(c.id)}"><b>${esc(c.label)}</b><small>${esc(c.id)}</small></button>`).join(''))
    q('[data-costume-empty]').hidden = list.length > 0
    const found = q('[data-test="models-found"]')
    found.classList.toggle('bad', !!models && !models.found)
    const where = models && (s.appearance.modelsDir ? models.dir : `the default folder, ${models.dir}`)
    found.textContent = !models
      ? 'Looking for models…'
      : models.found
        ? `✓ ${list.length} costume${list.length === 1 ? '' : 's'} found in ${where}`
        : `✕ No Live2D models found${models.dir ? ` in ${where}` : ''}. Choose the folder that holds your costume folders.`
    paintSeg(grid, s)
  }

  function renderCards() {
    const el = q('[data-test="cards-list"]')
    if (!deck) return
    if (!deck.list.length) return paint(el, '<p class="set-empty">No cards yet.</p>')
    const active = deck.active
    // The card in use shows her live settings: the list the link sent may predate an edit, and repainting it when the
    // fresh one comes would swallow a click on it.
    const s = ctx.store.get()
    const live = (c: CardSummary): CardSummary =>
      c.id !== active ? c : { ...c, name: s.waifu.name.trim() || 'Unnamed', series: s.waifu.series.trim(), model: s.appearance.model, voiced: !!s.voice.voiceId.trim() }
    const hearts = (n: number) => `<span class="set-hearts" title="Love meter ${n}/${AFFECTION_LEVELS}">${'♥'.repeat(n)}<i>${'♥'.repeat(AFFECTION_LEVELS - n)}</i></span>`
    paint(
      el,
      deck.list
        .map(live)
        // Sorted here, after her live name: rows that swap places when the link's list comes would misdirect a click.
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
        .map((c) => {
          const on = c.id === active
          const tags = [c.model === 'mmd' ? '3D (MMD)' : 'Live2D', c.voiced ? 'Voiced' : 'No voice'].map((t) => `<em>${t}</em>`).join('')
          return `<div class="set-wcard${on ? ' on' : ''}" data-test="card-row" data-wcard="${esc(c.id)}">
            <div class="set-wcard-main"><b>${esc(c.name)}</b>${on ? '<span class="set-wcard-active">In use</span>' : ''}
              <small>${esc(c.series || '—')}</small><div class="set-wcard-tags">${hearts(c.hearts)}${tags}</div></div>
            <div class="set-wcard-acts">
              ${on ? '' : `<button class="btn" type="button" data-act="card-switch" data-id="${esc(c.id)}" data-test="card-switch">Switch</button>`}
              <button class="btn" type="button" data-act="card-export" data-id="${esc(c.id)}" data-test="card-export">Export…</button>
              ${on ? '' : `<button class="btn" type="button" data-act="card-delete" data-id="${esc(c.id)}" data-test="card-delete">Delete</button>`}
            </div></div>`
        })
        .join(''),
    )
  }

  function renderAbout() {
    if (!about) return
    q('[data-test="about-version"]').textContent = `Version ${about.version}`
    q('[data-about-data]').textContent = about.dataDir
    q('[data-about-logs]').textContent = logsDir()
    for (const b of qa<HTMLButtonElement>('[data-act^="reveal-"]')) b.disabled = false
  }

  /** Opens a folder in Explorer. The link answers only when it can't (the logs folder may not exist yet). */
  function reveal(path: string) {
    ctx.link
      .next((m): m is Extract<ServerMsg, { t: 'app_error' }> => m.t === 'app_error', REVEAL_WAIT_MS)
      .then((m) => ctx.toast(`Couldn't open it: ${m.message}`), () => undefined)
    ctx.link.send({ t: 'reveal', path })
  }

  const logsDir = () => (about ? `${about.dataDir}${about.dataDir.includes('\\') ? '\\' : '/'}logs` : '')

  function renderStatus() {
    const el = q('[data-test="research-status"]')
    const sec = Math.floor((Date.now() - research.startedAt) / MS_PER_S)
    el.textContent = research.running ? `Researching… ${Math.floor(sec / S_PER_MIN)}:${String(sec % S_PER_MIN).padStart(2, '0')}` : ''
  }

  function renderResearch() {
    q('[data-act="research-start"]').hidden = research.running
    q('[data-act="research-cancel"]').hidden = !research.running
    for (const el of qa<Field>('[data-research]')) el.disabled = research.running
    renderStatus()
    const log = q('[data-test="research-progress"]')
    log.hidden = research.log.length === 0
    log.innerHTML = research.log.map((l) => `<div>${esc(l)}</div>`).join('')
    log.scrollTop = log.scrollHeight
    const err = q('[data-test="research-error"]')
    err.hidden = !research.error
    err.textContent = research.error ? `✕ ${research.error}` : ''
    renderCard(ctx.store.get())
  }

  function renderLibrary(s: Settings) {
    if (renaming) return
    const lib = q('[data-lib]')
    const presets = [...s.presets].sort((a, b) => b.createdAt - a.createdAt)
    paint(lib, presets.length
      ? presets
          .map((p) => {
            const active = s.waifu.activePreset === p.id
            return `<div class="set-preset ${active ? 'active' : ''} ${cardId === p.id ? 'open' : ''}" data-test="preset-item" data-id="${esc(p.id)}">
              <button type="button" class="set-preset-main" data-act="preset-edit" data-id="${esc(p.id)}" title="Open in the editor">
                <b>${esc(p.name)}</b>${active ? '<em>Active</em>' : ''}<small>${esc(p.series || '—')} · ${new Date(p.createdAt).toLocaleDateString()}</small>
              </button>
              <button type="button" class="btn" data-act="preset-apply" data-id="${esc(p.id)}" data-test="preset-apply">Apply</button>
              <button type="button" class="btn" data-act="preset-rename" data-id="${esc(p.id)}" data-test="preset-rename" title="Rename">✎</button>
              <button type="button" class="btn danger" data-act="preset-delete" data-id="${esc(p.id)}" data-test="preset-delete" title="Delete">✕</button>
            </div>`
          })
          .join('')
      : '<p class="set-empty">No presets yet. Research a character to create one.</p>')
    q<HTMLButtonElement>('[data-act="preset-handwritten"]').disabled = !s.waifu.activePreset
  }

  /** The rename input replaced library markup behind paint()'s back, so the library is repainted in full next time. */
  function stopRename() {
    renaming = ''
    painted.delete(q('[data-lib]'))
  }

  function startRename(id: string) {
    const p = presetOf(id)
    const main = root.querySelector(`[data-test="preset-item"][data-id="${CSS.escape(id)}"] .set-preset-main`)
    if (!p || !main) return
    renaming = id
    const input = document.createElement('input')
    input.className = 'field'
    input.value = p.name
    input.maxLength = CHARACTER_NAME_MAX_LEN
    input.dataset.test = 'preset-rename-input'
    main.replaceWith(input)
    input.focus()
    input.select()
    const done = (save: boolean) => {
      if (renaming !== id) return
      stopRename()
      const name = input.value.trim()
      if (save && name) ctx.store.update((s) => void (presetOf(id, s)!.name = name))
      sync()
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(true)
      if (e.key === 'Escape') e.preventDefault(), done(false)
    })
    input.addEventListener('blur', () => done(true))
  }

  function renderCard(s: Settings) {
    const box = q('[data-test="research-result"]')
    const p = presetOf(cardId, s)
    if (!p) {
      renderedCardId = undefined
      box.classList.add('empty')
      box.innerHTML = `<div class="set-rp-placeholder"><b>✦</b><p>Research a character, or open one from your library.<br>
        The profile and roleplay prompt appear here, ready to edit.</p></div>`
      return
    }
    if (renderedCardId !== p.id) {
      renderedCardId = p.id
      box.classList.remove('empty')
      const list = (k: ListField, rows: number) =>
        `<label class="set-cf"><span>${LIST_LABELS[k]}<small>one per line</small></span><textarea class="field" data-card="${k}" rows="${rows}"></textarea></label>`
      box.innerHTML = `
        <div class="set-rp-head">
          <input class="field set-rp-name" data-card="name" data-test="research-result-name" maxlength="${CHARACTER_NAME_MAX_LEN}" title="Name">
          <input class="field" data-card="series" maxlength="${SERIES_MAX_LEN}" title="Series">
          <em class="set-badge" data-card-active>Active</em>
        </div>
        <div class="set-rp-body">
          <label class="set-cf"><span>Summary</span><textarea class="field" data-card="summary" rows="3"></textarea></label>
          <div class="set-rp-grid">${list('personality', 4)}${list('speechPatterns', 4)}</div>
          <div class="set-rp-grid">${list('catchphrases', 3)}<label class="set-cf"><span>Addressing<small>how she calls people</small></span>
            <textarea class="field" data-card="addressing" rows="3"></textarea></label></div>
          ${list('relationshipCues', 3)}
          <div class="set-rp-grid">${list('do', 4)}${list('dont', 4)}</div>
          ${list('sampleLines', 4)}
          <label class="set-cf"><span>Roleplay prompt<small>used word for word while this preset is active</small></span>
            <textarea class="field mono" data-card="prompt" data-test="research-prompt" rows="10"></textarea></label>
          <div class="set-sources"><span>Sources<small>click to copy</small></span>
            ${p.sources.map((u) => `<button type="button" data-act="copy-source" data-url="${esc(u)}" title="${esc(u)}">${esc(shortUrl(u))}</button>`).join('') || '<small>none</small>'}
          </div>
        </div>
        <div class="set-actions set-rp-actions">
          <button class="btn primary" type="button" data-act="preset-apply" data-id="${esc(p.id)}" data-test="research-apply">Apply to her</button>
          <button class="btn" type="button" data-act="card-save" data-test="research-save">Save edits</button>
          <button class="btn danger" type="button" data-act="preset-delete" data-id="${esc(p.id)}" data-test="research-delete">Delete</button>
        </div>`
    }
    for (const el of qa<Field>('[data-card]')) if (el !== document.activeElement) el.value = cardValue(p, el.dataset.card!)
    q('[data-card-active]').hidden = s.waifu.activePreset !== p.id
  }

  function paintSeg(g: HTMLElement, s: Settings) {
    const v = String(getAt(s, g.dataset.seg!) ?? '')
    g.dataset.value = v
    for (const b of g.querySelectorAll<HTMLElement>('[data-v]')) b.classList.toggle('on', sameValue(b.dataset.v!, v))
  }

  /** Paints every control from the store. Fields being edited are left alone so the caret never jumps. */
  /** Whether she can speak, and why not. */
  function renderVoice(s = ctx.store.get()) {
    const el = root.querySelector<HTMLElement>('[data-voice-status]')
    if (!el) return
    const key = ctx.voice.hasKey()
    const state = !key ? 'nokey' : !s.voice.enabled ? 'off' : !s.voice.voiceId.trim() ? 'novoice' : 'on'
    el.dataset.state = state
    el.textContent = {
      nokey: '♫ Off · no Fish Audio key stored. Add one below and she speaks from the next session.',
      off: '♫ Off · a key is stored; turn her voice on to hear her.',
      novoice: '♫ Off · pick a voice id.',
      on: `♫ On · ${s.voice.language === 'ja' ? 'Japanese voice, English text' : 'she reads her lines'} · ${s.voice.model === 's2.1-pro' ? 'paid model' : 'free model'}`,
    }[state]
    q<HTMLButtonElement>('[data-act="voice-key-remove"]').disabled = !key
    q<HTMLButtonElement>('[data-act="voice-test"]').disabled = !key || !s.voice.voiceId.trim()
  }

  /** Which model answers in casual mode, and why. */
  function renderCasual(s = ctx.store.get()) {
    const el = root.querySelector<HTMLElement>('[data-casual-status]')
    if (!el) return
    const key = ctx.casual.hasKey()
    const api = s.casual.provider === 'openai' && key
    el.dataset.state = api ? 'on' : 'off'
    el.textContent = api
      ? `♡ ${s.casual.model.trim() || 'gpt-6-luna'} answers · key stored · Claude steps in if it fails`
      : `♡ Claude (${s.casual.claudeModel.trim() || 'sonnet'}) answers through your subscription${s.casual.provider === 'openai' ? ' · no API key stored yet' : ''}`
    q<HTMLButtonElement>('[data-act="casual-key-remove"]').disabled = !key
  }

  /** Phone access: on the desktop its switch, status and pairing code; on a phone, what it is paired with. */
  function renderPhone() {
    const remote = ctx.link.remote
    q('[data-phone-desktop]').hidden = remote
    q('[data-phone-remote]').hidden = !remote
    if (remote) {
      const p = savedPairing()
      q('[data-phone-paired]').textContent = `☏ Paired with your computer${p ? ` at ${p.hosts[0]}` : ''}`
      q<HTMLInputElement>('[data-lowspec]').checked = lowSpec()
      return
    }
    const st = phone
    q<HTMLInputElement>('[data-phone-enabled]').checked = !!st?.enabled
    const el = q('[data-phone-status]')
    el.dataset.state = st?.listening ? 'on' : 'off'
    el.textContent = !st?.enabled
      ? '☏ Off · nothing can connect from outside this computer.'
      : st.error
        ? `☏ Couldn't start: ${st.error}`
        : `☏ On · ${st.clients ? `${st.clients} phone${st.clients === 1 ? '' : 's'} connected` : 'waiting for your phone'} · ${st.addresses.map((a) => `${a}:${st.port}`).join(' · ') || 'no network address'}`
    const devices = st?.devices ?? []
    q('[data-phone-devices]').hidden = !st?.enabled || !devices.length
    const ago = (t: number) => {
      const m = Math.round((Date.now() - t) / 60_000)
      return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`
    }
    paint(
      q('[data-test="phone-devices"]'),
      devices
        .map((d) => `<div class="set-device" data-test="phone-device" data-id="${esc(d.id)}">
          <span><b>${esc(d.name)}</b><small>${d.online ? '● connected' : `last seen ${ago(d.lastSeen)}`} · paired ${new Date(d.pairedAt).toLocaleDateString()}</small></span>
          <button class="btn" type="button" data-act="phone-forget" data-id="${esc(d.id)}" data-test="phone-forget">Remove</button></div>`)
        .join(''),
    )
    const pairing = !!(st?.listening && st.pairUrl)
    q('[data-phone-pair]').hidden = !pairing
    const qr = q('[data-phone-qr]')
    if (pairing && qr.dataset.url !== st!.pairUrl) {
      const code = qrcode(0, 'M')
      code.addData(st!.pairUrl!)
      code.make()
      qr.innerHTML = code.createSvgTag({ cellSize: 6, margin: 3, scalable: true })
      qr.dataset.url = st!.pairUrl!
    }
  }

  /** Whether Slack is signed in, and as whom; which buttons apply. */
  function renderSlack() {
    const el = root.querySelector<HTMLElement>('[data-slack-status]')
    if (!el) return
    const st = ctx.slack.status()
    const state = st.signingIn ? 'waiting' : st.signedIn ? 'on' : 'off'
    el.dataset.state = state === 'on' ? 'on' : 'off'
    el.textContent = state === 'waiting'
      ? '✉ Waiting for you to approve the sign-in in your browser…'
      : state === 'on'
        ? `✉ Signed in to ${st.team} as ${st.user}`
        : `✉ Not signed in${st.error ? ` · ${st.error}` : ''}`
    q<HTMLButtonElement>('[data-act="slack-signin"]').hidden = state === 'waiting'
    q<HTMLButtonElement>('[data-act="slack-signin"]').textContent = state === 'on' ? 'Sign in again' : 'Sign in with Slack'
    q<HTMLButtonElement>('[data-act="slack-cancel"]').hidden = state !== 'waiting'
    q<HTMLButtonElement>('[data-act="slack-signout"]').disabled = state !== 'on'
  }

  /** Speaks the sample line through the link, with her lips on it, and says why when it can't. */
  async function testVoice() {
    const s = ctx.store.get()
    const line = s.voice.language === 'ja' ? VOICE_SAMPLE.ja : fill(VOICE_SAMPLE.en)
    const btn = q<HTMLButtonElement>('[data-act="voice-test"]')
    btn.disabled = true
    btn.textContent = '… Asking Fish Audio'
    try {
      const clip = await ctx.voice.clip(line)
      say(s.voice.language === 'ja' ? 'This is how I sound, {you}.' : VOICE_SAMPLE.en, 'smile')
      const pb = ctx.voice.play(clip)
      ctx.character.setVoiceLevel(() => pb.level())
      pb.onEnd(() => ctx.character.setVoiceLevel(undefined))
    } catch (e) {
      ctx.toast(`Her voice didn't come: ${e instanceof Error ? e.message : e}`, 6000)
      react('worried')
    } finally {
      btn.textContent = '▶ Test voice'
      renderVoice()
    }
  }

  function sync(s = ctx.store.get()) {
    for (const el of qa<Field>('[data-bind]')) {
      if (el === document.activeElement && !(el instanceof HTMLInputElement && el.type === 'checkbox')) continue
      const v = getAt(s, el.dataset.bind!)
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!v
      else if (el instanceof HTMLInputElement && el.type === 'range') {
        el.value = String(el.dataset.conv ? CONVERTERS[el.dataset.conv].toInput(Number(v)) : v)
      } else if (el instanceof HTMLInputElement && el.type === 'color') {
        if (isHexColor(String(v))) el.value = String(v)
      } else el.value = String(v ?? '')
    }
    for (const el of qa('[data-out]')) el.textContent = FORMAT[el.dataset.out!]?.(Number(getAt(s, el.dataset.out!))) ?? ''
    for (const g of qa('[data-seg]')) paintSeg(g, s)
    renderVoice(s)
    renderCasual(s)
    renderSlack()
    for (const el of qa('[data-when]')) {
      const [path, v] = el.dataset.when!.split('=')
      el.hidden = String(getAt(s, path)) !== v
    }

    // You
    const addr = addressOf(s)
    paint(q('[data-test="address-preview"]'), `${esc(s.waifu.name || 'She')} will call you: <b>${esc(addr)}</b>`)
    const avatar = s.profile.avatar ? `<img src="${esc(s.profile.avatar)}" alt="">` : `<span>${esc((s.profile.displayName || '?').slice(0, 1))}</span>`
    paint(q('[data-test="avatar-preview"]'), avatar)
    paint(q('[data-plate-av]'), avatar)
    q<HTMLButtonElement>('[data-act="avatar-remove"]').disabled = !s.profile.avatar
    q('[data-plate-name]').textContent = s.profile.displayName || addr
    q('[data-plate-line]').textContent = [s.profile.title, s.profile.pronouns].filter(Boolean).join(' · ') || '…'

    // Waifu
    paint(
      q('[data-chip-list]'),
      s.waifu.catchphrases
        .map((c, i) => `<span class="set-chip">${esc(c)}<button type="button" data-act="chip-remove" data-i="${i}" title="Remove">×</button></span>`)
        .join(''),
    )
    const active = presetOf(s.waifu.activePreset, s)
    const personality = personalityById(s.waifu.personalityPreset)
    paint(
      q('[data-test="persona-active"]'),
      active
        ? `✦ Active persona: research preset <b>${esc(active.name)}</b>. Its roleplay prompt is used as written; the speech settings below still apply.
          <button type="button" class="btn" data-act="edit-active">Edit in Roleplay</button>`
        : `✿ Active persona: hand-written, <b>${esc(personality?.label ?? 'Custom')}</b> personality. Changes apply from the next session.`,
    )
    const dirInput = q<HTMLInputElement>('[data-dir-input]')
    if (dirInput !== document.activeElement) dirInput.value = s.appearance.modelsDir

    // Roleplay, Appearance, Claude
    renderLibrary(s)
    renderCard(s)
    q('[data-costume-empty]').hidden = qa('[data-seg="appearance.costume"] [data-v]').length > 0
    const known = MODEL_ALIASES.some((o) => o.v === s.claude.model)
    const isCustom = customModel || !known
    q<HTMLSelectElement>('[data-model-select]').value = isCustom ? CUSTOM_MODEL : s.claude.model
    const custom = q<HTMLInputElement>('[data-model-custom]')
    custom.hidden = !isCustom
    if (custom !== document.activeElement) custom.value = isCustom ? s.claude.model : ''
    for (const c of qa<HTMLInputElement>('[data-source]')) c.checked = s.claude.settingSources.includes(c.dataset.source as 'user')
    q('[data-last-dir]').textContent = s.lastDir ? `Last used: ${s.lastDir}` : ''

    // The preview box under her
    q('[data-preview-name]').textContent = s.waifu.name || '…'
  }

  // ---------------------------------------------------------------- actions

  /** Return and Esc: back into a running session when opened from one (/config), else the router's previous screen. */
  function goBack() {
    if (openedFrom === 'chat') ctx.router.go('chat')
    else ctx.router.back()
  }

  async function act(el: HTMLElement) {
    const id = el.dataset.id ?? ''
    switch (el.dataset.act) {
      case 'tab':
        return setTab(el.dataset.tab as TabId)
      case 'return':
        return goBack()
      case 'edit-active':
        cardId = ctx.store.get().waifu.activePreset
        renderedCardId = undefined
        sync()
        return setTab('roleplay')
      case 'reset': {
        const reset = RESET[tab]
        const info = TABS.find((t) => t.id === tab)!
        if (!reset || !(await ctx.confirm(`Reset ${info.label}?`, `Every ${info.label} setting goes back to its default.`, 'Reset', 'Cancel'))) return
        // A reset costume is swapped in by the character, which watches the store.
        ctx.store.update(reset)
        customModel = false
        return say('All back to how it was, {you}.', 'nod')
      }
      case 'avatar-pick': {
        const [img] = await ctx.pickImages(false)
        if (!img) return
        try {
          write('profile.avatar', await cropAvatar(img.dataUrl))
          say('Is that you, {you}? You look wonderful.', 'shy')
        } catch {
          ctx.toast('That image could not be read. Try a PNG, JPEG, GIF or WebP.')
        }
        return
      }
      case 'avatar-remove':
        return write('profile.avatar', '')
      case 'chip-remove':
        return ctx.store.update((s) => void s.waifu.catchphrases.splice(Number(el.dataset.i), 1))
      case 'models-browse': {
        const dir = await ctx.pickFolder('Where are your Live2D models?', ctx.store.get().appearance.modelsDir)
        if (dir) setModelsDir(dir)
        return
      }
      case 'models-default':
        return useDefaultModels()
      case 'mmd-browse': {
        if (ctx.link.remote) return ctx.toast('Pick her model on the computer itself.')
        const file = await ctx.pickFile('Where is her 3D model?', 'MMD model', ['pmx'], ctx.store.get().appearance.mmdFile)
        if (file) write('appearance.mmdFile', file)
        return
      }
      case 'card-switch': {
        const c = deck?.list.find((x) => x.id === id)
        if (!c) return
        commitFocused()
        ctx.store.flush()
        cardAskAt = Date.now()
        return ctx.link.send({ t: 'card_switch', id })
      }
      case 'card-new':
      case 'card-copy':
        commitFocused()
        ctx.store.flush()
        cardAskAt = Date.now()
        return ctx.link.send({ t: 'card_new', ...(el.dataset.act === 'card-copy' ? { from: ctx.store.get().card } : {}) })
      case 'card-delete': {
        const c = deck?.list.find((x) => x.id === id)
        if (!c) return
        const yes = await ctx.confirm(
          `Delete ${c.name}'s card?`,
          'Her persona, model choice, voice and love meter go. What she remembers about you stays in the data folder.',
          'Delete',
          'Keep',
        )
        if (yes) {
          cardAskAt = Date.now()
          ctx.link.send({ t: 'card_delete', id })
        }
        return
      }
      case 'card-export': {
        if (ctx.link.remote) return ctx.toast('Export cards on the computer itself.')
        const c = deck?.list.find((x) => x.id === id)
        if (!c) return
        const file = `${c.name.replace(/[\\/:*?"<>|]+/g, '').trim() || 'waifu'}.waifu.json`
        const path = await ctx.pickSavePath(`Export ${c.name}'s card`, file, 'Waifu card', ['json'])
        if (path) ctx.link.send({ t: 'card_export', id, path })
        return
      }
      case 'card-import': {
        if (ctx.link.remote) return ctx.toast('Import cards on the computer itself.')
        const path = await ctx.pickFile('Import a waifu card', 'Waifu card', ['json'])
        if (path) ctx.link.send({ t: 'card_import', path })
        return
      }
      case 'dir-browse': {
        const s = ctx.store.get()
        const dir = await ctx.pickFolder('Where should she work by default?', s.claude.defaultDir || s.lastDir)
        if (dir) write('claude.defaultDir', dir)
        return
      }
      case 'dir-clear':
        return write('claude.defaultDir', '')
      case 'cps-default':
        write('motion.textCps', CPS_SPEECH)
        return say(SPEED_SAMPLE)
      case 'sample':
        return say(SPEED_SAMPLE)
      case 'voice-key-save': {
        const input = q<HTMLInputElement>('[data-voice-key]')
        if (!input.value.trim()) return ctx.toast('Paste a Fish Audio API key first.')
        ctx.voice.setKey(input.value.trim())
        input.value = ''
        ctx.toast('Key saved. Her voice starts with the next session.')
        return react('happy')
      }
      case 'casual-key-save': {
        const input = q<HTMLInputElement>('[data-casual-key]')
        if (!input.value.trim()) return ctx.toast('Paste an API key first.')
        ctx.casual.setKey(input.value.trim())
        input.value = ''
        ctx.toast('Key saved. Casual mode uses it from her next reply.')
        return react('happy')
      }
      case 'casual-key-remove':
        ctx.casual.setKey('')
        ctx.toast('Key removed. Claude answers in casual mode now.')
        return react('nod')
      case 'voice-key-remove':
        ctx.voice.setKey('')
        ctx.toast('Key removed. She stays silent from the next session.')
        return react('sad')
      case 'voice-test':
        return void testVoice()
      case 'research-start':
        return startResearch()
      case 'research-cancel':
        return cancelResearch()
      case 'preset-edit':
        cardId = id
        renderedCardId = undefined
        sync()
        return q('[data-test="research-result"]').scrollTo({ top: 0 })
      case 'preset-apply':
        return applyPreset(id)
      case 'preset-rename':
        return startRename(id)
      case 'preset-delete':
        return deletePreset(id)
      case 'preset-handwritten':
        ctx.store.update((s) => void (s.waifu.activePreset = ''))
        ctx.toast('Back to the hand-written persona from the Waifu tab, from the next session.')
        return react('smile')
      case 'card-save':
        flushCard()
        return ctx.toast('Saved to your preset library.')
      case 'slack-signin': {
        const id = ctx.store.get().slack.clientId.trim()
        if (!id) return ctx.toast('Paste the Slack app\'s client ID first (step 3 below).')
        return ctx.slack.signIn(id)
      }
      case 'slack-cancel':
        return ctx.slack.cancelSignIn()
      case 'slack-signout':
        ctx.slack.signOut()
        return ctx.toast('Signed out of Slack.')
      case 'slack-copy-manifest':
        return navigator.clipboard.writeText(SLACK_MANIFEST).then(
          () => ctx.toast('Manifest copied. Paste it at api.slack.com/apps.'),
          () => ctx.toast('Couldn\'t copy the manifest; select it and copy by hand.'),
        )
      case 'phone-copy':
        return navigator.clipboard.writeText(phone?.pairUrl ?? '').then(
          () => ctx.toast('Pairing link copied. Paste it into the app on your phone.'),
          () => ctx.toast('Couldn\'t copy the pairing link.'),
        )
      case 'phone-reset':
        return void ctx
          .confirm('New pairing code?', 'New phones scan the new code. Phones already paired stay paired: remove one below to cut it off.', 'New code', 'Keep this one')
          .then((yes) => yes && ctx.link.send({ t: 'remote_reset' }))
      case 'phone-forget': {
        const d = phone?.devices.find((x) => x.id === el.dataset.id)
        if (!d) return
        return void ctx
          .confirm(`Remove ${d.name}?`, 'It is disconnected now, and can only connect again by scanning the pairing code.', 'Remove', 'Keep')
          .then((yes) => yes && ctx.link.send({ t: 'remote_forget', id: d.id }))
      }
      case 'phone-unpair':
        clearPairing()
        return location.reload()
      case 'slack-apps':
        return ctx.link.send({ t: 'open', target: 'https://api.slack.com/apps' })
      case 'copy-source':
        return navigator.clipboard.writeText(el.dataset.url ?? '').then(
          () => ctx.toast('Link copied.'),
          () => ctx.toast('Couldn\'t copy the link.'),
        )
      case 'reveal-data':
        return about && reveal(about.dataDir)
      case 'reveal-logs':
        return about && reveal(logsDir())
      case 'wizard':
        return ctx.router.go('wizard')
    }
  }

  function onClick(e: MouseEvent) {
    const t = e.target as HTMLElement
    const option = t.closest<HTMLElement>('[data-seg] [data-v]')
    if (option) {
      const path = option.closest<HTMLElement>('[data-seg]')!.dataset.seg!
      if (sameValue(String(getAt(ctx.store.get(), path)), option.dataset.v!)) return
      write(path, option.dataset.v)
      return commit(path)
    }
    const button = t.closest<HTMLElement>('[data-act]')
    if (button && !(button as HTMLButtonElement).disabled) return void act(button)
    // Clicking the preview box finishes the line, like the dialogue box.
    if (t.closest('[data-preview]')) {
      const box = q('[data-preview-text]')
      stopTyping()
      box.textContent = box.dataset.full ?? ''
    }
  }

  function onKey(e: KeyboardEvent) {
    // The Enter or comma that confirms an IME conversion (kana → kanji) isn't the user's Enter.
    if (!visible || e.defaultPrevented || e.isComposing || e.keyCode === IME_KEYCODE) return
    const t = e.target as HTMLElement
    if (e.key === 'Tab' && e.ctrlKey) {
      e.preventDefault()
      const i = TABS.findIndex((x) => x.id === tab)
      return setTab(TABS[(i + (e.shiftKey ? -1 : 1) + TABS.length) % TABS.length].id)
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && t.dataset.test === 'settings-tab') {
      e.preventDefault()
      const i = TABS.findIndex((x) => x.id === tab)
      const next = TABS[(i + (e.key === 'ArrowDown' ? 1 : -1) + TABS.length) % TABS.length].id
      setTab(next)
      return q(`[data-test="settings-tab"][data-tab="${next}"]`).focus()
    }
    if (t.dataset.chipInput !== undefined) {
      const input = t as HTMLInputElement
      if (e.key === 'Enter') {
        e.preventDefault()
        return addChip(input)
      }
      if (e.key === 'Backspace' && !input.value) {
        ctx.store.update((s) => void s.waifu.catchphrases.pop())
      }
    }
    if (e.key === 'Enter' && t.dataset.research && t.tagName === 'INPUT') return startResearch()
  }

  // ---------------------------------------------------------------- lifecycle

  return {
    mount(el, c) {
      root = el
      ctx = c
      root.innerHTML = `
        <header class="set-head">
          <h2 class="title-text">CONFIG</h2>
          <span>設定 · make her yours</span>
        </header>
        <nav class="set-nav panel">
          ${TABS.map((t) => `<button type="button" data-test="settings-tab" data-tab="${t.id}" data-act="tab"><i>${t.icon}</i>${t.label}</button>`).join('')}
        </nav>
        <main class="set-body panel">
          <div class="set-body-head">
            <div><h3 data-pane-title></h3><p data-pane-blurb></p></div>
            <button class="btn" type="button" data-act="reset" data-test="settings-reset">Reset section to defaults</button>
          </div>
          ${TABS.map((t) => `<div class="set-pane" data-pane="${t.id}" hidden>${PANES[t.id]()}</div>`).join('')}
        </main>
        <footer class="set-foot">
          <button class="btn" type="button" data-act="return" data-test="settings-return">◂ Return</button>
          <span>Changes save automatically · Ctrl+Tab next tab · Esc return</span>
        </footer>
        <div class="set-preview" data-preview data-test="settings-preview">
          <div class="set-preview-plate" data-preview-name></div>
          <p class="set-preview-text" data-preview-text></p>
        </div>`
      root.addEventListener('input', (e) => onField(e.target, false))
      root.addEventListener('change', (e) => onField(e.target, true))
      root.addEventListener('focusout', (e) => {
        // A custom model id left empty changes nothing, so the select goes back to the model still in use.
        const t = e.target
        if (!(t instanceof HTMLInputElement) || t.dataset.modelCustom === undefined || t.value.trim()) return
        customModel = false
        sync()
      })
      root.addEventListener('click', onClick)
      addEventListener('keydown', onKey)
      ctx.link.on(onServer)
      // Phone access isn't a setting (its state and token live in the link): the switch asks the link directly.
      root.addEventListener('change', (e) => {
        const t = e.target as HTMLInputElement
        // Low-spec mode is this phone's own: it reloads the app into the other mode.
        if (t.dataset.lowspec !== undefined) return setLowSpec(t.checked)
        if (t.dataset.phoneEnabled === undefined) return
        ctx.link.send({ t: 'remote_set', enabled: t.checked })
        if (t.checked) react('happy')
      })
      if (!ctx.link.remote) ctx.link.send({ t: 'remote_status' })
      renderPhone()
      // A finished sign-in is the one change she reacts to; the rest only repaints the status.
      let slackWas = ctx.slack.status().signedIn
      ctx.slack.onChange(() => {
        const now = ctx.slack.status().signedIn
        if (visible && now && !slackWas) react('happy')
        slackWas = now
        if (visible) renderSlack()
      })
      // A restarted link (R24) forgets the research it was running, so no result or error will ever come.
      ctx.link.onStatus((status) => {
        if (status !== 'down') return
        cancelPending = false
        if (!research.running) return
        research.running = false
        research.error = 'The link restarted, so the research stopped. Please try again.'
        ctx.character.setBusy(false)
        if (visible) renderResearch()
      })
      // The router doesn't say where a screen was opened from; #stage's data-screen does, one change at a time.
      const stage = document.getElementById('stage')
      if (stage) {
        new MutationObserver((records) =>
          records.forEach((r, i) => {
            const now = records[i + 1]?.oldValue ?? stage.dataset.screen
            if (now === 'settings' && r.oldValue !== 'settings') openedFrom = r.oldValue ?? undefined
          }),
        ).observe(stage, { attributes: true, attributeFilter: ['data-screen'], attributeOldValue: true })
      }
      ctx.store.subscribe((s) => {
        if (!visible) return
        sync(s)
        if (tab === 'waifu') schedulePreview()
        if (tab === 'cards') renderCards()
      })
    },
    show(params) {
      visible = true
      ctx.character.setPlacement('side')
      const s = ctx.store.get()
      customModel = !MODEL_ALIASES.some((o) => o.v === s.claude.model)
      if (s.waifu.personalityPreset === CUSTOM_PERSONALITY) customText = s.waifu.personality
      if (research.running) {
        ctx.character.setBusy(true)
        startClock()
      }
      const wanted = params?.tab as TabId | undefined
      sync()
      renderResearch()
      renderCostumes()
      renderAbout()
      setTab(wanted && TABS.some((t) => t.id === wanted) ? wanted : tab)
      q<HTMLElement>(`[data-test="settings-tab"][data-tab="${tab}"]`).focus()
    },
    hide() {
      commitFocused()
      visible = false
      stopTyping()
      clearTimeout(previewTimer)
      clearInterval(clockTimer)
      if (research.running) ctx.character.setBusy(false)
      stopRename()
    },
    onEscape() {
      if (renaming) {
        stopRename()
        sync()
        return true
      }
      goBack()
      return true
    },
  }
}
