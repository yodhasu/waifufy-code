import type { Ctx } from '../../contracts'
import { control } from '../control'
import type { MenuHost } from '../menu'
import { mcpCommand } from './mcp'

// The slash commands the app answers itself. They come first in the picker and replace SDK rows of the same
// name (or alias): in headless mode the CLI's interactive panels only answer "opens an interactive panel".
// A command with `run` lives in its own file in this folder; the others are handled in chat/index.ts.

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
  run?(host: CommandHost, args: string): void
}

export const APP_COMMANDS: AppCommand[] = [
  { name: 'model', aliases: [], hint: '[model]', describe: (w) => `Choose the model ${w} thinks with` },
  { name: 'clear', aliases: ['reset', 'new'], hint: '', describe: () => 'Fresh session in this folder (the old one stays in Load)' },
  { name: 'resume', aliases: [], hint: '', describe: () => 'Open the Save/Load page' },
  { name: 'config', aliases: ['settings', 'theme'], hint: '', describe: () => 'Open Settings' },
  { name: 'costume', aliases: ['outfit'], hint: '', describe: (w) => `Change ${w}'s outfit` },
  {
    name: 'mcp',
    aliases: [],
    hint: '[reconnect|enable|disable [<server>|all]]',
    describe: () => 'Manage MCP servers',
    run: (host, args) => mcpCommand(host, args),
  },
  { name: 'help', aliases: [], hint: '', describe: () => 'Commands and keyboard shortcuts' },
  { name: 'exit', aliases: ['quit'], hint: '', describe: () => 'Back to the title screen' },
  { name: 'login', aliases: [], hint: '', describe: () => 'Log in to Claude Code (opens a console window)' },
]

export const findAppCommand = (name: string) => APP_COMMANDS.find((c) => c.name === name || c.aliases.includes(name))

/** The silent-CLI helper a CommandHost's `cli` uses. */
export const runCli = (link: Ctx['link'], text: string) => control<string>(link, 'cli', text)
