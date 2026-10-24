import { detailRows, openMenu, type MenuHost, type MenuResult, type MenuRow, type MenuScreen, type Tone } from '../menu'
import { control } from '../control'
import type { Link } from '../../contracts'

// /mcp, as the CLI 2.1.309 draws it (docs/research/cli-extensions.md §1): servers grouped by where they are
// configured, a status glyph and meta per row, a detail screen per server with its actions, and its tools.

/** The parts of the SDK's McpServerStatus the panel reads. */
export type McpServer = {
  name: string
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  serverInfo?: { name: string; version: string }
  error?: string
  config?: { type?: string; command?: string; args?: string[]; url?: string; name?: string }
  scope?: string
  source?: string
  tools?: { name: string; description?: string; annotations?: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean } }[]
}

export type McpHost = MenuHost & { link: Link; cwd(): string }

/** The CLI's group order and headings. Scopes it doesn't name (sdk, plugin, dynamic) are the built-in group. */
const GROUPS: { scopes: string[]; title: string; note(cwd: string): string }[] = [
  { scopes: ['project'], title: 'Project MCPs', note: (cwd) => `${cwd}\\.mcp.json` },
  { scopes: ['local'], title: 'Local MCPs', note: (cwd) => `~\\.claude.json [project: ${cwd}]` },
  { scopes: ['user'], title: 'User MCPs', note: () => '~\\.claude.json' },
  { scopes: ['enterprise'], title: 'Enterprise MCPs', note: () => 'managed-mcp.json' },
  { scopes: ['managed'], title: 'Managed MCPs', note: () => 'provided by your organization' },
  { scopes: ['claudeai'], title: 'claude.ai', note: () => '' },
  { scopes: ['agent'], title: 'Agent MCPs', note: () => 'agent frontmatter' },
]
const BUILT_IN = { title: 'Built-in MCPs', note: 'always available' }

/** How often /mcp re-reads the servers while one is still connecting. */
const PENDING_POLL_MS = 1500

const isRemote = (s: McpServer) => ['http', 'sse', 'claudeai-proxy', 'ws'].includes(s.config?.type ?? '')
const toolCount = (s: McpServer) => s.tools?.length ?? 0
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The row's glyph, tone and meta words, as the CLI's server list shows them. */
function look(s: McpServer): { icon: string; tone: Tone; meta: string; word: string } {
  switch (s.status) {
    case 'connected':
      return toolCount(s)
        ? { icon: '✔', tone: 'ok', meta: plural(toolCount(s), 'tool'), word: 'connected' }
        : { icon: '⚠', tone: 'warn', meta: 'no tools · connected', word: 'connected · no tools' }
    case 'pending':
      return { icon: '…', tone: 'muted', meta: 'connecting…', word: 'connecting…' }
    case 'needs-auth':
      return { icon: '⚠', tone: 'warn', meta: 'needs authentication', word: 'needs authentication' }
    case 'disabled':
      return { icon: '◯', tone: 'muted', meta: 'disabled', word: 'disabled' }
    default:
      return { icon: '✘', tone: 'bad', meta: 'failed', word: 'failed' }
  }
}

function where(s: McpServer, cwd: string) {
  const g = GROUPS.find((x) => x.scopes.includes(s.scope ?? ''))
  return g ? g.note(cwd) || g.title : BUILT_IN.note
}

/** Opens /mcp, or runs `/mcp reconnect|enable|disable [<server>|all]` without the panel, like the CLI. */
export function mcpCommand(host: McpHost, args: string) {
  const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const target = rest.join(' ')
  if (verb === 'reconnect' || verb === 'enable' || verb === 'disable') return void bulk(host, verb, target || 'all')
  if (verb && verb !== 'no-redirect') {
    host.toast('Usage: /mcp [reconnect|enable|disable [<server>|all]]. With no server name, applies to all.')
    return
  }
  let pending = false
  const list = () =>
    control<McpServer[]>(host.link, 'mcpServerStatus').then((servers) => {
      pending = servers.some((x) => x.status === 'pending')
      return servers
    })
  const menu = openMenu(host, 'mcp', list().then((servers) => listScreen(host, servers, list)), 'Manage MCP servers')
  // Servers still connecting update in place, as the CLI's list does, until none is pending.
  const poll = window.setInterval(() => pending && menu.refresh(), PENDING_POLL_MS)
  void menu.closed.then(() => clearInterval(poll))
}

