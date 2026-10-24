import { esc } from '../../ui'
import { control } from '../control'
import { detailRows, openMenu, type MenuRow, type MenuScreen } from '../menu'
import type { CommandHost } from './index'

// /hooks, the CLI 2.1.309's read-only viewer (docs/research/cli-extensions.md §4): every configured hook grouped by
// event, then an "All events" drill-down (event → matcher → hook → detail). Hooks come from the `hooks` key of the
// user, project and local settings files. Plugin, session and built-in hooks live inside the running CLI, which
// has no control that lists them, so the panel says so instead of guessing.

type SettingsFile = { source: 'user' | 'project' | 'local'; path: string; exists: boolean; json: Record<string, unknown>; error?: string }

type HookConfig = {
  type: string
  command?: string
  args?: string[]
  prompt?: string
  url?: string
  server?: string
  tool?: string
  file?: string
  script?: string
  statusMessage?: string
}

type Source = 'localSettings' | 'projectSettings' | 'userSettings'
type Hook = { event: string; config: HookConfig; matcher: string; source: Source; file: string }

/** The CLI's hook events (`_At`), in its order, with its summaries and descriptions. `matcher`: the event takes one. */
const EVENTS: { event: string; summary: string; matcher?: true; description: string }[] = [
  { event: "PreToolUse", summary: "Before tool execution", matcher: true,
    description: "Input to command is JSON of tool call arguments.\nExit code 0 - stdout/stderr not shown\nExit code 2 - show stderr to model and block tool call\nOther exit codes - show stderr to user only but continue with tool call" },
  { event: "PostToolUse", summary: "After tool execution", matcher: true,
    description: "Input to command is JSON with fields \"inputs\" (tool call arguments) and \"response\" (tool call response).\nExit code 0 - stdout shown in transcript mode (ctrl+o)\nExit code 2 - show stderr to model immediately\nOther exit codes - show stderr to user only" },
  { event: "PostToolUseFailure", summary: "After tool execution fails", matcher: true,
    description: "Input to command is JSON with tool_name, tool_input, tool_use_id, error, error_type, is_interrupt, and is_timeout.\nExit code 0 - stdout shown in transcript mode (ctrl+o)\nExit code 2 - show stderr to model immediately\nOther exit codes - show stderr to user only" },
  { event: "PostToolBatch", summary: "After a batch of tool calls resolves",
    description: "Fires once after every tool call in a batch has resolved, before the next model request. Input includes tool_calls (array of {tool_name, tool_input, tool_use_id, tool_response}).\nReturn additionalContext via hookSpecificOutput to inject context once for the whole batch.\nExit code 2 - stop the agentic loop (stderr shown to user only)\nOther exit codes - show stderr to user only" },
  { event: "PermissionDenied", summary: "After auto mode classifier denies a tool call", matcher: true,
    description: "Input to command is JSON with tool_name, tool_input, tool_use_id, and reason.\nReturn {\"hookSpecificOutput\":{\"hookEventName\":\"PermissionDenied\",\"retry\":true}} to tell the model it may retry.\nExit code 0 - stdout shown in transcript mode (ctrl+o)\nOther exit codes - show stderr to user only" },
  { event: "Notification", summary: "When notifications are sent", matcher: true,
    description: "Input to command is JSON with notification message and type.\nExit code 0 - stdout/stderr not shown\nOther exit codes - show stderr to user only" },
  { event: "UserPromptSubmit", summary: "When the user submits a prompt",
    description: "Input to command is JSON with original user prompt text.\nExit code 0 - stdout shown to Claude\nExit code 2 - block processing, erase original prompt, and show stderr to user only\nOther exit codes - show stderr to user only" },
  { event: "UserPromptExpansion", summary: "When a user-typed slash command expands into a prompt", matcher: true,
    description: "Input to command is JSON with expansion_type, command_name, command_args, command_source, and original prompt.\nExit code 0 - stdout shown to Claude\nExit code 2 - block expansion and show stderr to user only\nOther exit codes - show stderr to user only" },
  { event: "SessionStart", summary: "When a new session is started", matcher: true,
    description: "Input to command is JSON with session start source.\nExit code 0 - stdout shown to Claude\nExit code 2 - show stderr to user only\nOther exit codes - show stderr to user only" },
  { event: "Stop", summary: "Right before Claude concludes its response",
    description: "Exit code 0 - stdout/stderr not shown\nExit code 2 - show stderr to model and continue conversation\nOther exit codes - show stderr to user only" },
  { event: "StopFailure", summary: "When the turn ends due to an API error", matcher: true,
    description: "Fires instead of Stop when an API error (rate limit, auth failure, etc.) ended the turn. Fire-and-forget — hook output and exit codes are ignored." },
  { event: "SubagentStart", summary: "When a subagent (Agent tool call) is started", matcher: true,
    description: "Input to command is JSON with agent_id and agent_type.\nExit code 0 - JSON additionalContext shown to subagent\nExit code 2 - show stderr to user only\nOther exit codes - show stderr to user only" },
  { event: "SubagentStop", summary: "Right before a subagent (Agent tool call) concludes its response", matcher: true,
    description: "Input to command is JSON with agent_id, agent_type, and agent_transcript_path.\nExit code 0 - stdout/stderr not shown\nExit code 2 - show stderr to subagent and continue having it run\nOther exit codes - show stderr to user only" },
  { event: "PreCompact", summary: "Before conversation compaction", matcher: true,
    description: "Input to command is JSON with compaction details.\nExit code 0 - stdout appended as custom compact instructions\nExit code 2 - block compaction\nOther exit codes - show stderr to user only but continue with compaction" },
  { event: "PostCompact", summary: "After conversation compaction", matcher: true,
    description: "Input to command is JSON with compaction details and the summary.\nExit code 0 - stdout shown to user\nOther exit codes - show stderr to user only" },
  { event: "PreModelSwitch", summary: "Before a requested model switch (/model, model picker, set_model)", matcher: true,
    description: "Input to command is JSON with from_model, to_model, requested_model, source, context_tokens and the estimated re-cache cost.\nExit code 0 - switch proceeds; JSON permissionDecision allow/deny/ask as for PreToolUse\nExit code 2 - block the switch and show stderr to user\nOther exit codes - show stderr to user only and continue" },
  { event: "PostModelSwitch", summary: "After the session model changes (any cause)", matcher: true,
    description: "Input to command is JSON with from_model, to_model, requested_model, source, context_tokens and the estimated re-cache cost.\nExit code 0 - stdout shown to Claude on the next request\nOther exit codes - show stderr to user only" },
  { event: "SessionEnd", summary: "When a session is ending", matcher: true,
    description: "Input to command is JSON with session end reason.\nExit code 0 - command completes successfully\nOther exit codes - show stderr to user only" },
  { event: "PermissionRequest", summary: "When a permission dialog is displayed", matcher: true,
    description: "Input to command is JSON with tool_name, tool_input, and tool_use_id.\nOutput JSON with hookSpecificOutput containing decision to allow or deny.\nExit code 0 - use hook decision if provided\nOther exit codes - show stderr to user only" },
  { event: "Setup", summary: "Repo setup hooks for init and maintenance", matcher: true,
    description: "Input to command is JSON with trigger (init or maintenance).\nExit code 0 - JSON additionalContext shown to Claude\nExit code 2 - show stderr to user only\nOther exit codes - show stderr to user only" },
  { event: "TeammateIdle", summary: "When a teammate is about to go idle",
    description: "Input to command is JSON with teammate_name and team_name.\nExit code 0 - stdout/stderr not shown\nExit code 2 - show stderr to teammate and prevent idle (teammate continues working)\nOther exit codes - show stderr to user only" },
  { event: "TaskCreated", summary: "When a task is being created",
    description: "Input to command is JSON with task_id, task_subject, task_description, teammate_name, and team_name.\nExit code 0 - stdout/stderr not shown\nExit code 2 - show stderr to model and prevent task creation\nOther exit codes - show stderr to user only" },
  { event: "TaskCompleted", summary: "When a task is being marked as completed",
    description: "Input to command is JSON with task_id, task_subject, task_description, teammate_name, and team_name.\nExit code 0 - stdout/stderr not shown\nExit code 2 - show stderr to model and prevent task completion\nOther exit codes - show stderr to user only" },
  { event: "Elicitation", summary: "When an MCP server requests user input (elicitation)", matcher: true,
    description: "Input to command is JSON with mcp_server_name, message, and requested_schema.\nOutput JSON with hookSpecificOutput containing action (accept/decline/cancel) and optional content.\nExit code 0 - use hook response if provided\nExit code 2 - deny the elicitation\nOther exit codes - show stderr to user only" },
  { event: "ElicitationResult", summary: "After a user responds to an MCP elicitation", matcher: true,
    description: "Input to command is JSON with mcp_server_name, action, content, mode, and elicitation_id.\nOutput JSON with hookSpecificOutput containing optional action and content to override the response.\nExit code 0 - use hook response if provided\nExit code 2 - block the response (action becomes decline)\nOther exit codes - show stderr to user only" },
  { event: "ConfigChange", summary: "When configuration files change during a session", matcher: true,
    description: "Input to command is JSON with source (user_settings, project_settings, local_settings, policy_settings, skills) and file_path.\nExit code 0 - allow the change\nExit code 2 - block the change from being applied to the session\nOther exit codes - show stderr to user only" },
  { event: "InstructionsLoaded", summary: "When an instruction file (CLAUDE.md or rule) is loaded", matcher: true,
    description: "Input to command is JSON with file_path, memory_type (User, Project, Local, Managed), load_reason (session_start, nested_traversal, path_glob_match, include, compact), globs (optional — the paths: frontmatter patterns that matched), trigger_file_path (optional — the file Claude touched that caused the load), and parent_file_path (optional — the file that @-included this one).\nExit code 0 - command completes successfully\nOther exit codes - show stderr to user only\nThis hook is observability-only and does not support blocking." },
  { event: "WorktreeCreate", summary: "Create an isolated worktree for VCS-agnostic isolation",
    description: "Input to command is JSON with name (suggested worktree slug).\nStdout should contain the absolute path to the created worktree directory.\nExit code 0 - worktree created successfully\nOther exit codes - worktree creation failed" },
  { event: "WorktreeRemove", summary: "Remove a previously created worktree",
    description: "Input to command is JSON with worktree_path (absolute path to worktree).\nExit code 0 - worktree removed successfully\nOther exit codes - show stderr to user only" },
  { event: "CwdChanged", summary: "After the working directory changes",
    description: "Input to command is JSON with old_cwd and new_cwd.\nCLAUDE_ENV_FILE is set — write bash exports there to apply env to subsequent BashTool commands.\nHook output can include hookSpecificOutput.watchPaths (array of absolute paths) to register with the FileChanged watcher.\nExit code 0 - command completes successfully\nOther exit codes - show stderr to user only" },
  { event: "FileChanged", summary: "When a watched file changes",
    description: "Input to command is JSON with file_path and event (change, add, unlink).\nCLAUDE_ENV_FILE is set — write bash exports there to apply env to subsequent BashTool commands.\nThe matcher field specifies filenames to watch in the current directory (e.g. \".envrc|.env\").\nHook output can include hookSpecificOutput.watchPaths (array of absolute paths) to dynamically update the watch list.\nExit code 0 - command completes successfully\nOther exit codes - show stderr to user only" },
  { event: "DirectoryAdded", summary: "After a working directory is added mid-session", matcher: true,
    description: "Fires after /add-dir or the register_repo_root SDK control request registers a new working directory, after the sandbox configuration has been refreshed — so sandboxed tools and permission state already see the new directory (hook commands themselves run unsandboxed).\nInput to command is JSON with directory (absolute path) and source (\"slash_command\" or \"register_repo_root\").\nExit code 0 - command completes successfully\nOther exit codes - stderr is debug-logged on both paths; for /add-dir, a failure count is summarized to Claude and hook systemMessage output reaches Claude as bounded context; for register_repo_root, everything is debug-logged only" },
  { event: "MessageDisplay", summary: "While assistant message text is displayed",
    description: "Input to command is JSON with turn_id, message_id, index, final, and delta (the newly completed lines).\nOutput JSON with hookSpecificOutput containing displayContent to replace the delta on screen.\nDisplay-only: the stored message and what the model sees are untouched.\nExit code 0 - use hook response if provided\nOther exit codes - display the original delta" },
]

