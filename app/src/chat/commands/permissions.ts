import { esc } from '../../ui'
import { control } from '../control'
import { detailRows, openMenu, type MenuResult, type MenuRow, type MenuScreen } from '../menu'
import type { CommandHost } from './index'

// /permissions (alias /allowed-tools) and /add-dir, as the CLI 2.1.309 draws them (docs/research/cli-settings.md
// §7–8): the Permissions dialog's tabs, its rule lists with "Add a new rule…", the save-location choice, the delete
// confirmation, the Workspace directories, and /add-dir's three choices. The SDK has no permissions writer, so
// rules go straight into the settings files (`editSettings`); the session part of /add-dir is the CLI's own
// headless `/add-dir <path>`.

type Source = 'user' | 'project' | 'local'
type Behavior = 'allow' | 'ask' | 'deny'
type Tab = 'recent' | Behavior | 'workspace'
type SettingsFile = { source: Source; path: string; exists: boolean; json: Record<string, unknown>; error?: string }
type Rule = { behavior: Behavior; rule: string; source: Source }

const TABS: { id: Tab; title: string }[] = [
  { id: 'recent', title: 'Recently denied' },
  { id: 'allow', title: 'Allow' },
  { id: 'ask', title: 'Ask' },
  { id: 'deny', title: 'Deny' },
  { id: 'workspace', title: 'Workspace' },
]

/** The CLI's per-tab description and empty line. */
const TAB_TEXT: Record<Behavior | 'workspace', { about: string; empty: string }> = {
  allow: { about: "Claude Code won't ask before using allowed tools.", empty: 'No allow rules' },
  ask: { about: 'Claude Code will always ask for confirmation before using these tools.', empty: 'No ask rules' },
  deny: { about: 'Claude Code will always reject requests to use denied tools.', empty: 'No deny rules' },
  workspace: { about: 'Claude Code can read files in the workspace, and make edits when auto-accept edits is on.', empty: 'No additional working directories' },
}

/** The save-location options in the CLI's order and words, and its "From …" source names. */
const SOURCES: { id: Source; label: string; hint: string; from: string }[] = [
  { id: 'local', label: 'Project settings (local)', hint: 'Saved in .claude/settings.local.json', from: 'project local settings' },
  { id: 'project', label: 'Project settings', hint: 'Checked in at .claude/settings.json', from: 'project settings' },
  { id: 'user', label: 'User settings', hint: 'Saved in at ~/.claude/settings.json', from: 'user settings' },
]
const sourceOf = (s: Source) => SOURCES.find((x) => x.id === s)!
/** The CLI's oa(): "Delete allowed tool?". */
const BEHAVIOR_WORD: Record<Behavior, string> = { allow: 'allowed', ask: 'ask', deny: 'denied' }

const RECENT_EMPTY = 'No recent denials to show. The auto mode classifier\'s denials only reach the terminal: run claude and open /permissions there to review them.'
const ADD_DIR_ABOUT = 'Claude Code will be able to read files in this directory and make edits when auto-accept edits is on.'
const KEYS_TABS = '←/→ to switch tabs'