function listScreen(host: McpHost, servers: McpServer[], list: () => Promise<McpServer[]>): MenuScreen {
  const cwd = host.cwd()
  const shown = servers.filter((s) => s.name !== 'ide').sort((a, b) => a.name.localeCompare(b.name))
  const groups = [
    ...GROUPS.map((g) => ({ title: g.title, note: g.note(cwd), rows: shown.filter((s) => g.scopes.includes(s.scope ?? '')) })),
    { title: BUILT_IN.title, note: `(${BUILT_IN.note})`, rows: shown.filter((s) => !GROUPS.some((g) => g.scopes.includes(s.scope ?? ''))) },
  ]
    .filter((g) => g.rows.length)
    .map((g) => ({
      title: g.title,
      note: g.note && !g.note.startsWith('(') ? `(${g.note})` : g.note,
      rows: g.rows.map((s): MenuRow => {
        const l = look(s)
        return { id: s.name, label: s.name, icon: l.icon, tone: l.tone, meta: l.meta }
      }),
    }))
  const failed = shown.some((s) => s.status === 'failed')
  const screen: MenuScreen = {
    title: 'Manage MCP servers',
    subtitle: plural(shown.length, 'server'),
    groups,
    search: shown.length > 8,
    empty: 'No MCP servers configured. Add one with claude mcp add, or see https://code.claude.com/docs/en/mcp.',
    notes: [...(failed ? ['※ Run claude --debug to see error logs'] : []), 'https://code.claude.com/docs/en/mcp for help'],
    pick: (row) => {
      const s = shown.find((x) => x.name === row.id)
      return s && detailScreen(host, s, list)
    },
    reload: async () => listScreen(host, await list(), list),
  }
  return screen
}

function detailScreen(host: McpHost, s: McpServer, list: () => Promise<McpServer[]>): MenuScreen {
  const cwd = host.cwd()
  const l = look(s)
  const remote = isRemote(s)
  const proxy = s.config?.type === 'claudeai-proxy'
  const command = s.config?.command ? [s.config.command, ...(s.config.args ?? [])].join(' ') : undefined
  const body = detailRows([
    ['Status:', `${l.icon} ${l.word}`],
    ['Issue:', s.status === 'failed' || s.status === 'needs-auth' ? s.error : undefined],
    ['Type:', s.config?.type ?? (command ? 'stdio' : undefined)],
    ['URL:', remote ? s.config?.url : undefined],
    ['Command:', remote ? undefined : command],
    ['Server:', s.serverInfo ? `${s.serverInfo.name} ${s.serverInfo.version}` : undefined],
    ['Config location:', where(s, cwd)],
    ['Tools:', s.status === 'connected' ? plural(toolCount(s), 'tool') : undefined],
  ])
  const off = s.status === 'disabled'
  const rows: MenuRow[] = [
    ...(off ? [{ id: 'enable', label: 'Enable' }] : []),
    ...(s.status === 'connected' && toolCount(s) ? [{ id: 'tools', label: 'View tools' }] : []),
    ...(remote && !off && s.status === 'needs-auth' ? [{ id: 'auth', label: 'Authenticate' }] : []),
    ...(remote && !off && s.status === 'connected' && !proxy ? [{ id: 'reauth', label: 'Re-authenticate' }] : []),
    ...(remote && !off && s.status === 'connected' ? [{ id: 'clear', label: 'Clear authentication', danger: true }] : []),
    ...(!off ? [{ id: 'reconnect', label: 'Reconnect' }] : []),
    ...(!off ? [{ id: 'disable', label: 'Disable', danger: true }] : []),
  ]
  const fresh = async () => {
    const now = (await list()).find((x) => x.name === s.name)
    if (!now) throw new Error(`MCP server "${s.name}" not found`)
    return detailScreen(host, now, list)
  }
  return {
    title: `${s.name} MCP Server`,
    body,
    groups: [{ rows: rows.length ? rows : [{ id: 'back', label: 'Back' }] }],
    reload: fresh,
    async pick(row): Promise<MenuResult> {
      switch (row.id) {
        case 'tools':
          return toolsScreen(s)
        case 'enable':
        case 'disable':
          await control(host.link, 'toggleMcpServer', s.name, row.id === 'enable')
          host.toast(`MCP server "${s.name}" ${row.id}d`)
          return 'refresh'
        case 'reconnect':
          host.toast(`Reconnecting to ${s.name}…`)
          await control(host.link, 'reconnectMcpServer', s.name)
          host.toast(await reconnectWord(host, s.name, list))
          return 'refresh'
        case 'auth':
        case 'reauth':
          await control(host.link, 'mcpLogin', s.name)
          return authScreen(host, s, list)
        case 'clear':
          await control(host.link, 'mcpLogout', s.name)
          host.toast(`Authentication cleared for ${s.name}.`)
          return 'refresh'
        case 'back':
          return 'close'
      }
    },
  }
}