type EventMeta = (typeof EVENTS)[number]

const SOURCES: Record<Source, { description: string; header: string; inline: string }> = {
  userSettings: { description: 'User settings (~/.claude/settings.json)', header: 'User Settings', inline: 'User' },
  projectSettings: { description: 'Project settings (.claude/settings.json)', header: 'Project Settings', inline: 'Project' },
  localSettings: { description: 'Local settings (.claude/settings.local.json)', header: 'Local Settings', inline: 'Local' },
}
/** The CLI's matcher order: local, then project, then user (plugin and built-in hooks would come last). */
const RANK: Record<Source, number> = { localSettings: 0, projectSettings: 1, userSettings: 2 }
const FILE_SOURCE: Record<SettingsFile['source'], Source> = { user: 'userSettings', project: 'projectSettings', local: 'localSettings' }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const NOT_LISTED = "Plugin, session and built-in hooks aren't listed: the app can only read the settings files. Run /hooks in a terminal to see them."
const READ_ONLY = 'This menu is read-only. To add or change a hook, edit settings.json or ask Claude. Learn more: https://code.claude.com/docs/en/hooks'
const ADD_HINT = 'To add hooks, edit settings.json directly or ask Claude'

/** What a hook runs, as the CLI prints it (`nI`). */
function what(c: HookConfig) {
  switch (c.type) {
    case 'command':
      return c.args?.length ? [c.command, ...c.args].join(' ') : c.command ?? ''
    case 'prompt':
    case 'agent':
      return c.prompt ?? ''
    case 'http':
      return c.url ?? ''
    case 'mcp_tool':
      return `${c.server ?? ''}/${c.tool ?? ''}`
    case 'script':
      return c.file ?? (c.script ?? '').split('\n')[0]
    default:
      return String(c.type)
  }
}

