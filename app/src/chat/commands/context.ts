import { openMenu, type MenuGroup, type MenuRow, type MenuScreen } from '../menu'
import { control } from '../control'
import { esc } from '../../ui'
import type { CommandHost } from './index'

// /context, as the CLI 2.1.309 draws it (docs/research/cli-settings.md §10, chunk-m5hw2e93): the coloured grid of
// the window with the per-category legend beside it, the MCP tools / Custom agents / Memory files / Skills
// sections (summaries unless `/context all`), and the Suggestions the CLI derives from the same numbers.

/** The parts of the SDK's SDKControlGetContextUsageResponse the panel reads. */
type Usage = {
  categories: { id?: string; name: string; tokens: number; color: string; isDeferred?: boolean; kind: 'used' | 'free' | 'buffer' | 'deferred' }[]
  totalTokens: number
  maxTokens: number
  rawMaxTokens: number
  percentage: number
  gridRows: { color: string; isFilled: boolean; categoryName: string; tokens: number; percentage: number; squareFullness: number }[][]
  model: string
  memoryFiles: { path: string; type: string; tokens: number }[]
  mcpTools: { name: string; serverName: string; tokens: number; isLoaded?: boolean }[]
  agents: { agentType: string; source: string; tokens: number }[]
  skills?: { totalSkills: number; includedSkills: number; tokens: number; skillFrontmatter: { name: string; source: string; pluginName?: string; tokens: number }[] }
  isAutoCompactEnabled: boolean
  messageBreakdown?: { toolCallsByType: { name: string; callTokens: number; resultTokens: number }[] }
}

const FREE = 'Free space'
const BUFFER = 'Autocompact buffer'

/** The CLI's suggestion thresholds (Je, Ie, Do, Xe, wo, vo). */
const TOOL_PCT = 15
const TOOL_TOKENS = 10_000
const READ_PCT = 5
const FULL_PCT = 80
const MEMORY_PCT = 5
const MEMORY_TOKENS = 5000

/** Category colours: the app's context tokens (theme.css `--c-*`), the same ones the stats panel's memory bar uses. */
const COLOR: Record<string, string> = {
  system_prompt: 'var(--c-system)',
  system_tools: 'var(--c-tools)',
  system_tools_deferred: 'var(--c-tools)',
  mcp_tools: 'var(--c-mcp)',
  mcp_tools_deferred: 'var(--c-mcp)',
  mcp_instructions: 'color-mix(in oklab, var(--c-mcp) 60%, var(--c-system))',
  custom_agents: 'color-mix(in oklab, var(--c-tools) 50%, var(--c-mcp))',
  memory_files: 'var(--c-memory)',
  skills: 'color-mix(in oklab, var(--c-tools) 45%, var(--c-messages))',
  messages: 'var(--c-messages)',
  autocompact_buffer: 'var(--c-buffer)',
  compact_buffer: 'var(--c-buffer)',
  free_space: 'transparent',
}

/** A CLI that predates category ids: match its English names instead. */
const BY_NAME: [RegExp, string][] = [
  [/^system prompt/i, 'system_prompt'], [/^system tools/i, 'system_tools'], [/^mcp instructions/i, 'mcp_instructions'],
  [/^mcp tools/i, 'mcp_tools'], [/^custom agents/i, 'custom_agents'], [/^memory/i, 'memory_files'], [/^skills/i, 'skills'],
  [/^messages/i, 'messages'], [/buffer/i, 'autocompact_buffer'], [/^free/i, 'free_space'],
]

const idOf = (c: { id?: string; name: string }) => c.id ?? BY_NAME.find(([re]) => re.test(c.name))?.[1] ?? ''
const colorOf = (id: string) => COLOR[id] ?? 'var(--accent)'

/** The CLI's token counts (gr): 900, 1.2k, 200k. */
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
const fmt = (n: number) => compact.format(n).toLowerCase().replace('.0', '')
/** The skills list's estimate (AG): "< 20" or "~1.2k". */
const approx = (n: number) => (n < 20 ? '< 20' : `~${fmt(Math.round(n / 10) * 10)}`)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const sum = (xs: { tokens: number }[]) => xs.reduce((n, x) => n + x.tokens, 0)