/** While the browser flow runs in its console window: Enter reconnects with the new credentials. */
function authScreen(host: McpHost, s: McpServer, list: () => Promise<McpServer[]>): MenuScreen {
  return {
    title: `Authenticating with ${s.name}…`,
    body: '<p>A browser window will open for authentication. A console window shows the sign-in link if it doesn\'t.</p>'
      + '<p>Return here after authenticating in your browser.</p>',
    groups: [{ rows: [{ id: 'done', label: 'I signed in · reconnect' }, { id: 'back', label: 'Back' }] }],
    async pick(row): Promise<MenuResult> {
      if (row.id === 'back') return 'close'
      await control(host.link, 'reconnectMcpServer', s.name).catch(() => undefined)
      const word = await reconnectWord(host, s.name, list)
      host.toast(word.startsWith('Successfully') ? `Authentication successful. Connected to ${s.name}.` : word)
      return 'close'
    },
  }
}

/** The CLI's reconnect outcome line, read back from the server's new state. */
async function reconnectWord(host: McpHost, name: string, list: () => Promise<McpServer[]>) {
  const now = (await list()).find((x) => x.name === name)
  if (!now) return `MCP server "${name}" not found`
  if (now.status === 'connected') return `Successfully reconnected to ${name}`
  if (now.status === 'needs-auth') return `${name} requires authentication. Use /mcp to authenticate.`
  return `Failed to reconnect to ${name}${now.error ? `: ${now.error}` : ''}`
}

function toolsScreen(s: McpServer): MenuScreen {
  const tools = [...(s.tools ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  const tags = (t: NonNullable<McpServer['tools']>[number]) =>
    [t.annotations?.readOnly && 'read-only', t.annotations?.destructive && 'destructive', t.annotations?.openWorld && 'open-world'].filter(Boolean).join(' · ')
  return {
    title: `Tools for ${s.name}`,
    subtitle: plural(tools.length, 'tool'),
    groups: [{ rows: tools.map((t) => ({ id: t.name, label: t.name, meta: tags(t), hint: t.description?.split('\n')[0] })) }],
    search: tools.length > 8,
    empty: 'No tools available',
    pick(row) {
      const t = tools.find((x) => x.name === row.id)
      if (!t) return
      const flags = tags(t)
      return {
        title: `${t.name}${flags ? ` [${flags}]` : ''}`,
        subtitle: s.name,
        body: detailRows([
          ['Tool name:', t.name],
          ['Full name:', `mcp__${s.name.replace(/[^a-zA-Z0-9_-]/g, '_')}__${t.name}`],
          ['Description:', t.description ?? '(none)'],
        ]),
        groups: [],
        empty: ' ',
      }
    },
  }
}

/** `/mcp reconnect|enable|disable [<server>|all]`: the CLI's headless forms, answered with its result lines. */
async function bulk(host: McpHost, verb: 'reconnect' | 'enable' | 'disable', target: string) {
  try {
    const all = await control<McpServer[]>(host.link, 'mcpServerStatus')
    const named = target === 'all' ? undefined : all.find((s) => s.name === target)
    if (target !== 'all' && !named) return host.toast(`MCP server "${target}" not found`)
    if (verb === 'reconnect') {
      const want = named ? [named] : all.filter((s) => s.status === 'failed' || s.status === 'pending' || s.status === 'needs-auth')
      if (!want.length) return host.toast('No MCP servers need reconnecting')
      host.toast(`Reconnecting ${plural(want.length, 'MCP server')}…`)
      await Promise.all(want.map((s) => control(host.link, 'reconnectMcpServer', s.name).catch(() => undefined)))
      if (named) return host.toast(await reconnectWord(host, named.name, () => control<McpServer[]>(host.link, 'mcpServerStatus')))
      const after = await control<McpServer[]>(host.link, 'mcpServerStatus')
      const ok = want.filter((w) => after.find((s) => s.name === w.name)?.status === 'connected').length
      return host.toast(`Reconnected ${ok} of ${want.length} MCP servers${ok < want.length ? ` (${want.length - ok} still not connected — run /mcp to check)` : ''}`)
    }
    const on = verb === 'enable'
    const want = named ? [named] : all.filter((s) => (s.status === 'disabled') === on)
    if (!want.length) return host.toast(`All MCP servers are already ${verb}d`)
    await Promise.all(want.map((s) => control(host.link, 'toggleMcpServer', s.name, on)))
    host.toast(named ? `MCP server "${named.name}" ${verb}d` : `${on ? 'Enabled' : 'Disabled'} ${plural(want.length, 'MCP server')}`)
  } catch (e) {
    host.toast(e instanceof Error ? e.message : String(e))
  }
}
