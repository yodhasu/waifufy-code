import type { BgTask, Command } from '../../../../link/src/protocol.ts'
import type { ToolRecord } from '../panels'
import type { Ctx } from '../../contracts'
import { control } from '../control'
import type { MenuHost } from '../menu'
import { contextCommand } from './context'
import { diffCommand } from './diff'
import { exportCommand } from './export'
import { hooksCommand } from './hooks'
import { mcpCommand } from './mcp'
import { memoryCommand } from './memory'
import { modelCommand } from './model'
import { permissionsCommand } from './permissions'
import { pluginCommand } from './plugin'
import { rewindCommand } from './rewind'
import { settingsCommand } from './settings-panel'
import { skillsCommand } from './skills'
import { tasksCommand } from './tasks'

// The slash commands the app answers itself. They come first in the picker and replace SDK rows of the same
// name (or alias): in headless mode the CLI's interactive panels only answer "opens an interactive panel".
// A command with `run` lives in its own file in this folder (docs/V0.5.md); the others are handled in chat/index.ts.
// Names, aliases, hints and descriptions are the CLI 2.1.309's own.

/** What a command panel can use from the chat screen. */
export type CommandHost = MenuHost & {
  ctx: Ctx
  link: Ctx['link']
  /** The session folder. */
  cwd(): string
  charName(): string
  /** Runs a CLI slash command silently (no turn shows) and resolves with its text output: `/config theme=dark`. */
  cli(text: string): Promise<string>
  /** The SDK session id (the save), once the CLI has one. */
  sessionId(): string | undefined
  /** The CLI's background tasks right now, and a watch for changes (returns its unsubscribe). */
  tasks(): BgTask[]
  onTasks(fn: (tasks: BgTask[]) => void): () => void
  /**
   * Rewinds the conversation: restarts this save cut after `resumeAt` (dropping `dropsTurn`'s turn), then puts
   * `draft` (the dropped prompt) back in the composer, as the CLI does. Restore code first, with rewindFiles.
   */
  rewind(o: { resumeAt?: string; dropsTurn?: string; draft?: string }): void
  /** Replaces the composer's text. */
  setDraft(text: string): void
  /** Runs a line as if typed and sent: a slash command (app or CLI), `!cmd`, or a message. */
  run(text: string): void
  /** The CLI's slash commands (skills, custom commands) from the session. */
  commands(): Command[]
  /** Every tool call this session so far, oldest first (input is pretty JSON; output once done). */
  toolRecords(): ToolRecord[]
  /** The backlog as text: who said what, oldest first (tool calls as "Tool detail"). */
  transcript(): { who: string; text: string }[]
  /** Her replies, newest first: /copy N. */
  replies(): string[]
  /** Copies to the clipboard; resolves true when it worked (a failure shows its own toast). */
  copy(text: string): Promise<boolean>
}

export type AppCommand = {
  name: string
  aliases: string[]
  hint: string
  describe(waifu: string): string
  /** `typed` is the name or alias as typed: /cost and /stats open the usage panel on their own tab. */
  run?(host: CommandHost, args: string, typed: string): void
}

export const APP_COMMANDS: AppCommand[] = [
  { name: 'model', aliases: [], hint: '[model]', describe: () => 'Set the AI model for Claude Code', run: modelCommand },
  { name: 'effort', aliases: [], hint: '[low|medium|high|xhigh|max|auto]', describe: () => 'Set effort level for model usage', run: modelCommand },
  { name: 'fast', aliases: [], hint: '[on|off]', describe: () => 'Toggle fast mode', run: modelCommand },
  { name: 'clear', aliases: ['reset', 'new'], hint: '', describe: () => 'Fresh session in this folder (the old one stays in Load)' },
  { name: 'resume', aliases: [], hint: '', describe: () => 'Open the Save/Load page' },
  { name: 'config', aliases: ['settings'], hint: '[key=value]', describe: () => 'Open settings', run: settingsCommand },
  { name: 'status', aliases: [], hint: '', describe: () => 'Show Claude Code status including version, model, account, API connectivity, and tool statuses', run: settingsCommand },
  { name: 'usage', aliases: ['cost', 'stats'], hint: '', describe: () => 'Show session cost, plan usage, and activity stats', run: settingsCommand },
  { name: 'theme', aliases: [], hint: '', describe: () => 'Change the theme (light, dark, accent)' },
  { name: 'focus', aliases: [], hint: '[on|off]', describe: () => 'Toggle focus view: just your prompt, summary, and response' },
  { name: 'permissions', aliases: ['allowed-tools'], hint: '', describe: () => 'Manage allow and deny tool permission rules', run: permissionsCommand },
  { name: 'add-dir', aliases: [], hint: '<path>', describe: () => 'Add a new working directory', run: permissionsCommand },
  { name: 'context', aliases: [], hint: '[all]', describe: () => 'Visualize current context usage as a colored grid', run: contextCommand },
  {
    name: 'mcp',
    aliases: [],
    hint: '[reconnect|enable|disable [<server>|all]]',
    describe: () => 'Manage MCP servers',
    run: (host, args) => mcpCommand(host, args),
  },
  { name: 'plugin', aliases: ['plugins', 'marketplace'], hint: '', describe: () => 'Manage Claude Code plugins', run: pluginCommand },
  { name: 'skills', aliases: [], hint: '', describe: () => 'List available skills', run: skillsCommand },
  { name: 'hooks', aliases: [], hint: '', describe: () => 'View hook configurations for tool events', run: hooksCommand },
  { name: 'memory', aliases: [], hint: '', describe: () => 'Edit CLAUDE.md files and memory settings', run: memoryCommand },
  { name: 'rewind', aliases: ['checkpoint', 'undo'], hint: '', describe: () => 'Restore the code and/or conversation to a previous point', run: rewindCommand },
  { name: 'tasks', aliases: ['bashes'], hint: '', describe: () => 'View and manage everything running in the background', run: tasksCommand },
  { name: 'diff', aliases: [], hint: '', describe: () => 'View uncommitted changes and what each turn changed', run: diffCommand },
  { name: 'export', aliases: [], hint: '[filename]', describe: () => 'Export the current conversation to a file or clipboard', run: exportCommand },
  { name: 'copy', aliases: [], hint: '[N]', describe: (w) => `Copy ${w}'s last response to clipboard (or /copy N for the Nth-latest)`, run: exportCommand },
  { name: 'costume', aliases: ['outfit'], hint: '', describe: (w) => `Change ${w}'s outfit` },
  { name: 'help', aliases: [], hint: '', describe: () => 'Commands and keyboard shortcuts' },
  { name: 'exit', aliases: ['quit'], hint: '', describe: () => 'Back to the title screen' },
  { name: 'login', aliases: [], hint: '', describe: () => 'Log in to Claude Code (opens a console window)' },
]

export const findAppCommand = (name: string) => APP_COMMANDS.find((c) => c.name === name || c.aliases.includes(name))

/** The silent-CLI helper a CommandHost's `cli` uses. */
export const runCli = (link: Ctx['link'], text: string) => control<string>(link, 'cli', text)