/** The detail screen's title and value label per hook type (`wn`, `Hn`). */
const KIND: Record<string, [title: string, label: string]> = {
  command: ['Command hook', 'Command'],
  prompt: ['Prompt hook', 'Prompt'],
  agent: ['Agent hook', 'Prompt'],
  http: ['HTTP hook', 'URL'],
  mcp_tool: ['MCP tool hook', 'MCP tool'],
  script: ['Script hook', 'Script'],
}

/** Every hook in the settings files, in the CLI's read order (user, project, local). Unknown events are skipped, as there. */
function collect(files: SettingsFile[]) {
  const hooks: Hook[] = []
  for (const f of files) {
    const byEvent = f.json.hooks
    if (!byEvent || typeof byEvent !== 'object') continue
    for (const [event, groups] of Object.entries(byEvent as Record<string, unknown>)) {
      const meta = EVENTS.find((e) => e.event === event)
      if (!meta || !Array.isArray(groups)) continue
      for (const g of groups as { matcher?: string; hooks?: HookConfig[] }[]) {
        for (const config of Array.isArray(g?.hooks) ? g.hooks : []) {
          if (config && typeof config === 'object') {
            hooks.push({ event, config, matcher: meta.matcher ? g.matcher ?? '' : '', source: FILE_SOURCE[f.source], file: f.path })
          }
        }
      }
    }
  }
  return hooks
}

