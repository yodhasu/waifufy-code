import type { BgTask } from '../../../../link/src/protocol.ts'
import { control } from '../control'
import { detailRows, openMenu, type MenuGroup, type MenuResult, type MenuRow, type MenuScreen, type Tone } from '../menu'
import type { CommandHost } from './index'

// /tasks (alias /bashes): the CLI 2.1.309's "Background" dialog (docs/research/cli-session.md, /tasks). Tasks are
// grouped as the CLI groups them, with its status glyphs and row meta; the list redraws live from the session's
// bg_tasks while open; Enter opens a task's detail and `x` stops a running one through the SDK's stopTask.

/** The CLI's groups, in its order. Finished local agents move to Completed; other tasks keep their group. */
const GROUPS: { key: string; title?: string; types: string[] }[] = [
  { key: 'agents', title: 'Agents', types: ['in_process_teammate'] },
  { key: 'shells', title: 'Shells', types: ['local_bash'] },
  { key: 'monitors', title: 'Monitors', types: ['monitor_mcp', 'monitor_ws'] },
  { key: 'mcp-tasks', title: 'MCP tasks', types: ['mcp_task'] },
  { key: 'cloud-agents', title: 'Cloud agents', types: ['remote_agent'] },
  { key: 'local-agents', title: 'Local agents', types: ['local_agent'] },
  { key: 'completed', title: 'Completed', types: [] },
  { key: 'workflows', title: 'Dynamic workflows', types: ['local_workflow'] },
  // The CLI lists these without a heading.
  { key: 'other', types: [] },
]

const isLive = (t: BgTask) => t.status === 'running' || t.status === 'pending' || t.status === 'paused'
const isAgent = (t: BgTask) => t.type === 'local_agent' || t.type === 'remote_agent' || t.type === 'in_process_teammate'
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function groupOf(t: BgTask) {
  if (t.type === 'local_agent' && !isLive(t)) return 'completed'
  return GROUPS.find((g) => g.types.includes(t.type))?.key ?? 'other'
}

/** The CLI's status glyphs (its StatusIcon): ● running, ◯ pending/paused, ✔ done, ✘ failed, ⚠ stopped. */
function glyph(t: BgTask): { icon: string; tone: Tone } {
  switch (t.status) {
    case 'running':
      return { icon: '●', tone: 'accent' }
    case 'completed':
      return { icon: '✔', tone: 'ok' }
    case 'failed':
      return { icon: '✘', tone: 'bad' }
    case 'killed':
      return { icon: '⚠', tone: 'warn' }
    default:
      return { icon: '◯', tone: 'muted' }
  }
}

/** The CLI's status word: a shell says done / error / stopped / running, the others done or their status. */
function word(t: BgTask) {
  if (t.type === 'local_bash') return { completed: 'done', failed: 'error', killed: 'stopped' }[t.status as string] ?? 'running'
  if (t.status === 'completed') return 'done'
  return t.status === 'killed' ? 'stopped' : t.status
}

/** The agent detail's status word, as in "Completed · 4.1k tokens · 7 tools · 9s". */
const HEADER: Record<string, string> = { running: 'Running', stopping: 'Stopping…', completed: 'Completed', failed: 'Failed', killed: 'Stopped' }