/** Where an agent or skill comes from, in the CLI's group order (oSn, Po). */
const SOURCE: Record<string, string> = {
  userSettings: 'User', projectSettings: 'Project', localSettings: 'Local', flagSettings: 'Flag', policySettings: 'Managed',
  plugin: 'Plugin', 'built-in': 'Built-in', bundled: 'Built-in', mcp: 'MCP', memoryStore: 'Memory store', syncedSkills: 'Synced',
}
const SOURCE_ORDER = ['Project', 'User', 'Synced', 'Managed', 'Plugin', 'MCP', 'Built-in']
const sourceOf = (s: string, plugin?: string) => `${SOURCE[s] ?? s}${plugin && s !== 'syncedSkills' ? ` (${plugin})` : ''}`
const sourceRank = (label: string) => {
  const i = SOURCE_ORDER.findIndex((o) => label === o || label.startsWith(`${o} (`))
  return i < 0 ? SOURCE_ORDER.length : i
}

/** Opens /context; `/context all` expands every section, like the CLI's non-collapsed view. */
export function contextCommand(host: CommandHost, args: string) {
  const all = args.trim().toLowerCase() === 'all'
  const load = () => control<Usage>(host.link, 'getContextUsage', { detail: 'full' })
  openMenu(host, 'context', load().then((u) => screen(host, u, all, load)), 'Context Usage')
}

function screen(host: CommandHost, u: Usage, all: boolean, load: () => Promise<Usage>): MenuScreen {
  const groups = [...sections(u, all, host.cwd()), suggestionsGroup(u)].filter((g): g is MenuGroup => !!g && g.rows.length > 0)
  const anySection = u.mcpTools.length > 0 || u.agents.length > 0 || u.memoryFiles.length > 0 || (u.skills?.tokens ?? 0) > 0
  return {
    title: 'Context Usage',
    body: gridHtml(u),
    groups,
    empty: ' ',
    notes: !all && anySection ? ['/context all to expand'] : [],
    reload: async () => screen(host, await load(), all, load),
    pick: (row) => (row.id.startsWith('more:') ? screen(host, u, true, load) : undefined),
  }
}

// ---------------------------------------------------------------- grid and legend

function gridHtml(u: Usage) {
  const byName = new Map(u.categories.map((c) => [c.name, idOf(c)]))
  const cells = u.gridRows.map((row) => `<div class="cx-row">${row.map((sq) => {
    const id = byName.get(sq.categoryName) ?? idOf({ name: sq.categoryName })
    const kind = sq.categoryName === FREE ? 'free' : sq.categoryName === BUFFER ? 'buf' : sq.squareFullness >= 0.7 ? 'full' : 'part'
    const fill = Math.max(0.15, Math.min(1, sq.squareFullness))
    const tip = `${sq.categoryName} · ${fmt(sq.tokens)} tokens (${sq.percentage.toFixed(1)}%)`
    return `<i class="cx ${kind}" style="--cc:${colorOf(id)};--f:${fill}" title="${esc(tip)}" data-cat="${esc(id)}"></i>`
  }).join('')}</div>`).join('')
  const max = u.rawMaxTokens || u.maxTokens
  const pct = (n: number) => `${((n / max) * 100).toFixed(1)}%`
  // The legend lists what occupies the window; deferred tool schemas are out of it, free space and the buffer last.
  const shown = u.categories.filter((c) => c.tokens > 0 && c.name !== FREE && c.name !== BUFFER && !c.isDeferred && c.kind !== 'free' && c.kind !== 'buffer' && c.kind !== 'deferred')
  const free = u.categories.find((c) => c.name === FREE || c.kind === 'free')
  const buffer = u.categories.find((c) => c.name === BUFFER || c.kind === 'buffer')
  const line = (cls: string, id: string, name: string, tokens: number) =>
    `<li class="${cls}" data-test="context-category" data-id="${esc(id || name)}">`
    + `<b style="--cc:${colorOf(id)}"></b><span>${esc(name)}</span><em>${fmt(tokens)} tokens (${pct(tokens)})</em></li>`
  const legend = [
    ...shown.map((c) => line('', idOf(c), c.name, c.tokens)),
    ...(free && free.tokens > 0 ? [line('free', 'free_space', FREE, free.tokens)] : []),
    ...(buffer && buffer.tokens > 0 ? [line('buf', idOf(buffer), buffer.name, buffer.tokens)] : []),
  ].join('')
  return `<div class="ctx" data-test="context-grid">`
    + `<div class="cx-grid" role="img" aria-label="${esc(`${u.percentage}% of the context window used`)}">${cells}</div>`
    + `<div class="cx-legend"><div class="cx-model"><b>${esc(u.model)}</b></div>`
    + `<div class="cx-total" data-test="context-total">${fmt(u.totalTokens)}/${fmt(max)} tokens (${u.percentage}%)</div>`
    + `<div class="cx-meter"><i style="width:${Math.min(100, u.percentage)}%"></i></div>`
    + `<p class="cx-est">Estimated usage by category</p><ul>${legend}</ul></div></div>`
}