/** Directories added for this session only (headless `/add-dir`), per link: no control reads them back. */
const sessionDirs = new WeakMap<object, Set<string>>()
const sessionSet = (host: CommandHost) => {
  let s = sessionDirs.get(host.link)
  if (!s) sessionDirs.set(host.link, (s = new Set()))
  return s
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const perms = (f: SettingsFile) => (f.json.permissions && typeof f.json.permissions === 'object' ? (f.json.permissions as Record<string, unknown>) : {})
const files = (host: CommandHost) => control<SettingsFile[]>(host.link, 'settingsFiles')
const edit = (host: CommandHost, source: Source, op: 'append' | 'remove', key: string, value: string) =>
  control(host.link, 'editSettings', source, [{ op, path: ['permissions', key], value }])

function rulesOf(all: SettingsFile[], b: Behavior): Rule[] {
  return SOURCES.flatMap((s) => all.filter((f) => f.source === s.id).flatMap((f) => strings(perms(f)[b]).map((rule) => ({ behavior: b, rule, source: s.id }))))
}

/** "Bash(ls *)" → { tool: "Bash", content: "ls *" }. */
function parseRule(rule: string) {
  const m = /^([^(]+?)\s*(?:\((.*)\))?$/.exec(rule.trim())
  return { tool: m?.[1] ?? rule, content: m?.[2] }
}

/** The CLI's shadow warning: a specific allow/ask rule that a bare deny (or, for allow, ask) rule overrides. */
function shadow(r: Rule, all: SettingsFile[]) {
  const { tool, content } = parseRule(r.rule)
  if (content === undefined || r.behavior === 'deny') return undefined
  const bare = (b: Behavior) => rulesOf(all, b).find((x) => parseRule(x.rule).tool === tool && parseRule(x.rule).content === undefined)
  const deny = bare('deny')
  if (deny) return `Blocked by "${deny.rule}" deny rule (from ${sourceOf(deny.source).from})`
  const ask = r.behavior === 'allow' ? bare('ask') : undefined
  if (ask) return `Shadowed by "${ask.rule}" ask rule (from ${sourceOf(ask.source).from})`
  return undefined
}

/** An absolute path for the settings file: the CLI resolves a relative one against the session folder. */
function absolute(path: string, cwd: string) {
  const p = path.trim().replace(/^"(.*)"$/, '$1')
  if (/^([a-zA-Z]:[\\/]|[\\/]|~)/.test(p)) return p
  return `${cwd.replace(/[\\/]+$/, '')}\\${p.replace(/^\.[\\/]/, '')}`
}

/** Opens /permissions (or /allowed-tools), or runs /add-dir: with a path its confirm, without one the Workspace tab. */
export function permissionsCommand(host: CommandHost, args: string, typed: string) {
  const path = args.trim()
  if (typed === 'add-dir') return path ? void openMenu(host, 'permissions', addDirScreen(host, path, () => 'close')) : open(host, 'workspace')
  open(host, 'allow')
}

/** The Permissions dialog on `tab`. ←/→ (or a click on the tab strip) switches tabs, as the CLI's Tabs context does. */
function open(host: CommandHost, tab: Tab) {
  const state = { tab, jump: undefined as Tab | undefined }
  const build = async () => tabScreen(host, state, await files(host))
  const menu = openMenu(host, 'permissions', build(), 'Permissions')
  // A tab click sets the target and replays it as the screen's own ← key, so it goes through the menu's redraw.
  menu.el.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]')
    if (!t) return
    state.jump = t.dataset.tab as Tab
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
  })
}

function tabStrip(active: Tab) {
  return `<nav class="ptabs" data-test="perm-tabs">${TABS.map((t) =>
    `<button type="button" class="ptab${t.id === active ? ' on' : ''}" data-tab="${t.id}" data-test="perm-tab" data-id="${t.id}"${t.id === active ? ' aria-current="true"' : ''}>${esc(t.title)}</button>`).join('')}</nav>`
}

