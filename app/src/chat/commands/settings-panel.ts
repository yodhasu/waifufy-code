import { esc } from '../../ui'
import { control } from '../control'
import { detailRows, openMenu, type MenuResult, type MenuRow, type MenuScreen } from '../menu'
import type { CommandHost } from './index'

// The CLI 2.1.309's "Settings" dialog (docs/research/cli-settings.md §1–3, §9): one window with the tabs
// Status · Config · Usage · Stats. The command as typed picks the first tab: /status, /config (/settings),
// /usage and /cost, /stats. Config rows are saved through the CLI's own headless `/config id=value`, so its own
// writers and side effects run; the CLI's answer line is the toast.

type Tab = 'Status' | 'Config' | 'Usage' | 'Stats'
const TABS: Tab[] = ['Status', 'Config', 'Usage', 'Stats']

const firstTab = (typed: string): Tab =>
  typed === 'status' ? 'Status' : typed === 'usage' || typed === 'cost' ? 'Usage' : typed === 'stats' ? 'Stats' : 'Config'

/** A key no keyboard sends: a click on a tab dispatches it, so tab switches all go through the screen's `key`. */
const TAB_KEY = 'wc-settings-tab'

// ---------------------------------------------------------------- Config rows

type Store = 'global' | 'settings'
/** One /config row: its id (the `key` in `/config key=value`), the CLI's label, where its value lives and its default. */
type RowDef = { id: string; label: string; store: Store; path?: string[]; def?: string | boolean; read?(v: unknown): unknown }

const g = (id: string, label: string, key = id, def?: string | boolean): RowDef => ({ id, label, store: 'global', path: [key], def })
const s = (id: string, label: string, key: string | string[] = id, def?: string | boolean): RowDef =>
  ({ id, label, store: 'settings', path: Array.isArray(key) ? key : [key], def })

/** The CLI's Config rows that apply without a terminal, in its order (cli-settings.md §3). */
const ROWS: RowDef[] = [
  { ...g('remoteControl', 'Enable Remote Control for all sessions', 'remoteControlAtStartup'), read: (v) => (v === undefined ? 'default' : String(v)) },
  g('inputNeededNotifEnabled', 'Push when actions required', undefined, false),
  g('agentPushNotifEnabled', 'Push when Claude decides', undefined, false),
  g('autoCompact', 'Auto-compact', 'autoCompactEnabled', true),
  s('idleCompaction', 'Idle compaction', undefined, true),
  s('autoContinueAtUsageLimit', 'Continue automatically at usage limit', undefined, true),
  s('switchModelsOnFlag', 'Switch models when a message is flagged'),
  { ...s('tips', 'Show tips', 'spinnerTipsEnabled', true) },
  s('feedbackDrafts', 'Claude-drafted feedback', undefined, 'notify'),
  { ...s('thinking', 'Thinking mode', 'alwaysThinkingEnabled'), read: (v) => v !== false },
  s('fast', 'Fast mode', 'fastMode', false),
  s('promptSuggestionEnabled', 'Prompt suggestions', undefined, true),
  s('recap', 'Session recap', 'awaySummaryEnabled', true),
  g('checkpoints', 'Rewind code (checkpoints)', 'fileCheckpointingEnabled', true),
  { id: 'orgMemoryRead', label: 'Synced project memory (this directory; applies next session)', store: 'global', def: true },
  s('workflows', 'Dynamic workflows', 'enableWorkflows'),
  s('workflowKeywordTriggerEnabled', 'Ultracode keyword trigger', undefined, true),
  g('workflowSizeGuideline', 'Dynamic workflow size', undefined, 'medium'),
  s('artifacts', 'Artifacts', 'enableArtifact'),
  s('precomputeCompactionEnabled', 'Precompute compaction', undefined, true),
  s('timeFormat', 'Time format', undefined, 'auto'),
  s('permissionMode', 'Default permission mode', ['permissions', 'defaultMode'], 'default'),
  s('worktreeBaseRef', 'Worktree base ref', ['worktree', 'baseRef'], 'fresh'),
  s('useAutoModeDuringPlan', 'Use auto mode during plan', undefined, true),
  s('outputStyle', 'Output style', undefined, 'default'),
  s('language', 'Language', undefined, 'default'),
  s('askUserQuestionTimeout', 'Question auto-continue timeout', undefined, 'never'),
  s('modelProposedGoals', 'Claude-proposed goals'),
  s('model', 'Model', undefined, 'default'),
  g('chrome', 'Claude in Chrome enabled by default', 'claudeInChromeDefaultEnabled', false),
  s('dialogExpiry', 'Dialog expiry', undefined, 'default'),
  s('crossSessionInbound', 'Messages from your other sessions', undefined, 'default'),
]

