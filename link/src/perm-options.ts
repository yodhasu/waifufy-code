import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { PermChoice } from './protocol.ts'
import { shortPath } from './saves.ts'

// The CLI 2.1.309's permission prompt wording (docs/research/cli-input.md §5.1): the question line per tool, and one
// "don't ask again" row per kind of suggestion (a rule in this project, a mode switch for this session, directory
// access) instead of one row that applies them all. Each row keeps the suggestions it applies.

export type PermOptions = { question: string; choices: (PermChoice & { updates?: PermissionUpdate[]; message?: string })[] }

const MODE_NAMES: Record<string, string> = {
  acceptEdits: 'Accept edits',
  plan: 'Plan mode',
  auto: 'Auto mode',
  bypassPermissions: 'Bypass permissions',
  default: 'Manual',
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit', 'Write'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

/** "npm run test:*" → "npm run test", the prefix the CLI names in its label. */
const prefixOf = (rule: string) => rule.replace(/(:\*|\s\*|\*)$/, '').trim()

function ruleWords(tool: string, rules: { toolName: string; ruleContent?: string }[]) {
  const contents = rules.map((r) => r.ruleContent ?? '')
  if (SHELL_TOOLS.has(tool)) {
    const words = contents.map((c) => (/(:\*|\s\*|\*)$/.test(c) ? `${prefixOf(c)} commands` : `\`${c}\``))
    return words.join(', ')
  }
  if (tool === 'WebFetch') return contents.map((c) => c.replace(/^domain:/, '')).join(', ')
  if (tool.startsWith('mcp__')) {
    const [, server, name] = tool.split('__')
    return `${server} - ${name ?? 'all tools'} commands`
  }
  if (tool === 'Skill') return contents.join(', ') || 'this skill'
  return rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)).join(', ')
}

const where = (destination: string, cwd: string) =>
  destination === 'userSettings' ? 'all your projects' : destination === 'projectSettings' ? `${shortPath(cwd)} (shared project settings)` : shortPath(cwd)

/** The question line under the prompt's title. */
function questionFor(tool: string, input: Record<string, unknown>, cwd: string, name: string) {
  const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
  if (tool === 'Write' && file) return existsSync(resolve(cwd, file)) ? `Do you want to overwrite ${basename(file)}?` : `Do you want to create ${basename(file)}?`
  if (EDIT_TOOLS.has(tool) && file) return `Do you want to make this edit to ${basename(file)}?`
  if (tool === 'WebFetch') return `Do you want to allow ${name} to fetch this content?`
  if (tool === 'EnterPlanMode') return 'Enter plan mode?'
  return 'Do you want to proceed?'
}

/**
 * The menu rows for a permission prompt, in the CLI's order: Yes, the "don't ask again" rows, then No. `name` is the
 * character's name, which stands in for "Claude" in the labels.
 */
export function permissionOptions(
  tool: string,
  input: Record<string, unknown>,
  suggestions: PermissionUpdate[] | undefined,
  canAlways: boolean,
  cwd: string,
  name: string,
): PermOptions {
  const question = questionFor(tool, input, cwd, name)
  const no = { id: 'deny', label: `No, and tell ${name} what to do differently (esc)`, decision: 'deny' as const }
  if (tool === 'EnterPlanMode') {
    return {
      question,
      choices: [
        { id: 'allow', label: 'Yes, enter plan mode', decision: 'allow' },
        { id: 'implement', label: 'No, start implementing now', decision: 'feedback', message: 'The user declined plan mode. Start implementing now.' },
      ],
    }
  }
  const rows: PermOptions['choices'] = [{ id: 'allow', label: 'Yes', decision: 'allow' }]
  const all = canAlways ? suggestions ?? [] : []
  // A mode switch for the session, with any session-only directory access that came with it.
  const modes = all.filter((u) => u.type === 'setMode')
  const sessionDirs = all.filter((u) => u.type === 'addDirectories' && (u.destination === 'session' || u.destination === 'cliArg'))
  for (const m of modes) {
    if (m.type !== 'setMode') continue
    rows.push({
      id: `mode-${rows.length}`,
      label: `Yes, and switch to ${MODE_NAMES[m.mode] ?? m.mode} for this session (shift+tab)`,
      decision: 'always',
      mode: true,
      updates: [m, ...sessionDirs],
    })
  }
  // Rules, by where they are saved; persistent directory access joins the rule row for the same place.
  const ruleSets = all.filter((u) => u.type === 'addRules' || u.type === 'replaceRules')
  const persistentDirs = all.filter((u) => u.type === 'addDirectories' && u.destination !== 'session' && u.destination !== 'cliArg')
  for (const r of ruleSets) {
    if (r.type !== 'addRules' && r.type !== 'replaceRules') continue
    const dirs = persistentDirs.filter((d) => d.destination === r.destination)
    const dirWords = dirs.flatMap((d) => (d.type === 'addDirectories' ? d.directories : [])).map(shortPath)
    const base = tool === 'WebFetch' ? `Yes, and don't ask again for ${ruleWords(tool, r.rules)}` : `Yes, and don't ask again for ${ruleWords(tool, r.rules)} in ${where(r.destination, cwd)}`
    rows.push({
      id: `rule-${rows.length}`,
      label: dirWords.length ? `${base} and always allow access to ${dirWords.join(', ')} from this project` : base,
      decision: 'always',
      updates: [r, ...dirs],
    })
  }
  // Directory access offered on its own (a read outside the workspace).
  const loneDirs = [...persistentDirs.filter((d) => !ruleSets.some((r) => r.destination === d.destination)), ...(modes.length ? [] : sessionDirs)]
  for (const d of loneDirs) {
    if (d.type !== 'addDirectories') continue
    const dirs = d.directories.map(shortPath).join(', ')
    rows.push({
      id: `dirs-${rows.length}`,
      label: d.destination === 'session' || d.destination === 'cliArg' ? `Yes, allow reading from ${dirs} during this session` : `Yes, and always allow access to ${dirs} from this project`,
      decision: 'always',
      updates: [d],
    })
  }
  rows.push(no)
  return { question, choices: rows }
}