// ---------------------------------------------------------------- sections

function sections(u: Usage, all: boolean, cwd: string): MenuGroup[] {
  const out: MenuGroup[] = []
  const summary = (key: string, n: number, noun: string, tokens: number): MenuRow =>
    ({ id: `more:${key}`, label: `${plural(n, noun)} · ${fmt(tokens)} tokens`, icon: '▸', tone: 'muted', hint: 'Enter to expand' })

  if (u.mcpTools.length) {
    // Tool search on: some tools load only when used; the CLI then splits them into Loaded and Available.
    const onDemand = u.categories.some((c) => c.isDeferred && c.name.includes('MCP'))
    const loaded = u.mcpTools.filter((t) => t.isLoaded)
    const rows: MenuRow[] = !all
      ? [summary('mcp', u.mcpTools.length, 'tool', sum(onDemand ? loaded : u.mcpTools))]
      : onDemand
        ? [
          ...loaded.map((t) => ({ id: `mcp:${t.name}`, label: t.name, meta: `${fmt(t.tokens)} tokens`, hint: 'Loaded' })),
          ...u.mcpTools.filter((t) => !t.isLoaded).map((t) => ({ id: `mcp:${t.name}`, label: t.name, tone: 'muted' as const, hint: 'Available' })),
        ]
        : u.mcpTools.map((t) => ({ id: `mcp:${t.name}`, label: t.name, meta: `${fmt(t.tokens)} tokens` }))
    out.push({ title: 'MCP tools', note: `· /mcp${onDemand ? ' (loaded on-demand)' : ''}`, rows })
  }

  if (u.agents.length) {
    const rows: MenuRow[] = !all
      ? [summary('agents', u.agents.length, 'agent', sum(u.agents))]
      : bySource(u.agents.map((a) => ({ name: a.agentType, src: sourceOf(a.source), tokens: a.tokens })))
        .map((a) => ({ id: `agent:${a.name}`, label: a.name, meta: `${fmt(a.tokens)} tokens`, hint: a.src }))
    out.push({ title: 'Custom agents', note: '· .claude/agents/', rows })
  }

  if (u.memoryFiles.length) {
    const rows: MenuRow[] = !all
      ? [summary('memory', u.memoryFiles.length, 'file', sum(u.memoryFiles))]
      : u.memoryFiles.map((f) => ({ id: `memory:${f.path}`, label: shortPath(f.path, cwd), meta: `${fmt(f.tokens)} tokens`, hint: f.type }))
    out.push({ title: 'Memory files', note: '· /memory', rows })
  }

  const sk = u.skills
  if (sk && sk.tokens > 0) {
    const rows: MenuRow[] = !all
      ? [summary('skills', sk.skillFrontmatter.length, 'skill', sk.tokens)]
      : bySource(sk.skillFrontmatter.map((s) => ({ name: s.name, src: sourceOf(s.source, s.pluginName), tokens: s.tokens })))
        .map((s) => ({ id: `skill:${s.src}:${s.name}`, label: s.name, meta: `${approx(s.tokens)} tokens`, hint: s.src }))
    out.push({ title: 'Skills', note: '· /skills', rows })
  }
  return out
}

/** The CLI's grouping (ue): by source in its order, the largest first within each. */
function bySource<T extends { src: string; tokens: number }>(xs: T[]) {
  return [...xs].sort((a, b) => sourceRank(a.src) - sourceRank(b.src) || a.src.localeCompare(b.src) || b.tokens - a.tokens)
}

/** The CLI's Qo: a path inside the project shows relative to it. */
function shortPath(path: string, cwd: string) {
  const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase()
  if (cwd && norm(path).startsWith(norm(cwd) + '\\')) return path.slice(cwd.length + 1)
  return path.replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\)/, '~')
}

// ---------------------------------------------------------------- suggestions

type Suggestion = { severity: 'warning' | 'info'; title: string; detail: string; savings?: number }