/** Rows that only make sense in a terminal (or that the app draws itself), left out as cli-settings.md §3 says. */
const TERMINAL_ONLY = new Set([
  'theme', 'notifChannel', 'progressBar', 'showStatusInTerminalTab', 'editor', 'copyOnSelect', 'autoScroll', 'diffTool',
  'autoConnectIde', 'autoInstallIdeExtension', 'teammateMode', 'reduceMotion', 'agentsView', 'leftArrowOpensAgents',
  'defaultToAgentsView', 'defaultView', 'verbose', 'externalEditorContext', 'gitignore', 'autoUpdatesChannel',
  'turnDuration', 'timestamps', 'prStatus', 'copyFullResponse', 'showExternalIncludesDialog',
])

/** A row as the CLI offers it headless: `options` from its `id=a|b` usage line; `free` for `id=<value>`. */
type ConfigRow = RowDef & { type: 'boolean' | 'enum'; options: string[]; free?: boolean; value: unknown }

/** Parses bare `/config`'s usage text: `Usage: /config key=value …` and one `  id=true|false` line per row. */
function parseUsage(text: string) {
  const out = new Map<string, string>()
  for (const line of text.split('\n')) {
    const m = /^\s+([A-Za-z][\w-]*)=(\S+)\s*$/.exec(line)
    if (m) out.set(m[1], m[2])
  }
  return out
}

type Files = { source: 'user' | 'project' | 'local'; path: string; json: Record<string, unknown> }[]

const at = (o: unknown, path: string[]) => path.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o)

/** The Claude config folder, from where the user settings file lives (it follows CLAUDE_CONFIG_DIR). */
const claudeDir = (files: Files) => files.find((f) => f.source === 'user')?.path.replace(/[\\/]settings\.json$/, '') ?? '~/.claude'