/** An event's matchers in the CLI's order (`SUs`): by the best-ranked source among their hooks, then by name. */
function matchersOf(hooks: Hook[], event: string) {
  const mine = hooks.filter((h) => h.event === event)
  const rank = (m: string) => Math.min(...mine.filter((h) => h.matcher === m).map((h) => RANK[h.source]))
  return [...new Set(mine.map((h) => h.matcher))]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((m) => {
      const list = mine.filter((h) => h.matcher === m)
      return { matcher: m, hooks: list, sources: [...new Set(list.map((h) => SOURCES[h.source].inline))] }
    })
}

/** Opens /hooks. */
export function hooksCommand(host: CommandHost, _args: string, _typed: string) {
  const load = () => control<SettingsFile[]>(host.link, 'settingsFiles')
  openMenu(host, 'hooks', load().then((files) => listScreen(host, files, load)), 'Hooks')
}

/** The CLI's banners: hooks switched off, plus a settings file the app couldn't parse. */
function banners(files: SettingsFile[]) {
  const html: string[] = []
  if (files.some((f) => f.json.disableAllHooks === true)) {
    html.push('<p class="mhook-banner warn">⚠ While hooks are disabled no hook command runs, the status line isn\'t shown, and tools run '
      + 'without hook checks. To turn hooks back on, remove "disableAllHooks" from settings.json or ask Claude.</p>')
  }
  for (const f of files.filter((x) => x.error)) html.push(`<p class="mhook-banner bad">✘ ${esc(f.path)}: ${esc(f.error!)}</p>`)
  return html.join('')
}

