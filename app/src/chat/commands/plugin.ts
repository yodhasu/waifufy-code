import { esc } from '../../ui'
import { control } from '../control'
import { detailRows, openMenu, type MenuResult, type MenuRow, type MenuScreen } from '../menu'
import type { CommandHost } from './index'

// /plugin (/plugins, /marketplace), the CLI 2.1.309's tabbed "Plugins" panel (docs/research/cli-extensions.md §2):
// Discover, Installed, Marketplaces and Errors. The SDK has no plugin controls, so every read and change runs
// `claude plugin … --json` hidden in the session folder (cliExec), then reloadPlugins so the session picks it up.

/** `claude plugin list --json --available`: one row per installed plugin and scope… */
type Installed = { id: string; version?: string; scope?: string; enabled?: boolean; installPath?: string; installedAt?: string; errors?: unknown[] }
/** …and the marketplaces' plugins that aren't installed. */
type Available = { pluginId: string; name: string; description?: string; marketplaceName: string; version?: string; installCount?: number }
/** `claude plugin marketplace list --json`. */
type Marketplace = { name: string; source?: string; repo?: string; url?: string; path?: string; installLocation?: string }
/** The one result line an install, enable, marketplace add… prints with `--json`. */
type Outcome = { outcome?: 'ok' | 'failed'; message?: string; pluginId?: string }
type Exec = { code: number; stdout: string; stderr: string }

type State = { installed: Installed[]; available: Available[]; marketplaces: Marketplace[] }

const TABS = ['discover', 'installed', 'marketplaces', 'errors'] as const
type Tab = (typeof TABS)[number]

const OFFICIAL = 'claude-plugins-official'
const SCOPES = ['project', 'local', 'user', 'enterprise', 'managed', 'builtin', 'session']
const TRUST = 'Make sure you trust a plugin before installing, updating, or using it. Anthropic does not control what MCP servers, '
  + 'files, or other software are included in plugins and cannot verify that they will work as intended or that they won\'t '
  + 'change. See each plugin\'s homepage for more information.'
const USAGE = 'Usage: /plugin [install [<plugin>]|manage|marketplace [add <source>|remove <name>|update <name>]|enable|disable|uninstall|update <plugin>]'
/** A made-up key the tab bar's clicks send through the menu, so a click switches tabs like Tab does. */
const TAB_KEY = 'wc-plugin-tab'