async function readJson(host: CommandHost, path: string): Promise<Record<string, unknown> | undefined> {
  const text = await control<string | undefined>(host.link, 'readText', path).catch(() => undefined)
  if (!text) return undefined
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** The CLI's global config: `.claude.json` in CLAUDE_CONFIG_DIR, else `~/.claude.json`. */
async function globalConfig(host: CommandHost, files: Files) {
  const dir = claudeDir(files)
  return (await readJson(host, `${dir}/.claude.json`)) ?? (/[\\/]\.claude$/.test(dir) ? await readJson(host, '~/.claude.json') : undefined) ?? {}
}

async function loadConfig(host: CommandHost): Promise<ConfigRow[]> {
  const [usage, files] = await Promise.all([
    host.cli('/config').catch(() => ''),
    control<Files>(host.link, 'settingsFiles').catch(() => [] as Files),
  ])
  const global = await globalConfig(host, files)
  // Local settings win over project settings, which win over user settings.
  const order = ['local', 'project', 'user'].map((src) => files.find((f) => f.source === src)?.json ?? {})
  const offered = parseUsage(usage)
  const value = (d: RowDef) => {
    const raw = d.path ? (d.store === 'global' ? at(global, d.path) : order.map((j) => at(j, d.path!)).find((v) => v !== undefined)) : undefined
    const v = d.read ? d.read(raw) : raw
    return v === undefined ? d.def : v
  }
  const known = new Map(ROWS.map((d) => [d.id, d]))
  // The CLI's own list decides which rows exist (it hides gated and consent rows); our table gives labels and values.
  const ids = offered.size ? [...ROWS.map((d) => d.id).filter((id) => offered.has(id)), ...[...offered.keys()].filter((id) => !known.has(id))] : ROWS.map((d) => d.id)
  return ids
    .filter((id) => !TERMINAL_ONLY.has(id))
    .map((id): ConfigRow => {
      const d = known.get(id) ?? { id, label: id, store: 'settings' as const }
      const opts = offered.get(id)
      const bool = opts ? opts === 'true|false' : typeof d.def === 'boolean'
      return { ...d, type: bool ? 'boolean' : 'enum', options: bool || !opts || opts === '<value>' ? [] : opts.split('|'), free: opts === '<value>', value: value(d) }
    })
}

const shown = (v: unknown) => (v === undefined || v === null || v === '' ? '—' : String(v))

// ---------------------------------------------------------------- the dialog

/** Opens the Settings dialog, or applies `/config key=value …` without it, as the CLI does headless. */
export function settingsCommand(host: CommandHost, args: string, typed: string) {
  if ((typed === 'config' || typed === 'settings') && args.trim()) return void applyPairs(host, args.trim())
  let tab = firstTab(typed)
  let jump: Tab | undefined
  // Each tab loads once per dialog; `r` on the Usage and Stats tabs loads again.
  const cache: Partial<Record<Tab, Promise<unknown>>> = {}
  const load = <T,>(t: Tab, fn: () => Promise<T>, fresh = false): Promise<T> => {
    if (fresh || !cache[t]) cache[t] = fn()
    return cache[t] as Promise<T>
  }
  let config: ConfigRow[] = []
  /** Set by `r` (the CLI's settings:retry): the next build loads the tab again. */
  let refetch = false
  const retry: MenuScreen['key'] = (e) => {
    if (e.key !== 'r' || inSearch() || e.ctrlKey || e.altKey || e.metaKey) return false
    refetch = true
    return 'refresh'
  }

  const tabBar = () =>
    `<nav class="sp-tabs" role="tablist">${TABS.map((t) => `<button type="button" role="tab" class="sp-tab${t === tab ? ' on' : ''}" data-test="settings-tab" data-tab="${t}"${t === tab ? ' aria-selected="true"' : ''}>${t}</button>`).join('')}</nav>`

  const inSearch = () => (document.activeElement as HTMLElement | null)?.tagName === 'INPUT'

  /** The keys every tab shares: Tab / Shift+Tab and ←/→ switch tabs, as in the CLI's Tabs context. */
  function tabKey(e: KeyboardEvent): MenuResult | boolean {
    const step = e.key === TAB_KEY ? 0 : e.key === 'Tab' ? (e.shiftKey ? -1 : 1) : !inSearch() && e.key === 'ArrowRight' ? 1 : !inSearch() && e.key === 'ArrowLeft' ? -1 : undefined
    if (step === undefined || e.ctrlKey || e.altKey || e.metaKey) return false
    const next = e.key === TAB_KEY ? jump : TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length]
    if (!next || next === tab) return true
    tab = next
    // A query typed on the Config tab must not filter the next tab's rows.
    const search = menu.el.querySelector<HTMLInputElement>('[data-test="menu-search"]')
    if (search?.value) {
      search.value = ''
      search.dispatchEvent(new Event('input'))
    }
    return 'refresh'
  }

  const frame = (s: Omit<MenuScreen, 'title' | 'reload'> & { pane?: string }): MenuScreen => {
    const key = s.key
    return {
      ...s,
      title: 'Settings',
      body: `${tabBar()}${s.pane ? `<div class="sp-pane" data-test="settings-pane" data-tab="${tab}">${s.pane}</div>` : ''}${s.body ?? ''}`,
      reload: () => build(),
      key: (e, row) => {
        const r = tabKey(e)
        if (r !== false) return r
        return key ? key(e, row) : false
      },
    }
  }

  async function build(): Promise<MenuScreen> {
    const fresh = refetch
    refetch = false
    switch (tab) {
      case 'Status':
        return statusScreen(await load('Status', () => loadStatus(host), fresh))
      case 'Config':
        config = await load('Config', () => loadConfig(host), fresh)
        return configScreen()
      case 'Usage':
        return usageScreen(await load('Usage', () => control<Usage>(host.link, 'usage', { skipBehaviors: true }).then((u) => ({ u }), (e: unknown) => ({ e })), fresh))
      case 'Stats':
        return statsScreen(await load('Stats', () => loadStats(host), fresh))
    }
  }

  // ---- Status

  function statusScreen(st: Status): MenuScreen {
    return frame({ pane: detailRows(st.rows), groups: [], empty: ' ', notes: ['Esc cancel'] })
  }

  // ---- Config

  function configScreen(): MenuScreen {
    const toRow = (r: ConfigRow): MenuRow => ({
      id: r.id,
      label: r.label,
      meta: shown(r.value),
      hint: r.free ? `${r.id} · type /config ${r.id}=<value> in the chat` : r.id,
      tone: r.type === 'boolean' ? (r.value === true ? 'ok' : 'muted') : undefined,
    })
    const screen = frame({
      groups: [],
      search: true,
      empty: 'No settings to show.',
      notes: ['Enter/space change · ←/→/tab switch · Esc close'],
      pick: (row) => pickConfig(row),
      key: (e, row) => {
        if (e.key === ' ' && !inSearch() && row && config.find((r) => r.id === row.id)?.type === 'boolean') return pickConfig(row)
        return false
      },
    })
    // A getter, so coming back from an enum picker redraws with the value just saved.
    Object.defineProperty(screen, 'groups', {
      get: () => [
        { rows: [{ id: '__app', label: 'Waifufy Code settings…', icon: '⚙', tone: 'accent' as const, hint: 'Appearance, voice, text speed and the app’s own options' }] },
        { title: 'Claude Code', rows: config.map(toRow) },
      ],
    })
    return screen
  }

  /** Runs `/config id=value` and toasts the CLI's answer; true when the CLI saved it. */
  async function save(r: ConfigRow, v: string) {
    const out = (await host.cli(`/config ${r.id}=${v}`)).trim()
    host.toast(out || `Set ${r.label} to ${v}`)
    const ok = !out || /^Set /.test(out)
    if (ok) r.value = r.type === 'boolean' ? v === 'true' : v
    return ok
  }

  async function pickConfig(row: MenuRow): Promise<MenuResult> {
    if (row.id === '__app') {
      queueMicrotask(() => host.ctx.router.go('settings'))
      return 'close'
    }
    const r = config.find((x) => x.id === row.id)
    if (!r) return
    if (r.type === 'boolean') {
      await save(r, r.value === true ? 'false' : 'true')
      return 'refresh'
    }
    if (r.free || !r.options.length) return void host.toast(`Type /config ${r.id}=<value> in the chat to change ${r.label}`)
    return {
      title: r.label,
      subtitle: `Currently: ${shown(r.value)}`,
      groups: [{ rows: r.options.map((o) => ({ id: o, label: o, on: String(r.value) === o })) }],
      search: r.options.length > 8,
      async pick(o) {
        if (await save(r, o.id)) {
          // Back to the Config tab, like the CLI's picker closing on Enter (Esc is the menu's only "back").
          dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          return
        }
        return 'refresh'
      },
    }
  }

  // ---- Usage

  function usageScreen(res: { u?: Usage; e?: unknown }): MenuScreen {
    if (!res.u) {
      const msg = res.e instanceof Error ? res.e.message : String(res.e ?? 'No usage data')
      return frame({ pane: `<p class="empty bad">${esc(msg)}</p>`, groups: [], empty: ' ', notes: ['r retry · Esc cancel'], key: retry })
    }
    return frame({ pane: usagePane(res.u), groups: [], empty: ' ', notes: ['r retry · Esc cancel'], key: retry })
  }

  // ---- Stats

  function statsScreen(st: Stats): MenuScreen {
    if (!st.data) {
      return frame({
        pane: `<p class="empty">No stats yet. Claude Code keeps them in ${esc(st.path)} as you use it.</p>`,
        groups: [],
        empty: ' ',
        notes: ['r reload · Esc cancel'],
        key: retry,
      })
    }
    const models = Object.entries(st.data.modelUsage ?? {}).sort((a, b) => tokensOf(b[1]) - tokensOf(a[1]))
    return frame({
      pane: statsPane(st.data),
      groups: [{
        title: 'Models',
        rows: models.map(([name, u]) => ({
          id: name,
          label: name,
          meta: `${tok(tokensOf(u))} tokens`,
          hint: `Input ${tok(u.inputTokens ?? 0)} · Output ${tok(u.outputTokens ?? 0)} · Cache read ${tok(u.cacheReadInputTokens ?? 0)} · Cache write ${tok(u.cacheCreationInputTokens ?? 0)}`,
        })),
      }],
      empty: ' ',
      notes: [`From ${st.path}${st.data.lastComputedDate ? ` · computed ${st.data.lastComputedDate}` : ''}`, 'r reload · Esc cancel'],
      key: retry,
    })
  }

  const menu = openMenu(host, 'settings', build(), 'Settings')
  // Status and Usage have no rows to focus: take the focus off the chat input, so Tab reaches the dialog, not the
  // composer's completion.
  const win = menu.el.querySelector<HTMLElement>('.modal')
  if (win) {
    win.tabIndex = -1
    win.focus({ preventScroll: true })
  }
  // Clicking a tab switches to it through the same key path as Tab and ←/→.
  menu.el.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('.sp-tab')?.dataset.tab as Tab | undefined
    if (!t) return
    jump = t
    dispatchEvent(new KeyboardEvent('keydown', { key: TAB_KEY, bubbles: true }))
  })
}