function tabScreen(host: CommandHost, state: { tab: Tab; jump?: Tab }, all: SettingsFile[]): MenuScreen {
  const tab = state.tab
  const broken = all.filter((f) => f.error).map((f) => `<p class="bad">${esc(`${f.path}: ${f.error}`)}</p>`).join('')
  const base = {
    title: 'Permissions',
    reload: async () => tabScreen(host, state, await files(host)),
    key(e: KeyboardEvent): MenuResult | boolean {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return false
      const i = TABS.findIndex((t) => t.id === tab)
      state.tab = state.jump ?? TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length].id
      state.jump = undefined
      return 'refresh'
    },
  }
  /** A finished add or delete reopens the dialog on this tab, read fresh: the menu has no "back two screens". */
  const reopen = (): MenuResult => {
    const tabNow = state.tab
    setTimeout(() => open(host, tabNow))
    return 'close'
  }

  if (tab === 'recent') {
    return { ...base, body: tabStrip(tab) + broken, groups: [], empty: RECENT_EMPTY, notes: [KEYS_TABS] }
  }

  if (tab === 'workspace') {
    const cwd = host.cwd()
    const saved = SOURCES.flatMap((s) => all.filter((f) => f.source === s.id).flatMap((f) => strings(perms(f).additionalDirectories).map((path) => ({ path, source: s.id }))))
    const session = [...sessionSet(host)].filter((p) => !saved.some((d) => d.path === p))
    const rows: MenuRow[] = [
      { id: 'original', label: cwd, meta: '(Original working directory)', disabled: true },
      ...saved.map((d, i): MenuRow => ({ id: `dir:${i}`, label: d.path, meta: `From ${sourceOf(d.source).from}` })),
      ...session.map((p, i): MenuRow => ({ id: `session:${i}`, label: p, meta: 'This session', hint: 'Added for this session only: it goes when the session ends', disabled: true })),
      { id: 'add', label: 'Add directory…' },
    ]
    return {
      ...base,
      subtitle: TAB_TEXT.workspace.about,
      body: tabStrip(tab) + broken,
      groups: [{ rows }],
      notes: [...(saved.length || session.length ? [] : [TAB_TEXT.workspace.empty]), KEYS_TABS],
      pick(row): MenuResult {
        if (row.id === 'add') return pathScreen(host, reopen)
        const d = saved[Number(row.id.slice(4))]
        if (!d) return
        return {
          title: 'Remove directory from workspace?',
          body: detailRows([['Directory:', d.path], ['From:', sourceOf(d.source).label]]) + '<p>Claude Code will no longer have access to files in this directory.</p>',
          groups: [{ rows: [{ id: 'yes', label: 'Yes', danger: true }, { id: 'no', label: 'No' }] }],
          notes: ['Enter to confirm · Esc to cancel'],
          async pick(r): Promise<MenuResult> {
            if (r.id !== 'yes') return 'close'
            await edit(host, d.source, 'remove', 'additionalDirectories', d.path)
            host.toast(`Removed directory ${d.path} from workspace`)
            return reopen()
          },
        }
      },
    }
  }

  const b = tab
  const rules = rulesOf(all, b)
  const rows: MenuRow[] = [
    { id: 'add', label: 'Add a new rule…' },
    ...rules.map((r, i): MenuRow => {
      const warn = shadow(r, all)
      return { id: `rule:${i}`, label: r.rule, meta: sourceOf(r.source).label, hint: warn, icon: warn ? '⚠' : undefined, tone: warn ? 'warn' : undefined }
    }),
  ]
  return {
    ...base,
    subtitle: TAB_TEXT[b].about,
    body: tabStrip(tab) + broken,
    groups: [{ rows }],
    search: rules.length > 8,
    notes: [...(rules.length ? [] : [TAB_TEXT[b].empty]), KEYS_TABS],
    pick(row): MenuResult {
      if (row.id === 'add') return ruleInputScreen(host, b, reopen)
      const r = rules[Number(row.id.slice(5))]
      return r && ruleDetailScreen(host, r, all, reopen)
    },
  }
}

/** "Add allow permission rule": a text field, Enter goes on to the save location. */
function ruleInputScreen(host: CommandHost, b: Behavior, done: () => MenuResult): MenuScreen {
  let draft = ''
  const focus = () => setTimeout(() => document.querySelector<HTMLInputElement>('[data-test="perm-input"]')?.focus())
  focus()
  return {
    title: `Add ${b} permission rule`,
    get body() {
      return '<p>Permission rules are a tool name, optionally followed by a specifier in parentheses.<br>e.g., <b>WebFetch</b> or <b>Bash(ls *)</b></p>'
        + `<input class="field pinput" data-test="perm-input" spellcheck="false" placeholder="Enter permission rule…" value="${esc(draft)}">`
    },
    groups: [],
    empty: ' ',
    notes: ['Enter to submit · Esc to cancel'],
    key(e): MenuResult | boolean {
      const input = e.target as HTMLInputElement
      if (input?.dataset?.test !== 'perm-input') return false
      if (e.key !== 'Enter') return e.key === 'ArrowUp' || e.key === 'ArrowDown' ? true : false
      draft = input.value
      const rule = draft.trim()
      if (!rule) return true
      return whereScreen(host, b, rule, done)
    },
  }
}

/** "Where should this rule be saved?" with the CLI's three locations; picking one writes the rule there. */
function whereScreen(host: CommandHost, b: Behavior, rule: string, done: () => MenuResult): MenuScreen {
  return {
    title: `Add ${b} permission rule`,
    body: detailRows([['Rule:', rule]]),
    groups: [{ title: 'Where should this rule be saved?', rows: SOURCES.map((s) => ({ id: s.id, label: s.label, hint: s.hint })) }],
    async pick(row): Promise<MenuResult> {
      const s = sourceOf(row.id as Source)
      await edit(host, s.id, 'append', b, rule)
      host.toast(`Added ${b} rule ${rule}`)
      return done()
    },
  }
}