/** The CLI's Ye(): its five rules, warnings first, then by tokens saved. */
export function suggestions(u: Usage): Suggestion[] {
  const out: Suggestion[] = []
  const max = u.rawMaxTokens || u.maxTokens
  const share = (n: number) => (n / max) * 100
  // Lo: nearly full.
  if (u.totalTokens <= max && u.percentage >= FULL_PCT) {
    out.push({
      severity: 'warning',
      title: `Context is ${u.percentage}% full`,
      detail: u.isAutoCompactEnabled
        ? 'Autocompact will trigger soon, which discards older messages. Use /compact now to control what gets kept.'
        : 'Autocompact is disabled. Use /compact to free space, or enable autocompact in /config.',
    })
  }
  const byType = u.messageBreakdown?.toolCallsByType ?? []
  // No, Mo: a tool whose calls and results take a big share.
  for (const t of byType) {
    const tokens = t.callTokens + t.resultTokens
    const p = share(tokens)
    if (p < TOOL_PCT || tokens < TOOL_TOKENS) continue
    const head = `${t.name} results using ${fmt(tokens)} tokens (${p.toFixed(0)}%)`
    if (t.name === 'Bash' || t.name === 'PowerShell') {
      out.push({
        severity: 'warning', title: head, savings: Math.floor(tokens * 0.5),
        detail: t.name === 'PowerShell'
          ? 'Pipe output through Select-Object -First/-Last or Select-String to reduce result size. Avoid Get-Content on large files — use Read with offset/limit instead.'
          : 'Pipe output through head, tail, or grep to reduce result size. Avoid cat on large files — use Read with offset/limit instead.',
      })
    } else if (t.name === 'Read') {
      out.push({ severity: 'info', title: head, savings: Math.floor(tokens * 0.3), detail: 'Use offset and limit parameters to read only the sections you need. Avoid re-reading entire files when you only need a few lines.' })
    } else if (t.name === 'Grep') {
      out.push({ severity: 'info', title: head, savings: Math.floor(tokens * 0.3), detail: 'Add more specific patterns or use the glob or type parameter to narrow file types. Consider Glob for file discovery instead of Grep.' })
    } else if (t.name === 'WebFetch') {
      out.push({ severity: 'info', title: head, savings: Math.floor(tokens * 0.4), detail: 'Web page content can be very large. Consider extracting only the specific information needed.' })
    } else if (p >= 20) {
      out.push({ severity: 'info', title: `${t.name} using ${fmt(tokens)} tokens (${p.toFixed(0)}%)`, savings: Math.floor(tokens * 0.2), detail: 'This tool is consuming a significant portion of context.' })
    }
  }
  // bo: file reads, when Read as a whole stayed under the tool rule.
  const read = byType.find((t) => t.name === 'Read')
  if (read && !(share(read.callTokens + read.resultTokens) >= TOOL_PCT && read.callTokens + read.resultTokens >= TOOL_TOKENS)) {
    const p = share(read.resultTokens)
    if (p >= READ_PCT && read.resultTokens >= TOOL_TOKENS) {
      out.push({ severity: 'info', title: `File reads using ${fmt(read.resultTokens)} tokens (${p.toFixed(0)}%)`, savings: Math.floor(read.resultTokens * 0.3), detail: 'If you are re-reading files, consider referencing earlier reads. Use offset/limit for large files.' })
    }
  }
  // Ao: memory files.
  const memory = sum(u.memoryFiles)
  if (share(memory) >= MEMORY_PCT && memory >= MEMORY_TOKENS) {
    const largest = [...u.memoryFiles].sort((a, b) => b.tokens - a.tokens).slice(0, 3).map((f) => `${f.path} (${fmt(f.tokens)})`).join(', ')
    out.push({ severity: 'info', title: `Memory files using ${fmt(memory)} tokens (${share(memory).toFixed(0)}%)`, savings: Math.floor(memory * 0.3), detail: `Largest: ${largest}. Use /memory to review and prune stale entries.` })
  }
  // Ro: autocompact off while half full.
  if (!u.isAutoCompactEnabled && u.percentage >= 50 && u.percentage < FULL_PCT) {
    out.push({ severity: 'info', title: 'Autocompact is disabled', detail: 'Without autocompact, you will hit context limits and lose the conversation. Enable it in /config or use /compact manually.' })
  }
  return out.sort((a, b) => (a.severity !== b.severity ? (a.severity === 'warning' ? -1 : 1) : (b.savings ?? 0) - (a.savings ?? 0)))
}

function suggestionsGroup(u: Usage): MenuGroup | undefined {
  const list = suggestions(u)
  if (!list.length) return
  return {
    title: 'Suggestions',
    rows: list.map((s, i) => ({
      id: `tip:${i}`,
      label: s.title,
      icon: s.severity === 'warning' ? '⚠' : 'ℹ',
      tone: s.severity === 'warning' ? 'warn' : 'accent',
      hint: s.detail,
      meta: s.savings ? `→ save ~${fmt(s.savings)}` : undefined,
    })),
  }
}