/** `/config key=value [key=value …]`: the CLI's own headless writer, one answer line per pair. */
async function applyPairs(host: CommandHost, args: string) {
  try {
    const out = (await host.cli(`/config ${args}`)).trim()
    host.toast(out.split('\n').filter(Boolean).join(' · ') || 'Done')
  } catch (e) {
    host.toast(e instanceof Error ? e.message : String(e))
  }
}

// ---------------------------------------------------------------- Status data

type Status = { rows: [string, string | undefined][] }
type Init = { claude_code_version?: string; models?: { value: string; resolvedModel?: string; displayName: string }[]; output_style?: string }
type Account = { email?: string; organization?: string; subscriptionType?: string; tokenSource?: string; apiKeySource?: string; apiProvider?: string }

const PROVIDERS: Record<string, string> = {
  bedrock: 'AWS Bedrock', vertex: 'Google Vertex AI', foundry: 'Microsoft Foundry', anthropicAws: 'Claude Platform on AWS',
  anthropicGoogleCloud: 'Claude Platform on Google Cloud', mantle: 'Bedrock (Mantle)', gateway: 'Gateway',
}
const SOURCES: Record<string, string> = { user: 'User settings', project: 'Shared project settings', local: 'Project local settings' }
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)

async function loadStatus(host: CommandHost): Promise<Status> {
  const soft = <T,>(p: Promise<T>) => p.catch(() => undefined)
  const [init, acct, mcp, ctx, files] = await Promise.all([
    soft(control<Init>(host.link, 'initializationResult')),
    soft(control<Account>(host.link, 'accountInfo')),
    soft(control<{ name: string; status: string }[]>(host.link, 'mcpServerStatus')),
    soft(control<{ model?: string }>(host.link, 'getContextUsage', { detail: 'summary' })),
    soft(control<(Files[number] & { exists?: boolean })[]>(host.link, 'settingsFiles')),
  ])
  const firstParty = !acct?.apiProvider || acct.apiProvider === 'firstParty'
  const model = ctx?.model
  const row = model ? init?.models?.find((m) => m.value !== 'default' && (m.resolvedModel === model || m.value === model)) : undefined
  const glyph = (st: string) => (st === 'connected' ? '✔' : st === 'failed' ? '✘' : st === 'disabled' ? '◯' : '⚠')
  const servers = (mcp ?? []).filter((x) => x.name !== 'ide')
  return {
    rows: [
      ['Version', init?.claude_code_version],
      ['cwd', host.cwd()],
      ['Login method', firstParty && acct?.subscriptionType ? `Claude ${cap(acct.subscriptionType)} account` : acct?.apiKeySource ? 'API key' : undefined],
      ['Auth token', acct?.tokenSource && acct.tokenSource !== 'none' ? acct.tokenSource : undefined],
      ['API key', acct?.apiKeySource && acct.apiKeySource !== 'none' ? acct.apiKeySource : undefined],
      ['Organization', acct?.organization],
      ['Email', acct?.email],
      ['API provider', firstParty ? undefined : (PROVIDERS[acct!.apiProvider!] ?? acct!.apiProvider)],
      ['Model', model ? (row ? `${row.displayName} (${model})` : model) : undefined],
      ['MCP servers', servers.length ? `${servers.map((x) => `${x.name} ${glyph(x.status)}`).join(', ')} · /mcp` : undefined],
      ['Setting sources', (files ?? []).filter((f) => f.exists).map((f) => SOURCES[f.source] ?? f.source).join(', ') || undefined],
    ],
  }
}