/** "Rule details" with its source, then the CLI's "Delete allowed tool?" confirmation. */
function ruleDetailScreen(host: CommandHost, r: Rule, all: SettingsFile[], done: () => MenuResult): MenuScreen {
  const warn = shadow(r, all)
  const info = detailRows([['Rule:', r.rule], ['Behavior:', r.behavior], ['From:', sourceOf(r.source).from], ['Warning:', warn]])
  return {
    title: 'Rule details',
    body: info,
    groups: [{ rows: [{ id: 'delete', label: 'Delete rule', danger: true }, { id: 'back', label: 'Back' }] }],
    pick(row): MenuResult {
      if (row.id === 'back') return 'close'
      return {
        title: `Delete ${BEHAVIOR_WORD[r.behavior]} tool?`,
        body: info + '<p>Are you sure you want to delete this permission rule?</p>',
        groups: [{ rows: [{ id: 'yes', label: 'Yes', danger: true }, { id: 'no', label: 'No' }] }],
        notes: ['Enter to confirm · Esc to cancel'],
        async pick(c): Promise<MenuResult> {
          if (c.id !== 'yes') return 'close'
          try {
            await edit(host, r.source, 'remove', r.behavior, r.rule)
          } catch {
            host.toast(`Could not delete ${r.rule} — the rule is unchanged`)
            return 'close'
          }
          host.toast(`Deleted ${r.behavior} rule ${r.rule}`)
          return done()
        },
      }
    },
  }
}

/** Workspace → "Add directory…": the CLI's path field, then /add-dir's confirm. */
function pathScreen(host: CommandHost, done: () => MenuResult): MenuScreen {
  let draft = ''
  setTimeout(() => document.querySelector<HTMLInputElement>('[data-test="perm-input"]')?.focus())
  return {
    title: 'Add directory to workspace',
    get body() {
      return '<p>Enter the path to the directory:</p>'
        + `<input class="field pinput" data-test="perm-input" spellcheck="false" placeholder="Directory path…" value="${esc(draft)}">`
    },
    groups: [],
    empty: ' ',
    notes: ['Enter to submit · Esc to cancel'],
    key(e): MenuResult | boolean {
      const input = e.target as HTMLInputElement
      if (input?.dataset?.test !== 'perm-input') return false
      if (e.key !== 'Enter') return e.key === 'ArrowUp' || e.key === 'ArrowDown'
      draft = input.value
      return draft.trim() ? addDirScreen(host, draft.trim(), done) : true
    },
  }
}

/** Strips ANSI styling from the CLI's text answer ("Added **X** as a working directory…"). */
const plain = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, '').trim()

/** /add-dir's confirm: "Yes, for this session" / "Yes, and remember this directory" / "No". */
function addDirScreen(host: CommandHost, path: string, done: () => MenuResult): MenuScreen {
  return {
    title: 'Add directory to workspace',
    body: detailRows([['Directory:', path]]) + `<p>${esc(ADD_DIR_ABOUT)}</p>`,
    groups: [{ rows: [{ id: 'session', label: 'Yes, for this session' }, { id: 'remember', label: 'Yes, and remember this directory' }, { id: 'no', label: 'No' }] }],
    async pick(row): Promise<MenuResult> {
      if (row.id === 'no') {
        host.toast('Did not add a working directory.')
        return 'close'
      }
      // The CLI's own headless /add-dir validates the path and adds it to the running session.
      const said = plain(await host.cli(`/add-dir ${path}`))
      const added = /^Added (.+) as a working directory/.exec(said)
      if (!added) {
        host.toast(said || 'Did not add a working directory.')
        return 'close'
      }
      const dir = added[1].trim() || absolute(path, host.cwd())
      sessionSet(host).add(dir)
      if (row.id === 'remember') {
        try {
          await edit(host, 'local', 'append', 'additionalDirectories', dir)
          host.toast(`Added ${dir} as a working directory and saved to local settings · /permissions to manage`)
        } catch (e) {
          host.toast(`Added ${dir} as a working directory. Failed to save to local settings: ${e instanceof Error ? e.message : String(e)}`)
        }
      } else host.toast(`${said} · /permissions to manage`)
      return done()
    },
  }
}
