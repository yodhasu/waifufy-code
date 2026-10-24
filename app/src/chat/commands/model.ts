import { openMenu, type MenuResult, type MenuRow, type MenuScreen, type Tone } from '../menu'
import { control } from '../control'
import { esc } from '../../ui'
import type { CommandHost } from './index'

// /model, /effort and /fast, as the CLI 2.1.309 draws them (docs/research/cli-settings.md §4–§6): the "Select model"
// picker with its effort line, the Faster ↔ Smarter effort slider, and the fast-mode toggle. Every change runs the
// CLI's own headless command (`/model x`, `/effort x`, `/fast on|off`), so its save code and hooks run.

/** The parts of the SDK's ModelInfo the pickers read. */
type ModelInfo = {
  value: string
  resolvedModel?: string
  displayName: string
  description: string
  supportsEffort?: boolean
  supportedEffortLevels?: Level[]
  supportsFastMode?: boolean
}

type Level = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const LEVELS: Level[] = ['low', 'medium', 'high', 'xhigh', 'max']
/** The CLI's effort glyphs (bG) and slider colours (warning, success, permission, autoAccept-shimmer, rainbow). */
const GLYPH: Record<Level, string> = { low: '○', medium: '◐', high: '●', xhigh: '◉', max: '◈' }
const TONE: Record<Level, Tone> = { low: 'warn', medium: 'ok', high: 'accent', xhigh: 'accent', max: 'accent' }
const DESCRIBE: Record<Level | 'auto', string> = {
  low: 'Quick, straightforward implementation',
  medium: 'Balanced approach with standard testing',
  high: 'Comprehensive implementation with extensive testing',
  xhigh: 'Extended reasoning with thorough analysis (on supported models)',
  max: 'Maximum capability with deepest reasoning (on supported models)',
  auto: 'Use the default effort level for your model',
}
const MAX_NOTE = 'May use excessive tokens resulting in long response times or overthinking. Use sparingly for the hardest tasks.'
const CAPPED = 'Higher effort levels are capped by your settings or organization.'
const DEFAULT_LEVEL: Level = 'high'

const label = (l: Level) => (l === 'xhigh' ? 'xHigh' : l[0].toUpperCase() + l.slice(1))
const isLevel = (s: string | undefined): s is Level => LEVELS.includes(s as Level)

/** `/model`, `/effort` and `/fast`; with an argument each applies it without a panel, like the CLI. */
export function modelCommand(host: CommandHost, args: string, typed: string) {
  const arg = args.trim()
  if (arg) return void say(host, `/${typed} ${arg}`)
  if (typed === 'effort') return void openMenu(host, 'effort', effortScreen(host), 'Effort')
  if (typed === 'fast') return void openMenu(host, 'fast', fastScreen(host), 'Fast mode (research preview)')
  openMenu(host, 'model', modelScreen(host), 'Select model')
}

/** Runs a headless CLI command and toasts its answer (or its error). */
async function say(host: CommandHost, text: string) {
  try {
    host.toast((await host.cli(text)).trim() || `Ran ${text}`)
  } catch (e) {
    host.toast(e instanceof Error ? e.message : String(e))
  }
}

/** What the session runs now: the models, the current one, and the effort as `/effort current` reports it. */
async function current(host: CommandHost) {
  const [models, ctx, effort] = await Promise.all([
    control<ModelInfo[]>(host.link, 'supportedModels'),
    control<{ model?: string }>(host.link, 'getContextUsage', { detail: 'summary' }).catch(() => undefined),
    readEffort(host),
  ])
  const id = ctx?.model
  const model = models.find((m) => m.value === id) ?? models.find((m) => !!id && m.resolvedModel === id)
  return { models, model, id, effort }
}

/**
 * The CLI's `/effort current` answers "Current effort level: high (…)", "Effort level: auto (currently high)" or
 * "Effort level: auto". `auto` is true when no level is set, and `level` is then the model's own default.
 */
async function readEffort(host: CommandHost): Promise<{ level: Level; auto: boolean }> {
  const text = await host.cli('/effort current').catch(() => '')
  const set = /current effort level:\s*(\w+)/i.exec(text)?.[1]?.toLowerCase()
  if (isLevel(set)) return { level: set, auto: false }
  const now = /currently\s+(\w+)/i.exec(text)?.[1]?.toLowerCase()
  return { level: isLevel(now) ? now : DEFAULT_LEVEL, auto: true }
}

const levelsOf = (m: ModelInfo | undefined) => (m?.supportedEffortLevels?.length ? m.supportedEffortLevels : LEVELS)
/** A level the model offers: the CLI drops to `high` when a model has no max/xhigh (IVe), else to its top level. */
const clamp = (l: Level, levels: Level[]) => (levels.includes(l) ? l : levels.includes(DEFAULT_LEVEL) ? DEFAULT_LEVEL : levels.at(-1)!)

// ---------------------------------------------------------------- /model