// ---------------------------------------------------------------- Usage data

type Window = { utilization: number | null; resets_at: string | null } | null | undefined
/** The parts of the SDK's experimental usage answer (SDKControlGetUsageResponse) the tab reads. */
type Usage = {
  session: {
    total_cost_usd: number
    total_api_duration_ms: number
    total_duration_ms: number
    total_lines_added: number
    total_lines_removed: number
    model_usage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }>
  }
  subscription_type: string | null
  rate_limits_available: boolean
  rate_limits: {
    five_hour?: Window
    seven_day?: Window
    seven_day_oauth_apps?: Window
    seven_day_opus?: Window
    seven_day_sonnet?: Window
    model_scoped?: { display_name: string; utilization: number | null; resets_at: string | null }[]
    extra_usage?: { is_enabled: boolean; monthly_limit: number | null; used_credits: number | null; utilization: number | null; currency?: string | null } | null
  } | null
}

const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)))
const tokensOf = (u: { inputTokens?: number; outputTokens?: number }) => (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
const usd = (n: number) => `$${n >= 0.5 ? n.toFixed(2) : n.toFixed(4)}`
/** The CLI's credit amounts are in cents. */
const money = (cents: number, currency = 'USD') => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`
  }
}

function dur(ms: number) {
  const sec = Math.round(ms / 1000)
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s2 = sec % 60
  return h ? `${h}h ${m}m ${s2}s` : m ? `${m}m ${s2}s` : `${(ms / 1000).toFixed(1)}s`
}

/** "Resets 5:14pm (Europe/Amsterdam)", with the date for the weekly windows, as the CLI's limit bars say. */
function resets(iso: string | null, withDate: boolean) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase()
  const day = withDate ? `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ` : ''
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return `Resets ${day}${time}${zone ? ` (${zone})` : ''}`
}

function bar(title: string, w: Window, withDate: boolean) {
  if (!w || w.utilization === null) return ''
  const pct = Math.max(0, Math.min(100, w.utilization))
  const tone = pct >= 90 ? ' bad' : pct >= 70 ? ' warn' : ''
  return `<div class="sp-limit" data-test="usage-bar" data-title="${esc(title)}"><b>${esc(title)}</b>`
    + `<div class="sp-meter${tone}"><i style="width:${pct}%"></i></div>`
    + `<small>${Math.floor(pct)}% used${w.resets_at ? ` · ${esc(resets(w.resets_at, withDate))}` : ''}</small></div>`
}

function usagePane(u: Usage) {
  const s = u.session
  const models = Object.entries(s.model_usage ?? {})
  const byModel = models
    .map(([m, x]) => `${m}: ${tok(x.inputTokens)} input, ${tok(x.outputTokens)} output, ${tok(x.cacheReadInputTokens)} cache read, ${tok(x.cacheCreationInputTokens)} cache write (${usd(x.costUSD)})`)
    .join('\n')
  const session = `<h3 class="sp-h">Current session</h3>` + detailRows([
    ['Total cost:', usd(s.total_cost_usd)],
    ['Total duration (API):', dur(s.total_api_duration_ms)],
    ['Total duration (wall):', dur(s.total_duration_ms)],
    ['Total code changes:', `${s.total_lines_added} ${s.total_lines_added === 1 ? 'line' : 'lines'} added, ${s.total_lines_removed} ${s.total_lines_removed === 1 ? 'line' : 'lines'} removed`],
    ['Usage by model:', byModel || 'No API calls yet'],
  ])
  const rl = u.rate_limits
  if (!u.rate_limits_available || !rl) {
    return `${session}<h3 class="sp-h">Plan usage limits</h3><p class="sp-note" data-test="usage-unavailable">Plan usage limits aren’t available for this session: they apply to Claude.ai subscriptions, not API keys, Bedrock, Vertex or other providers.</p>`
  }
  const sonnetOnly = u.subscription_type === 'max' || u.subscription_type === 'team' || u.subscription_type === null
  const bars = [
    bar('Current session', rl.five_hour, false),
    bar('Current week (all models)', rl.seven_day, true),
    sonnetOnly ? bar('Current week (Sonnet only)', rl.seven_day_sonnet, true) : '',
    bar('Current week (Opus only)', rl.seven_day_opus, true),
    bar('Current week (OAuth apps)', rl.seven_day_oauth_apps, true),
    ...(rl.model_scoped ?? []).map((m) => bar(`Current week (${m.display_name})`, m, true)),
  ].join('')
  const x = rl.extra_usage
  let extra = ''
  if (x) {
    const cur = x.currency ?? 'USD'
    const line = !x.is_enabled
      ? 'Usage credits are off · /usage-credits to turn them on'
      : x.monthly_limit === null
        ? (typeof x.used_credits === 'number' ? `${money(x.used_credits, cur)} spent` : 'Unlimited')
        : `${money(x.used_credits ?? 0, cur)} / ${money(x.monthly_limit, cur)} spent`
    const pct = x.is_enabled && x.monthly_limit ? (x.utilization ?? ((x.used_credits ?? 0) / x.monthly_limit) * 100) : null
    extra = pct !== null
      ? `<div class="sp-limit" data-test="usage-bar" data-title="Extra usage"><b>Extra usage</b><div class="sp-meter"><i style="width:${Math.min(100, pct)}%"></i></div><small>${esc(line)}</small></div>`
      : `<div class="sp-limit" data-test="usage-extra"><b>Extra usage</b><small>${esc(line)}</small></div>`
  }
  return `${session}<h3 class="sp-h">Plan usage limits</h3>${bars || '<p class="sp-note">No limit windows reported yet.</p>'}${extra}`
}

// ---------------------------------------------------------------- Stats data

/** The CLI's `stats-cache.json` (version 5), the parts the tab reads. */
type StatsCache = {
  lastComputedDate?: string | null
  dailyActivity?: { date: string; messageCount: number; sessionCount: number; toolCallCount: number }[]
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>
  totalSessions?: number
  totalMessages?: number
  longestSession?: { duration?: number; messageCount?: number; timestamp?: string } | null
  firstSessionDate?: string | null
}
type Stats = { path: string; data?: StatsCache }

async function loadStats(host: CommandHost): Promise<Stats> {
  const files = await control<Files>(host.link, 'settingsFiles').catch(() => [] as Files)
  const path = `${claudeDir(files)}/stats-cache.json`
  const data = (await readJson(host, path)) as StatsCache | undefined
  return { path, data: data && Array.isArray(data.dailyActivity) ? data : undefined }
}

const DAY_MS = 86_400_000
const dayNum = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY_MS)

function streaks(dates: string[]) {
  const days = [...new Set(dates.map(dayNum))].filter(Number.isFinite).sort((a, b) => a - b)
  let longest = 0
  let run = 0
  days.forEach((d, i) => {
    run = i && d === days[i - 1] + 1 ? run + 1 : 1
    longest = Math.max(longest, run)
  })
  const now = new Date()
  const today = dayNum(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`)
  const last = days.at(-1)
  const current = last !== undefined && today - last <= 1 ? run : 0
  return { current, longest }
}

