import { control } from '../control'
import { openMenu, type MenuRow, type MenuScreen, type Tone } from '../menu'
import type { CommandHost } from './index'

// /skills, as the CLI 2.1.309 draws it (docs/research/cli-extensions.md §3): every skill with its visibility,
// Enter/Space cycles on → name-only → user-only → off, and closing saves the changes to `skillOverrides` in
// .claude/settings.local.json, then reloads the session's skills.

/** The SDK's SlashCommand (supportedCommands). */
type Command = { name: string; description: string; argumentHint?: string; builtin?: boolean }
type Visibility = 'on' | 'name-only' | 'user-invocable-only' | 'off'
type Overrides = Record<string, Visibility>
type SettingsFile = { source: 'user' | 'project' | 'local'; json: { skillOverrides?: Overrides } }

type Skill = { name: string; about: string; source: string; tokens: number; lock?: { value: Visibility; by: string } }

const CYCLE: Visibility[] = ['on', 'name-only', 'user-invocable-only', 'off']
const LOOK: Record<Visibility, { icon: string; tone: Tone; word?: string }> = {
  on: { icon: '✔', tone: 'ok' },
  'name-only': { icon: '✔', tone: 'ok', word: 'name-only' },
  'user-invocable-only': { icon: '✔', tone: 'ok', word: 'user-only' },
  off: { icon: '◯', tone: 'muted' },
}
const HINT = 'enter/space to cycle, / to search, t to sort, esc to close'
const CHARS_PER_TOKEN = 4

const isVisibility = (v: unknown): v is Visibility => CYCLE.includes(v as Visibility)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Where a skill comes from. The SDK's row has no source field; the CLI ends a custom command's description with
 * its source in parentheses ("… (user)", "… (plugin:name)"), and a plugin skill's name is `plugin:skill`.
 */
function skillOf(c: Command): Skill {
  const m = /\s*\(([^()]+)\)\s*$/.exec(c.description)
  const tag = m?.[1].trim().toLowerCase() ?? ''
  const plugin = tag.startsWith('plugin') || (c.name.includes(':') && tag !== 'mcp')
  const source = plugin ? 'plugin' : tag === 'mcp' ? 'mcp' : tag === 'bundled' || tag === 'built-in' ? 'built-in' : ['user', 'project', 'managed'].includes(tag) ? tag : ''
  const about = m && (plugin || source) ? c.description.slice(0, m.index) : c.description
  return {
    name: c.name,
    about,
    source,
    // The CLI's `~N tok`: the skill's one-line listing in the system prompt.
    tokens: Math.max(1, Math.ceil((c.name.length + about.length + 4) / CHARS_PER_TOKEN)),
    // A plugin's skills follow the plugin (the CLI locks them); the rest are the user's to cycle.
    lock: plugin ? { value: 'on', by: 'plugin' } : undefined,
  }
}

const overridesOf = (f: SettingsFile | undefined): Overrides => {
  const o = f?.json.skillOverrides
  return o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([, v]) => isVisibility(v))) : {}
}

export function skillsCommand(host: CommandHost) {
  let save: (() => Promise<void>) | undefined
  const menu = openMenu(host, 'skills', load(host).then((d) => {
    const p = panel(d, () => menu.el)
    save = () => p.save(host)
    return p.screen()
  }), 'Skills')
  // The CLI saves when the panel closes (Esc, the Close button, a click outside).
  void menu.closed.then(() => save?.())
}

async function load(host: CommandHost) {
  const [commands, files] = await Promise.all([
    control<Command[]>(host.link, 'supportedCommands'),
    control<SettingsFile[]>(host.link, 'settingsFiles'),
  ])
  const skills = commands.filter((c) => !c.builtin).map(skillOf)
  const by = (s: SettingsFile['source']) => overridesOf(files.find((f) => f.source === s))
  return { skills, local: by('local'), lower: { ...by('user'), ...by('project') } }
}

function panel(d: Awaited<ReturnType<typeof load>>, el: () => HTMLElement) {
  const { skills, local, lower } = d
  // Effective state: locked → local override → project/user override → on.
  const effective = (s: Skill): Visibility => s.lock?.value ?? local[s.name] ?? lower[s.name] ?? 'on'
  const start = new Map(skills.map((s) => [s.name, effective(s)]))
  const now = new Map(start)
  let byTokens = false

  const order = () =>
    [...skills].sort((a, b) =>
      byTokens ? b.tokens - a.tokens || a.name.localeCompare(b.name) : a.source.localeCompare(b.source) || a.name.localeCompare(b.name))

  const row = (s: Skill): MenuRow => {
    const v = now.get(s.name)!
    const look = LOOK[v]
    return {
      id: s.name,
      label: s.name,
      icon: look.icon,
      tone: look.tone,
      meta: [s.lock ? `locked by ${s.lock.by}` : '', look.word ?? '', s.source, `~${s.tokens} tok`].filter(Boolean).join(' · '),
      hint: s.about,
      disabled: !!s.lock,
    }
  }

  const cycle = (name: string) => {
    const s = skills.find((x) => x.name === name)
    if (!s || s.lock) return
    now.set(name, CYCLE[(CYCLE.indexOf(now.get(name)!) + 1) % CYCLE.length])
  }

  const screen = (): MenuScreen => ({
    title: 'Skills',
    subtitle: `${plural(skills.length, 'skill')}${byTokens ? ' · sorted by tokens' : ''}`,
    groups: [{ rows: order().map(row) }],
    search: true,
    empty: 'No skills found. Create skills in .claude/skills/ or ~/.claude/skills/',
    notes: [HINT, ...(skills.some((s) => s.lock?.by === 'plugin') ? ['Plugin skills are managed via /plugin'] : [])],
    pick: (r) => (cycle(r.id), 'refresh'),
    reload: async () => screen(),
    key(e, r) {
      if (document.activeElement instanceof HTMLInputElement || e.ctrlKey || e.altKey || e.metaKey) return false
      if (e.key === ' ' && r) return cycle(r.id), 'refresh'
      if (e.key === 't') return (byTokens = !byTokens), 'refresh'
      if (e.key === '/') {
        el().querySelector<HTMLInputElement>('[data-test="menu-search"]')?.focus()
        return true
      }
      return false
    },
  })

  return { screen, save: (host: CommandHost) => save(host, skills, now, start, local, lower) }
}

/** The CLI's save on close: only the local overrides that changed, then a skills reload. */
async function save(host: CommandHost, skills: Skill[], now: Map<string, Visibility>, start: Map<string, Visibility>, local: Overrides, lower: Overrides) {
  const edits: { op: 'set' | 'delete'; path: string[]; value?: Visibility }[] = []
  let changed = 0
  for (const s of skills) {
    if (s.lock) continue
    const v = now.get(s.name)!
    if (v !== start.get(s.name)) changed++
    // A local entry equal to the project/user value is dropped, as the CLI does.
    const want = v === (lower[s.name] ?? 'on') ? undefined : v
    if (want === local[s.name]) continue
    edits.push(want ? { op: 'set', path: ['skillOverrides', s.name], value: want } : { op: 'delete', path: ['skillOverrides', s.name] })
  }
  if (edits.length) {
    try {
      await control(host.link, 'editSettings', 'local', edits)
    } catch (e) {
      return host.toast(`Failed to save skill overrides: ${e instanceof Error ? e.message : String(e)}`)
    }
    await control(host.link, 'reloadSkills').catch(() => undefined)
  }
  host.toast(changed ? `Updated ${changed} skill ${changed === 1 ? 'override' : 'overrides'}` : 'No changes')
}