async function modelScreen(host: CommandHost): Promise<MenuScreen> {
  const now = await current(host)
  // The effort the picker shows and ←/→ adjusts; applied with the model only when it was changed here.
  const state = { effort: now.effort.level, changed: false, focus: now.model?.value }
  const find = (id: string | undefined) => now.models.find((m) => m.value === id)

  const build = (): MenuScreen => {
    const m = find(state.focus) ?? now.model
    const supported = m ? m.supportsEffort !== false : true
    const level = clamp(state.effort, levelsOf(m))
    const isDefault = now.effort.auto && !state.changed
    const effortLine = supported
      ? `${GLYPH[level]} ${label(level)} effort${isDefault ? ' (default)' : ''} · ←/→ to adjust`
      : `${GLYPH.low} Effort not supported${m ? ` for ${m.displayName}` : ''}`
    return {
      title: 'Select model',
      subtitle: 'Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.',
      groups: [{
        rows: now.models.map((x): MenuRow => ({ id: x.value, label: x.displayName, hint: x.description, on: x === now.model })),
      }],
      search: true,
      empty: 'No models available',
      notes: [effortLine, ...(supported && level === 'max' ? [MAX_NOTE] : [])],
      reload: async () => build(),
      key(e, row) {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return false
        if (document.activeElement instanceof HTMLInputElement) return false
        const at = find(row?.id) ?? m
        if (at?.supportsEffort === false) return true
        const levels = levelsOf(at)
        const i = levels.indexOf(clamp(state.effort, levels))
        const next = levels[Math.max(0, Math.min(levels.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)))]
        Object.assign(state, { effort: next, changed: state.changed || next !== state.effort, focus: at?.value })
        return 'refresh'
      },
      async pick(row): Promise<MenuResult> {
        const x = find(row.id)
        if (!x) return
        const said = [(await host.cli(`/model ${x.value}`)).trim() || `Set model to ${x.displayName}`]
        if (state.changed && x.supportsEffort !== false) said.push((await host.cli(`/effort ${clamp(state.effort, levelsOf(x))}`)).trim())
        host.toast(said.filter(Boolean).join(' · '))
        return 'close'
      },
    }
  }
  focusLater('model', now.model?.value)
  return build()
}

// ---------------------------------------------------------------- /effort

async function effortScreen(host: CommandHost): Promise<MenuScreen> {
  const now = await current(host)
  const levels = levelsOf(now.model)
  const start = clamp(now.effort.level, levels)
  const name = now.model?.displayName ?? now.id
  focusLater('effort', start)
  return {
    title: 'Effort',
    subtitle: name ? `For ${name}` : undefined,
    // The slider's ends; the level rows below are drawn as its stops (chat.css "/model, /effort, /fast").
    body: '<div class="eff-ends" data-test="effort-ends"><span>Faster</span><span>Smarter</span></div>',
    groups: [
      {
        rows: levels.map((l): MenuRow => ({
          id: l,
          label: l,
          icon: GLYPH[l],
          tone: TONE[l],
          hint: `${DESCRIBE[l]}${l === 'max' ? ` ${MAX_NOTE}` : ''}`,
          meta: l === start && now.effort.auto ? '(default)' : undefined,
          on: l === start,
        })),
      },
      { rows: [{ id: 'auto', label: 'Use default (auto)', hint: DESCRIBE.auto, on: now.effort.auto }] },
    ],
    notes: [...(levels.length < LEVELS.length ? [CAPPED] : []), '←/→ to adjust · Enter to confirm · Esc to cancel'],
    key(e, row) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return false
      const i = levels.indexOf(isLevel(row?.id) ? row.id : start)
      const next = levels[Math.max(0, Math.min(levels.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)))]
      document.querySelector<HTMLElement>(`[data-test="effort"] .mrow[data-id="${next}"]`)?.focus()
      return true
    },
    async pick(row): Promise<MenuResult> {
      const level = row.id
      if (level !== 'auto' && level === start && !now.effort.auto) {
        host.toast(`Kept effort level as ${level}`)
        return 'close'
      }
      host.toast((await host.cli(`/effort ${level}`)).trim() || `Set effort level to ${level}`)
      return 'close'
    },
  }
}

// ---------------------------------------------------------------- /fast

async function fastScreen(host: CommandHost): Promise<MenuScreen> {
  const [now, init] = await Promise.all([
    current(host),
    control<{ fast_mode_state?: 'off' | 'cooldown' | 'on' }>(host.link, 'initializationResult').catch(() => undefined),
  ])
  const was = !!init?.fast_mode_state && init.fast_mode_state !== 'off'
  const state = { on: was }
  const word = (on: boolean) => (on ? 'ON' : 'OFF')
  const confirm = async (): Promise<MenuResult> => {
    if (state.on === was) host.toast(`Kept Fast mode ${word(was)}`)
    else host.toast((await host.cli(`/fast ${state.on ? 'on' : 'off'}`)).trim() || `Fast mode ${word(state.on)}`)
    return 'close'
  }
  const build = (): MenuScreen => ({
    title: 'Fast mode (research preview)',
    body: `<p>High-speed mode for ${esc(now.model?.displayName ?? now.id ?? 'this model')}. Draws from usage credits at a higher rate. Separate rate limits apply.</p>`
      + (init?.fast_mode_state === 'cooldown' ? '<p class="bad">Fast mode is cooling down after a rate limit.</p>' : ''),
    groups: [{
      rows: [
        { id: 'toggle', label: 'Fast mode', icon: state.on ? '●' : '○', tone: state.on ? 'ok' : 'muted', meta: word(state.on), on: state.on },
        { id: 'confirm', label: 'Confirm' },
      ],
    }],
    notes: ['space toggle · Enter confirm · Esc cancel', 'https://code.claude.com/docs/en/fast-mode'],
    reload: async () => build(),
    key(e) {
      if (e.key === ' ') return (state.on = !state.on), 'refresh'
      if (e.key === 'Enter' && !e.repeat) return confirm()
      return false
    },
    pick(row) {
      if (row.id === 'confirm') return confirm()
      state.on = !state.on
      return 'refresh'
    },
  })
  return build()
}

/** The menu focuses its first row; the CLI's pickers start on the current choice. Runs after the menu draws. */
function focusLater(test: string, id: string | undefined) {
  if (id) setTimeout(() => document.querySelector<HTMLElement>(`[data-test="${test}"] .mrow[data-id="${CSS.escape(id)}"]`)?.focus())
}
