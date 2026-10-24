// The Config screen (R38–R46): tabs on the left, the live character on the right reacting to every change,
// and a preview dialogue box under her that shows text size, opacity and speed as they are tuned.
// Every field is bound by its dotted settings path (`data-bind`), so one handler writes all of them through
// the store, and sync() paints the whole screen back from the store after each change.

import type {
  Appearance, ClaudeSettings, Costume, Emotion, MotionSettings, PersonaPreset, Profile, ResearchProfile, ServerMsg, Settings, Waifu,
} from '../../../link/src/protocol.ts'
import { addressOf } from '../../../link/src/address.ts'
import type { Ctx, Screen } from '../contracts'
import { esc } from '../ui'
import { CUSTOM_PERSONALITY, PERSONALITIES, personalityById } from './personas'
import './settings.css'

// ---------------------------------------------------------------- data

const TABS = [
  { id: 'you', label: 'You', icon: '♡', blurb: 'Who you are to her: your name, how she addresses you, your nameplate.' },
  { id: 'waifu', label: 'Waifu', icon: '✿', blurb: 'Her name, personality and way of speaking.' },
  { id: 'roleplay', label: 'Roleplay', icon: '✦', blurb: 'Research any character and turn them into a persona preset.' },
  { id: 'appearance', label: 'Appearance', icon: '❀', blurb: 'Theme, colors, the dialogue box, the scene and her costume.' },
  { id: 'motion', label: 'Text & Motion', icon: '♪', blurb: 'How fast she talks and how alive she feels.' },
  { id: 'claude', label: 'Claude', icon: '⚙', blurb: 'Defaults for new sessions, passed straight to Claude Code.' },
  { id: 'voice', label: 'Voice', icon: '♫', blurb: 'Spoken lines for the dialogue.' },
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
  appearance: { theme: 'system', accent: '#5b8de0', fontSize: 21, boxOpacity: 0.94, background: 'auto', petals: true, costume: 'ac_base_rem01', zoom: 1 },
  motion: {
    textCps: 14, punctuationPauses: true, autoDelayMs: 1200, lipSync: true, idle: true, cursor: true, headpats: true, taps: true, gestures: true,
  },
  claude: { model: '', permissionMode: 'default', defaultDir: '', settingSources: ['user', 'project', 'local'] },
  voice: { provider: 'off' },
}

/** What "Reset section to defaults" restores on each tab. Roleplay, Voice and About hold nothing to reset. */
const RESET: Partial<Record<TabId, (s: Settings) => void>> = {
  you: (s) => void (s.profile = structuredClone(DEFAULTS.profile)),
  waifu: (s) => void (s.waifu = structuredClone(DEFAULTS.waifu)),
  appearance: (s) => void (s.appearance = { ...structuredClone(DEFAULTS.appearance), modelsDir: s.appearance.modelsDir }),
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
  you: ['Tell me about yourself, {you}. I want to know everything.', 'smile'],
  waifu: ['Is this… about me? Please be gentle, {you}.', 'shy'],
  roleplay: ['Shall I study someone new? Just tell me who, {you}.', 'think'],
  appearance: ['How do I look, {you}?', 'shy'],
  motion: ['Is this pace comfortable, {you}? I can speak faster… or slower, just for you.', 'smile'],
  claude: ['These go straight to Claude Code. I\'ll use them from the next session.', 'nod'],
  voice: ['My voice… is still a secret. Soon, {you}!', 'shy'],
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
const ZOOM_MIN = 0.8
const ZOOM_MAX = 1.6
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

const card = (title: string, body: string, cls = '') => `<section class="set-card ${cls}"><h4>${title}</h4>${body}</section>`

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
    ${card('Framing', row('Sprite zoom', range('appearance.zoom', ZOOM_MIN, ZOOM_MAX, ZOOM_STEP)))}
    ${card(
      'Costume',
      `<div class="set-seg costumes" data-test="set-appearance.costume" data-seg="appearance.costume"></div>
      <p class="set-empty" data-costume-empty>No costumes found. Point the models folder below at your Live2D models.</p>`,
      'wide',
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
      row('Provider', `<select class="field" data-test="set-voice.provider" data-bind="voice.provider"><option value="off">Off</option></select>`) +
        row('AI voice provider', `<select class="field" disabled data-test="set-voice.ai"><option>AI voice providers: coming soon</option></select>`) +
        note('She doesn\'t speak aloud yet: v1 plays no audio. A later version will let you pick a text-to-speech provider and a voice that fits her, with lip sync driven by the audio.'),
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
        <li><b>Live2D models are third-party</b> and are not bundled. Bring your own and respect their licenses; the default character
          belongs to her creators and publishers.</li>
        <li>Live2D Cubism Core © Live2D Inc., under the Live2D Proprietary Software License.</li>
        <li>Rendering: PixiJS and untitled-pixi-live2d-engine. Desktop shell: Tauri.</li>
        <li>Fonts: Zen Maru Gothic, Shippori Mincho and JetBrains Mono, under the SIL Open Font License.</li>
      </ul>`,
      'wide',
    )}
  </div>`
}

const PANES: Record<TabId, () => string> = {
  you: youPane, waifu: waifuPane, roleplay: roleplayPane, appearance: appearancePane, motion: motionPane, claude: claudePane,
  voice: voicePane, about: aboutPane,
}

// ---------------------------------------------------------------- screen

export function settingsScreen(): Screen {
  let ctx: Ctx
  let root: HTMLElement
  let visible = false
  let tab: TabId = 'you'
  let costumes: Costume[] = []
  let models: { dir: string; found: boolean } | undefined
  /**
   * The folder this screen last asked the link about. The character asks too (for the saved folder), so costumes
   * replies for other folders are ignored; undefined while no request of ours is out.
   */
  let pendingDir: string | undefined
  let costumesTimer: number | undefined
  let about: { version: string; dataDir: string } | undefined
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
      case 'hello':
        about = { version: m.version, dataDir: m.dataDir }
        return void (visible && renderAbout())
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