/** "9s", "1m 5s", "1h 2m", as the CLI formats a runtime. */
function duration(ms: number) {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

const tokens = (n: number) => `${n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : n} tokens`

/** Runtime · tool uses · tokens, the agent progress line's numbers. */
function stats(t: BgTask) {
  return [t.ms !== undefined ? duration(t.ms) : '', t.toolUses !== undefined ? plural(t.toolUses, 'tool') : '', t.tokens !== undefined ? tokens(t.tokens) : '']
    .filter(Boolean)
}

/** The row label: the shell command, the agent's description, `@teammate`. */
function label(t: BgTask) {
  return t.type === 'in_process_teammate' && t.subagent ? `@${t.subagent}` : t.description || t.id
}

/** The counts line under the title: "1 active shell · 1 active agent". */
function counts(tasks: BgTask[]) {
  const live = tasks.filter(isLive)
  const teammates = live.filter((t) => t.type === 'in_process_teammate').length
  const shells = live.filter((t) => t.type === 'local_bash').length
  const agents = live.filter((t) => t.type === 'local_agent' || t.type === 'remote_agent').length
  return [
    teammates ? plural(teammates, 'agent') : '',
    shells ? plural(shells, 'active shell') : '',
    agents ? plural(agents, 'active agent') : '',
  ].filter(Boolean).join(' · ')
}

/** Opens the Background dialog. */
export function tasksCommand(host: CommandHost, _args: string, _typed: string) {
  // Tasks whose stop is on its way: their row reads " · stopping…" until the session reports the new status.
  const stopping = new Set<string>()
  const find = (id: string) => host.tasks().find((t) => t.id === id)

  async function stop(t: BgTask): Promise<MenuResult> {
    if (!isLive(t) || stopping.has(t.id)) return
    stopping.add(t.id)
    void menu.refresh()
    try {
      await control(host.link, 'stopTask', t.id)
    } catch (e) {
      throw new Error(`Couldn't stop it: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      stopping.delete(t.id)
    }
    return 'refresh'
  }

  /** `x` stops the focused (or shown) running task; `f` (foreground) needs the terminal. */
  function keys(target: () => BgTask | undefined) {
    return (e: KeyboardEvent): MenuResult | boolean | Promise<MenuResult> => {
      if (e.ctrlKey || e.altKey || e.metaKey) return false
      if (e.key === 'x') {
        const t = target()
        return t && isLive(t) ? stop(t) : true
      }
      if (e.key === 'f') {
        host.toast('Foreground is terminal-only: the app runs Claude Code headless.')
        return true
      }
      return false
    }
  }

  function row(t: BgTask): MenuRow {
    const g = glyph(t)
    const meta = [word(t), ...(isAgent(t) ? stats(t) : t.ms !== undefined ? [duration(t.ms)] : [])].join(' · ')
    const hint = t.summary ?? (t.lastTool && isLive(t) ? `› ${t.lastTool}` : undefined)
    return { id: t.id, label: label(t) + (stopping.has(t.id) && isLive(t) ? ' · stopping…' : ''), icon: g.icon, tone: g.tone, meta, hint }
  }

  function listScreen(): MenuScreen {
    const tasks = host.tasks()
    const by = (key: string) => tasks.filter((t) => groupOf(t) === key)
    const agentish = ['agents', 'cloud-agents', 'local-agents', 'completed'].some((k) => by(k).length)
    const nonEmpty = GROUPS.filter((g) => by(g.key).length).length
    const groups: MenuGroup[] = GROUPS.map((g) => {
      const items = by(g.key)
      // As in the CLI: "Agents" is headed only beside other groups, "Shells" only beside agent groups.
      const headed = g.title && (g.key === 'agents' ? nonEmpty > 1 : g.key === 'shells' ? agentish : true)
      return { ...(headed ? { title: g.title, note: `(${items.length})` } : {}), rows: items.map(row) }
    }).filter((g) => g.rows.length)
    const focusId = () => (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.mrow')?.dataset.id
    return {
      title: 'Background',
      subtitle: counts(tasks) || undefined,
      groups,
      empty: 'No tasks currently running',
      notes: tasks.length ? ['x to stop · f (foreground) is terminal-only and not available in the app'] : [],
      pick: (r) => {
        const t = find(r.id)
        return t && detailScreen(t)
      },
      key: keys(() => {
        const id = focusId()
        return id ? find(id) : undefined
      }),
      reload: async () => listScreen(),
    }
  }

  function detailScreen(t: BgTask): MenuScreen {
    const g = glyph(t)
    const live = isLive(t)
    const status = live ? (stopping.has(t.id) ? 'stopping…' : 'running') : word(t)
    const body = t.type === 'local_bash'
      ? detailRows([
        ['Command:', t.description],
        ['Status:', `${g.icon} ${status}`],
        ['Runtime:', t.ms !== undefined ? duration(t.ms) : undefined],
        ['Output:', 'The output reaches the transcript when it finishes; a per-task view isn\'t sent to the app.'],
      ])
      : detailRows([
        // The CLI's agent header: "Completed · 4.1k tokens · 7 tools · 9s".
        ['Status:', [`${g.icon} ${HEADER[live ? (stopping.has(t.id) ? 'stopping' : 'running') : t.status] ?? status}`, ...(isAgent(t) ? [t.tokens !== undefined ? tokens(t.tokens) : '', t.toolUses !== undefined ? plural(t.toolUses, 'tool') : '', t.ms !== undefined ? duration(t.ms) : ''] : [])].filter(Boolean).join(' · ')],
        ['Type:', t.subagent ? `${t.subagent} (${t.type})` : t.type],
        ['Prompt:', t.description],
        ['Progress:', [t.lastTool ? `› ${t.lastTool}` : '', t.summary ?? ''].filter(Boolean).join('  ') || undefined],
        ['Error:', t.error],
        ['Task id:', t.id],
      ])
    const rows: MenuRow[] = [
      ...(live ? [{ id: 'stop', label: stopping.has(t.id) ? 'Stopping…' : 'Stop', danger: true, disabled: stopping.has(t.id) }] : []),
      { id: 'back', label: 'Back' },
    ]
    return {
      title: label(t),
      subtitle: t.type === 'local_bash' ? 'Shell details' : t.subagent ?? 'Agent details',
      body,
      groups: [{ rows }],
      notes: ['x to stop · f (foreground) is terminal-only and not available in the app'],
      async pick(r): Promise<MenuResult> {
        if (r.id === 'back') return 'back'
        if (r.id === 'stop') return stop(find(t.id) ?? t)
      },
      key: keys(() => find(t.id) ?? t),
      reload: async () => detailScreen(find(t.id) ?? t),
    }
  }

  const menu = openMenu(host, 'tasks', listScreen(), 'Background')
  const off = host.onTasks(() => void menu.refresh())
  void menu.closed.then(off)
}
