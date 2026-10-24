import type { Ctx } from '../../contracts'
import { control } from '../control'
import type { MenuHost } from '../menu'
import { contextCommand } from './context'
import { hooksCommand } from './hooks'
import { mcpCommand } from './mcp'
import { memoryCommand } from './memory'
import { modelCommand } from './model'
import { permissionsCommand } from './permissions'
import { pluginCommand } from './plugin'
import { settingsCommand } from './settings-panel'
import { skillsCommand } from './skills'

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
  { name: 'costume', aliases: ['outfit'], hint: '', describe: (w) => `Change ${w}'s outfit` },
  { name: 'help', aliases: [], hint: '', describe: () => 'Commands and keyboard shortcuts' },
  { name: 'exit', aliases: ['quit'], hint: '', describe: () => 'Back to the title screen' },
  { name: 'login', aliases: [], hint: '', describe: () => 'Log in to Claude Code (opens a console window)' },
]

export const findAppCommand = (name: string) => APP_COMMANDS.find((c) => c.name === name || c.aliases.includes(name))

/** The silent-CLI helper a CommandHost's `cli` uses. */
export const runCli = (link: Ctx['link'], text: string) => control<string>(link, 'cli', text)