function listScreen(host: CommandHost, files: SettingsFile[], load: () => Promise<SettingsFile[]>): MenuScreen {
  const hooks = collect(files)
  const events = EVENTS.map((e) => ({ meta: e, hooks: matchersOf(hooks, e.event).flatMap((m) => m.hooks) })).filter((e) => e.hooks.length)
  const order = events.flatMap((e) => e.hooks)
  const groups = events.map((e) => ({
    title: e.meta.event,
    // The CLI lowercases the summary's first letter after the bold event name.
    note: e.meta.summary.replace(/^\p{Lu}(?=\p{Ll}|\s)/u, (c) => c.toLowerCase()),
    rows: e.hooks.map((h): MenuRow => ({
      id: `hook-${order.indexOf(h)}`,
      label: `[${SOURCES[h.source].inline}] ${what(h.config)}`,
      meta: [h.matcher, h.config.type].filter(Boolean).join(' · '),
    })),
  }))
  return {
    title: 'Hooks',
    subtitle: order.length ? `${plural(order.length, 'hook')} on ${plural(events.length, 'event')}` : 'no hooks yet',
    body: `${banners(files)}<p class="mhook-note">${esc(READ_ONLY)}</p>`,
    groups: [...groups, { rows: [{ id: 'events', label: 'All events', tone: 'accent' }] }],
    notes: [NOT_LISTED],
    reload: async () => listScreen(host, await load(), load),
    pick(row) {
      if (row.id === 'events') return eventsScreen(host, hooks)
      const h = order[Number(row.id.slice('hook-'.length))]
      return h && detailScreen(host, h)
    },
  }
}

function eventsScreen(host: CommandHost, hooks: Hook[]): MenuScreen {
  const count = (event: string) => hooks.filter((h) => h.event === event).length
  return {
    title: 'Hook events',
    subtitle: `${plural(EVENTS.length, 'event')} · ${EVENTS.filter((e) => count(e.event)).length} with hooks`,
    groups: [{ rows: EVENTS.map((e) => ({ id: e.event, label: e.event, meta: count(e.event) ? plural(count(e.event), 'hook') : '', hint: e.summary })) }],
    search: true,
    pick(row) {
      const meta = EVENTS.find((e) => e.event === row.id)
      if (meta) return meta.matcher ? matchersScreen(host, hooks, meta) : hooksScreen(host, hooks, meta, '')
    },
  }
}

const descBody = (meta: EventMeta) => `<p class="mhook-desc">${esc(meta.description)}</p>`

function matchersScreen(host: CommandHost, hooks: Hook[], meta: EventMeta): MenuScreen {
  const matchers = matchersOf(hooks, meta.event)
  return {
    title: `${meta.event} - Matchers`,
    subtitle: meta.summary,
    body: descBody(meta),
    groups: [{
      rows: matchers.map((m) => ({ id: `m:${m.matcher}`, label: `[${m.sources.join(', ')}] ${m.matcher || '(all)'}`, meta: plural(m.hooks.length, 'hook') })),
    }],
    empty: 'No hooks configured for this event',
    notes: matchers.length ? [] : [ADD_HINT],
    pick: (row) => hooksScreen(host, hooks, meta, row.id.slice(2)),
  }
}

function hooksScreen(host: CommandHost, hooks: Hook[], meta: EventMeta, matcher: string): MenuScreen {
  const list = hooks.filter((h) => h.event === meta.event && h.matcher === matcher).sort((a, b) => RANK[a.source] - RANK[b.source])
  return {
    title: meta.matcher ? `${meta.event} - Matcher: ${matcher || '(all)'}` : meta.event,
    subtitle: meta.summary,
    body: descBody(meta),
    groups: [{ rows: list.map((h, i) => ({ id: `h:${i}`, label: h.config.statusMessage || what(h.config), meta: h.config.type, hint: SOURCES[h.source].header })) }],
    empty: 'No hooks configured for this event',
    notes: list.length ? [] : [ADD_HINT],
    pick(row) {
      const h = list[Number(row.id.slice(2))]
      return h && detailScreen(host, h)
    },
  }
}

/** A settings file as the detail footer names it: relative to the project, or the full path for user settings. */
function fileName(host: CommandHost, h: Hook) {
  const cwd = host.cwd()
  return h.source !== 'userSettings' && h.file.toLowerCase().startsWith(cwd.toLowerCase()) ? `.${h.file.slice(cwd.length)}` : h.file
}

function detailScreen(host: CommandHost, h: Hook): MenuScreen {
  const meta = EVENTS.find((e) => e.event === h.event)!
  const [title, label] = KIND[h.config.type] ?? [`${h.config.type} hook`, 'Hook']
  const isFile = h.config.type === 'script' && h.config.file !== undefined
  return {
    title,
    subtitle: meta.matcher ? `${h.event} · ${h.matcher || 'matches everything'}` : h.event,
    body: detailRows([
      ['Source:', SOURCES[h.source].description],
      ['Status message:', h.config.statusMessage],
      [`${isFile ? 'Script file' : label}:`, h.config.type === 'script' ? h.config.file ?? h.config.script ?? '' : what(h.config)],
    ]) + `<p class="mhook-note">${esc(`To change or remove this hook, edit ${fileName(host, h)} or ask Claude.`)}</p>`,
    groups: [],
    empty: ' ',
  }
}