const nameOf = (id: string) => id.split('@')[0]
const mktOf = (id: string) => id.split('@')[1] ?? ''
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const count = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K` : String(n))
const errorsOf = (p: Installed) => (p.errors ?? []).map((e) => (typeof e === 'string' ? e : ((e as { message?: string })?.message ?? JSON.stringify(e))))
const inField = () => document.activeElement instanceof HTMLInputElement
/** Esc, `n` times: back out of the screens an action came from (the menu has no "pop" result). */
const goBack = (n = 1) => setTimeout(() => {
  for (let i = 0; i < n; i++) dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
}, 0)

/** Runs `claude plugin <args>` and parses its JSON: the whole output, or its last line (the `--json` result line). */
async function cli<T>(host: CommandHost, args: string[]): Promise<T> {
  const r = await control<Exec>(host.link, 'cliExec', ['plugin', ...args])
  const out = r.stdout.trim()
  for (const text of [out, out.split('\n').at(-1) ?? '']) {
    try {
      return JSON.parse(text) as T
    } catch {
      /* not JSON: try the last line, then fail below */
    }
  }
  throw new Error(r.stderr.trim() || out || `claude plugin ${args[0]} exited with code ${r.code}`)
}

async function load(host: CommandHost): Promise<State> {
  const [list, marketplaces] = await Promise.all([
    cli<{ installed: Installed[]; available: Available[] }>(host, ['list', '--json', '--available']),
    cli<Marketplace[]>(host, ['marketplace', 'list', '--json']),
  ])
  return { installed: list.installed ?? [], available: list.available ?? [], marketplaces: Array.isArray(marketplaces) ? marketplaces : [] }
}

/** One change through the CLI, then a plugin reload. Resolves with the CLI's own line; rejects "Failed to <verb>: …". */
async function change(host: CommandHost, verb: string, args: string[]) {
  const r = await cli<Outcome>(host, [...args, '--json']).catch((e: Error) => ({ outcome: 'failed' as const, message: e.message }))
  if (r.outcome !== 'ok') throw new Error(`Failed to ${verb}: ${r.message ?? 'unknown error'}`)
  const applied = await control(host.link, 'reloadPlugins').then(() => true, () => false)
  return { ...r, applied }
}

/** Opens /plugin on a tab, or runs its headless forms (`/plugin enable x`, `/marketplace add owner/repo`). */
export function pluginCommand(host: CommandHost, args: string, typed: string) {
  let words = args.trim().split(/\s+/).filter(Boolean)
  if (typed === 'marketplace' && words.length) words = ['marketplace', ...words]
  const [verb, ...rest] = words
  let tab: Tab = typed === 'marketplace' ? 'marketplaces' : 'discover'
  let target: string | undefined
  switch (verb) {
    case undefined:
      break
    case 'install':
      target = rest[0]
      break
    case 'manage':
    case 'list':
      tab = 'installed'
      break
    case 'marketplace':
      tab = 'marketplaces'
      if (['add', 'remove', 'rm', 'update'].includes(rest[0]) && rest[1]) {
        const sub = rest[0] === 'rm' ? 'remove' : rest[0]
        return void change(host, `${sub} marketplace`, ['marketplace', sub, rest[1]])
          .then((r) => host.toast(`✓ ${r.message ?? `Marketplace ${rest[1]} ${sub}d`}`), (e: Error) => host.toast(e.message))
      }
      break
    case 'enable':
    case 'disable':
    case 'uninstall':
    case 'update':
      if (!rest[0]) return host.toast(USAGE)
      return void change(host, verb, [verb, rest[0]])
        .then((r) => host.toast(done(verb, nameOf(r.pluginId ?? rest[0]), r.applied)), (e: Error) => host.toast(e.message))
    default:
      return host.toast(USAGE)
  }
  new Panel(host, tab, target).open()
}

/** The CLI's result line for an installed-plugin action. */
function done(verb: string, name: string, applied: boolean) {
  const past = { enable: 'Enabled', disable: 'Disabled', uninstall: 'Uninstalled', update: 'Updated' }[verb] ?? verb
  return `✓ ${past} ${name}.${applied ? '' : ' Run /reload-plugins to apply.'}`
}

class Panel {
  private s: State = { installed: [], available: [], marketplaces: [] }
  /** Discover rows marked with Space, for `i`. */
  private picked = new Set<string>()
  /** The tab screen. It is one object for the panel's life, rebuilt in place, so Esc from a sub-screen shows it fresh. */
  private root: MenuScreen = { title: 'Plugins', groups: [] }

  constructor(
    private host: CommandHost,
    private tab: Tab,
    private target?: string,
  ) {}

  open() {
    const first = this.fetch().then(() => {
      // `/plugin install <name>` opens that plugin's details over Discover.
      const t = this.target
      if (t) {
        const p = this.s.available.find((a) => a.pluginId === t || a.name === t)
        if (p) {
          this.pending = this.details(p)
          setTimeout(() => dispatchEvent(new KeyboardEvent('keydown', { key: TAB_KEY })), 0)
        } else this.host.toast(`Plugin "${t}" is not in any marketplace, or is already installed`)
      }
      return this.root
    })
    const menu = openMenu(this.host, 'plugin', first, 'Plugins')
    menu.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-test="plugin-tab"]')
      if (!b || b.dataset.id === this.tab) return
      this.tab = b.dataset.id as Tab
      dispatchEvent(new KeyboardEvent('keydown', { key: TAB_KEY }))
    })
  }

  /** A screen to open on top at the next TAB_KEY (the `/plugin install <name>` target). */
  private pending: MenuScreen | undefined

  /** Re-reads everything from the CLI and rebuilds the tab screen. */
  private async fetch() {
    this.s = await load(this.host)
    for (const id of this.picked) if (!this.s.available.some((a) => a.pluginId === id)) this.picked.delete(id)
    this.build()
  }

  private build() {
    const screens: Record<Tab, () => Partial<MenuScreen>> = {
      discover: () => this.discover(),
      installed: () => this.installedTab(),
      marketplaces: () => this.marketplacesTab(),
      errors: () => this.errorsTab(),
    }
    const part = screens[this.tab]()
    // Every key is set, so nothing from the last tab is left over.
    Object.assign(this.root, {
      title: 'Plugins',
      subtitle: undefined,
      empty: undefined,
      notes: undefined,
      search: false,
      pick: undefined,
      ...part,
      body: this.tabBar() + (part.body ?? ''),
      reload: async () => (this.build(), this.root),
      key: (e: KeyboardEvent, row: MenuRow | undefined) => this.key(e, row, part.key),
    })
    return this.root
  }

  private errorCount() {
    return this.s.installed.reduce((n, p) => n + errorsOf(p).length, 0)
  }

  private tabBar() {
    const label: Record<Tab, string> = { discover: 'Discover', installed: 'Installed', marketplaces: 'Marketplaces', errors: `Errors (${this.errorCount()})` }
    return `<nav class="ptabs" role="tablist">${TABS.map((t) =>
      `<button type="button" class="ptab${t === this.tab ? ' on' : ''}" role="tab" aria-selected="${t === this.tab}" data-test="plugin-tab" data-id="${t}">${esc(label[t])}</button>`).join('')}</nav>`
  }

  /** Tab, Shift+Tab and ←/→ switch tabs (the CLI's Tabs keys); then the tab's own keys. */
  private key(e: KeyboardEvent, row: MenuRow | undefined, own: MenuScreen['key']): ReturnType<NonNullable<MenuScreen['key']>> {
    if (e.key === TAB_KEY) {
      const p = this.pending
      this.pending = undefined
      return p ?? (this.build(), 'refresh')
    }
    const step = e.key === 'Tab' ? (e.shiftKey ? -1 : 1) : inField() ? 0 : e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (step && !e.ctrlKey && !e.altKey) {
      this.tab = TABS[(TABS.indexOf(this.tab) + step + TABS.length) % TABS.length]
      this.build()
      return 'refresh'
    }
    if (inField() || e.ctrlKey || e.altKey || e.metaKey) return false
    return own?.(e, row) ?? false
  }

  /** Runs a change, re-reads the lists and toasts the result line. */
  private async apply(verb: string, args: string[], line: (r: Outcome & { applied: boolean }) => string) {
    const r = await change(this.host, verb, args)
    await this.fetch()
    this.host.toast(line(r))
    return r
  }

  // ---------------------------------------------------------------- Discover

  private discover(): Partial<MenuScreen> {
    const list = [...this.s.available].sort((a, b) => (b.installCount ?? 0) - (a.installCount ?? 0) || a.name.localeCompare(b.name))
    const n = this.picked.size
    return {
      subtitle: `Discover plugins · ${plural(list.length, 'plugin')} available${n ? ` · ${n} selected` : ''}`,
      groups: [{ rows: list.map((p) => this.availableRow(p)) }],
      search: true,
      empty: this.s.marketplaces.length ? 'All available plugins are already installed.' : 'Add a marketplace first using the Marketplaces tab. No plugins available.',
      notes: ['Space toggle · i install · Enter select/details · Esc go back'],
      pick: (row) => {
        const p = this.s.available.find((a) => a.pluginId === row.id)
        return p && this.details(p)
      },
      // Keys answer synchronously when they aren't this tab's: a promise would count as handled.
      key: (e, row) => {
        if (e.key === ' ' && row) {
          if (!this.picked.delete(row.id)) this.picked.add(row.id)
          this.build()
          return 'refresh'
        }
        const ids = this.picked.size ? [...this.picked] : row ? [row.id] : []
        if (e.key === 'i' && ids.length) return this.install(ids, 'user').then(() => 'refresh' as const)
        return false
      },
    }
  }

  private availableRow(p: Available, picked = this.picked.has(p.pluginId)): MenuRow {
    return {
      id: p.pluginId,
      label: p.name,
      icon: picked ? '◉' : '◯',
      tone: picked ? 'accent' : 'muted',
      meta: [p.marketplaceName, p.installCount !== undefined ? `${count(p.installCount)} installs` : ''].filter(Boolean).join(' · '),
      hint: p.description,
      on: picked,
    }
  }

  private async install(ids: string[], scope: string) {
    this.host.toast(ids.length === 1 ? `Installing ${nameOf(ids[0])}…` : `Installing ${plural(ids.length, 'plugin')}…`)
    let applied = true
    for (const id of ids) {
      const r = await change(this.host, 'install', ['install', id, '--scope', scope])
      applied &&= r.applied
    }
    ids.forEach((id) => this.picked.delete(id))
    await this.fetch()
    const what = ids.length === 1 ? nameOf(ids[0]) : plural(ids.length, 'plugin')
    this.host.toast(`✓ Installed ${what}. ${applied ? (ids.length === 1 ? 'Plugin is now active.' : 'Plugins are now active.') : 'Run /reload-plugins to apply.'}`)
  }

  /** The CLI's "Plugin details" screen, with its three install scopes. */
  private details(p: Available): MenuScreen {
    return {
      title: p.name,
      subtitle: `from ${p.marketplaceName}`,
      body: `<p class="mwarn">⚠ ${esc(TRUST)}</p>${p.description ? `<p>${esc(p.description)}</p>` : ''}`
        + detailRows([['Version:', p.version], ['Installs:', p.installCount !== undefined ? count(p.installCount) : undefined]]),
      groups: [{
        rows: [
          { id: 'user', label: 'Install for you (user scope)' },
          { id: 'project', label: 'Install for all collaborators on this repository (project scope)' },
          { id: 'local', label: 'Install for you, in this repo only (local scope)' },
          { id: 'back', label: 'Back to plugin list' },
        ],
      }],
      pick: async (row) => {
        if (row.id !== 'back') await this.install([p.pluginId], row.id)
        goBack()
      },
    }
  }

  // ---------------------------------------------------------------- Installed

  private installedTab(): Partial<MenuScreen> {
    const all = [...this.s.installed].sort((a, b) => nameOf(a.id).localeCompare(nameOf(b.id)))
    const broken = all.filter((p) => errorsOf(p).length)
    const rest = all.filter((p) => !errorsOf(p).length)
    const scopes = [...SCOPES, ...new Set(rest.map((p) => p.scope ?? 'user').filter((s) => !SCOPES.includes(s)))]
    const scopeTitle = (s: string) => (s === 'builtin' ? 'Built-in' : title(s))
    return {
      subtitle: `Manage plugins · ${plural(all.length, 'plugin')}`,
      groups: [
        { title: 'Needs attention', rows: broken.map((p) => this.installedRow(p)) },
        ...scopes.map((s) => ({ title: scopeTitle(s), rows: rest.filter((p) => (p.scope ?? 'user') === s).map((p) => this.installedRow(p)) })),
      ].filter((g) => g.rows.length),
      search: all.length > 8,
      empty: 'No plugins installed.',
      notes: ['Space toggle · Enter view · Esc go back'],
      pick: (row) => this.pluginDetail(row.id),
      key: (e, row) => (e.key === ' ' && row ? this.toggle(row.id).then(() => 'refresh' as const) : false),
    }
  }

  private installedRow(p: Installed): MenuRow {
    const errs = errorsOf(p).length
    const off = p.enabled === false
    return {
      id: p.id,
      label: nameOf(p.id),
      icon: errs ? '✘' : off ? '◯' : '✔',
      tone: errs ? 'bad' : off ? 'muted' : 'ok',
      meta: ['plugin', errs ? plural(errs, 'error') : off ? 'disabled' : '', mktOf(p.id)].filter(Boolean).join(' · '),
    }
  }

  private find(id: string) {
    return this.s.installed.find((p) => p.id === id)
  }

  private async toggle(id: string) {
    const p = this.find(id)
    if (!p) return
    const verb = p.enabled === false ? 'enable' : 'disable'
    await this.apply(verb, [verb, p.id, ...(p.scope && SCOPES.slice(0, 3).includes(p.scope) ? ['--scope', p.scope] : [])], (r) => done(verb, nameOf(p.id), r.applied))
  }

  private pluginDetail(id: string): MenuScreen | undefined {
    const p = this.find(id)
    if (!p) return
    const errs = errorsOf(p)
    const scoped = p.scope && SCOPES.slice(0, 3).includes(p.scope) ? ['--scope', p.scope] : []
    return {
      title: nameOf(p.id),
      subtitle: mktOf(p.id) ? `from ${mktOf(p.id)}` : undefined,
      body: detailRows([
        ['Scope:', p.scope],
        ['Version:', p.version],
        ['Status:', p.enabled === false ? 'Disabled' : 'Enabled'],
        ['Installed:', p.installedAt?.slice(0, 10)],
        ['Path:', p.installPath],
        ['Errors:', errs.join('\n') || undefined],
      ]),
      groups: [{
        rows: [
          { id: 'toggle', label: p.enabled === false ? 'Enable plugin' : 'Disable plugin' },
          ...(p.scope === 'builtin' ? [] : [{ id: 'update', label: 'Update now' }, { id: 'uninstall', label: 'Uninstall', danger: true }]),
          { id: 'back', label: 'Back to plugin list' },
        ],
      }],
      notes: p.scope === 'builtin' ? ['Built-in plugins cannot be updated or uninstalled.'] : undefined,
      reload: async () => this.pluginDetail(id) ?? this.root,
      pick: async (row): Promise<MenuResult> => {
        switch (row.id) {
          case 'toggle':
            await this.toggle(p.id)
            return 'refresh'
          case 'update':
            await this.apply('update', ['update', p.id, ...scoped], (r) => done('update', nameOf(p.id), r.applied))
            return 'refresh'
          case 'uninstall':
            await this.apply('uninstall', ['uninstall', p.id, ...scoped], (r) => done('uninstall', nameOf(p.id), r.applied))
            return void goBack()
          case 'back':
            return void goBack()
        }
      },
    }
  }

  // ---------------------------------------------------------------- Marketplaces

  private marketplacesTab(): Partial<MenuScreen> {
    const list = [...this.s.marketplaces].sort((a, b) => Number(b.name === OFFICIAL) - Number(a.name === OFFICIAL) || a.name.localeCompare(b.name))
    return {
      subtitle: `Manage marketplaces · ${plural(list.length, 'marketplace')}`,
      groups: [{
        rows: [
          { id: '+add', label: '+ Add Marketplace', tone: 'accent' },
          ...list.map((m): MenuRow => ({
            id: m.name,
            label: m.name,
            icon: m.name === OFFICIAL ? '✻' : undefined,
            tone: 'accent',
            meta: `${this.availableIn(m.name).length} available · ${this.installedFrom(m.name).length} installed`,
            hint: m.repo ?? m.url ?? m.path,
          })),
        ],
      }],
      notes: ['u update · d remove · Enter select · Esc go back'],
      pick: (row) => (row.id === '+add' ? this.addScreen() : this.marketplaceDetail(row.id)),
      key: (e, row) => {
        if (!row || row.id === '+add') return false
        if (e.key === 'u') return this.updateMarketplace(row.id).then(() => 'refresh' as const)
        if (e.key === 'd') return this.removeScreen(row.id, 1)
        return false
      },
    }
  }

  private availableIn(name: string) {
    return this.s.available.filter((a) => a.marketplaceName === name)
  }

  private installedFrom(name: string) {
    return this.s.installed.filter((p) => mktOf(p.id) === name)
  }

  private async updateMarketplace(name: string) {
    this.host.toast(`Updating ${name}…`)
    await this.apply('update marketplace', ['marketplace', 'update', name], (r) => `✓ ${r.message ?? `Updated ${name}`}`)
  }

  private marketplaceDetail(name: string): MenuScreen | undefined {
    const m = this.s.marketplaces.find((x) => x.name === name)
    if (!m) return
    const avail = this.availableIn(name)
    return {
      title: name,
      body: detailRows([['Source:', [m.source, m.repo ?? m.url ?? m.path].filter(Boolean).join(': ')], ['Location:', m.installLocation]]),
      groups: [{
        rows: [
          { id: 'browse', label: `Browse plugins (${avail.length})`, disabled: !avail.length },
          { id: 'update', label: 'Update marketplace' },
          { id: 'remove', label: 'Remove marketplace', danger: true },
        ],
      }],
      reload: async () => this.marketplaceDetail(name) ?? this.root,
      pick: async (row): Promise<MenuResult> => {
        if (row.id === 'browse') return this.browse(name)
        if (row.id === 'update') return void (await this.updateMarketplace(name))
        if (row.id === 'remove') return this.removeScreen(name, 2)
      },
    }
  }

  /** "Install Plugins" from one marketplace. */
  private browse(name: string): MenuScreen {
    const list = this.availableIn(name)
    return {
      title: 'Install Plugins',
      subtitle: name,
      groups: [{ rows: list.map((p) => this.availableRow(p, false)) }],
      empty: 'All plugins from this marketplace are already installed.',
      pick: (row) => {
        const p = list.find((a) => a.pluginId === row.id)
        return p && this.details(p)
      },
    }
  }

  /** The removal confirm; `depth` is how many screens to back out of after (1 from the tab, 2 from the detail). */
  private removeScreen(name: string, depth: number): MenuScreen {
    const n = this.installedFrom(name).length
    return {
      title: `Remove marketplace ${name}?`,
      body: n ? `<p>This will also uninstall ${esc(plural(n, 'plugin'))} from this marketplace.</p>` : undefined,
      groups: [{ rows: [{ id: 'remove', label: 'Remove marketplace', danger: true }, { id: 'cancel', label: 'Cancel' }] }],
      pick: async (row) => {
        if (row.id === 'cancel') return void goBack()
        await this.apply('remove marketplace', ['marketplace', 'remove', name], (r) => `✓ ${r.message ?? `Removed ${name}`}`)
        goBack(depth)
      },
    }
  }

  private addScreen(): MenuScreen {
    setTimeout(() => document.querySelector<HTMLInputElement>('[data-test="plugin-mkt-source"]')?.focus(), 0)
    return {
      title: 'Add Marketplace',
      body: '<p>Enter marketplace source:</p>'
        + '<input class="field psource" data-test="plugin-mkt-source" spellcheck="false" placeholder="owner/repo">'
        + '<p class="pex">Examples: owner/repo · git@github.com:owner/repo.git · https://example.com/marketplace.json · ./path/to/marketplace</p>',
      groups: [{ rows: [{ id: 'add', label: 'Add marketplace' }, { id: 'cancel', label: 'Cancel' }] }],
      pick: async (row) => {
        if (row.id === 'cancel') return void goBack()
        const src = document.querySelector<HTMLInputElement>('[data-test="plugin-mkt-source"]')?.value.trim() ?? ''
        if (!src) throw new Error('Please enter a marketplace source')
        this.host.toast('Adding marketplace to configuration…')
        await this.apply('add marketplace', ['marketplace', 'add', src], (r) => `✓ ${r.message ?? `Added ${src}`}`)
        goBack()
      },
    }
  }

  // ---------------------------------------------------------------- Errors

  private errorsTab(): Partial<MenuScreen> {
    const rows = this.s.installed.flatMap((p) => errorsOf(p).map((msg, i): MenuRow => ({
      id: `${p.id}#${i}`,
      label: nameOf(p.id),
      icon: '✘',
      tone: 'bad',
      meta: [p.scope, mktOf(p.id)].filter(Boolean).join(' · '),
      hint: msg,
    })))
    return {
      subtitle: `Errors · ${plural(rows.length, 'error')}`,
      groups: [{ rows }],
      empty: 'No plugin errors',
      notes: ['↑/↓ navigate · Enter view · Esc go back'],
      pick: (row) => this.pluginDetail(row.id.replace(/#\d+$/, '')),
    }
  }
}