function statsPane(st: StatsCache) {
  const activity = st.dailyActivity ?? []
  const models = Object.entries(st.modelUsage ?? {})
  const total = models.reduce((n, [, u]) => n + tokensOf(u), 0)
  const fav = models.sort((a, b) => tokensOf(b[1]) - tokensOf(a[1]))[0]?.[0]
  const busiest = [...activity].sort((a, b) => b.messageCount - a.messageCount)[0]
  const { current, longest } = streaks(activity.filter((a) => a.messageCount > 0 || a.sessionCount > 0).map((a) => a.date))
  const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`
  const ls = st.longestSession
  return detailRows([
    ['Sessions', String(st.totalSessions ?? 0)],
    ['Messages', String(st.totalMessages ?? 0)],
    ['Total tokens', tok(total)],
    ['Active days', String(activity.length)],
    ['Current streak', days(current)],
    ['Longest streak', days(longest)],
    ['Longest session', ls?.duration ? `${dur(ls.duration)}${ls.messageCount ? ` · ${ls.messageCount} messages` : ''}` : undefined],
    ['Most active day', busiest ? `${busiest.date} · ${busiest.messageCount} messages` : undefined],
    ['Favorite model', fav],
    ['First session', st.firstSessionDate ? st.firstSessionDate.slice(0, 10) : undefined],
  ])
}
