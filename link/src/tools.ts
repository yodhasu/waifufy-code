import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Diff } from './protocol.ts'

/** Tool input and output shown in the detail view are cut here, with a note saying how much is missing (R19). */
export const MAX_TOOL_TEXT = 20_000
/** A file larger than this is not read for a diff; the edit is shown without file context. */
const MAX_DIFF_FILE = 200 * 1024
/** Unchanged lines shown around an edit. */
const DIFF_CONTEXT_LINES = 3
/** One-line details are cut here; the full input is in the detail view. */
const MAX_DETAIL = 200

/** Terminal color and cursor codes, stripped from command output. Global: use it with replace(), not test(). */
export const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

/** Commands that lose work or history. Tested against the command only, never its description. */
const DESTRUCTIVE = new RegExp(
  [
    String.raw`\bgit\s+reset\s+--hard`,
    String.raw`\bgit\s+push\b.*(--force\b|--force-with-lease|\s-f\b|\s\+\S)`,
    String.raw`\bgit\s+clean\s+-\w*f`,
    String.raw`\bgit\s+branch\s+-D\b`,
    String.raw`\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)`,
    String.raw`\bgit\s+stash\s+(drop|clear)\b`,
    String.raw`\bgit\s+filter-(branch|repo)\b`,
    String.raw`\brm\s+(-\w*r\w*f|-\w*f\w*r|-r\s+-f|-f\s+-r|--recursive)`,
    String.raw`\bRemove-Item\b.*-Recurse`,
    String.raw`\b(rd|rmdir)\s+/s\b`,
    String.raw`\bdel\s+/[sq]\b`,
    String.raw`\bformat\s+[a-z]:`,
    String.raw`\bmkfs\b`,
    String.raw`\bdd\s+.*\bof=`,
    String.raw`\b(drop\s+(table|database|schema)|truncate\s+table)\b`,
    String.raw`\bchmod\s+-R\s+777\b`,
  ].join('|'),
  'i',
)

export function isDestructive(name: string, input: Record<string, unknown>) {
  return (name === 'Bash' || name === 'PowerShell') && DESTRUCTIVE.test(str(input.command))
}

export function str(v: unknown) {
  return typeof v === 'string' ? v : ''
}

/** `mcp__claude_ai_Slack__slack_send_message` → `claude_ai_Slack · slack_send_message`. Built-in names stay as they are. */
export function toolLabel(name: string) {
  return name.startsWith('mcp__') ? name.slice(5).split('__').join(' · ') : name
}

/** Cuts `text` at `max` characters with a note, so the reader knows it is not the whole thing. */
export function clip(text: string, max = MAX_TOOL_TEXT) {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… (truncated: ${(text.length - max).toLocaleString('en-US')} more characters)`
}

function oneLine(text: string, max = MAX_DETAIL) {
  const lines = text.trim().split(/\r?\n/)
  const first = lines[0] + (lines.length > 1 ? ' …' : '')
  return first.length > max ? `${first.slice(0, max - 1)}…` : first
}

/** A path inside the session folder is shown relative to it, like the CLI does. */
export function displayPath(path: string, cwd?: string) {
  if (!path || !cwd) return path
  const rel = relative(cwd, path)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replaceAll('\\', '/') : path
}

/** A one-line description of a tool call for the ribbon, the actions log and permission prompts. */
export function describeTool(name: string, input: Record<string, unknown>, cwd?: string): string {
  const path = (p: unknown) => displayPath(str(p), cwd)
  switch (name) {
    case 'Bash':
    case 'PowerShell':
    case 'Monitor':
      return oneLine(str(input.command) || str(input.description))
    case 'Read': {
      const from = typeof input.offset === 'number' ? input.offset : undefined
      const count = typeof input.limit === 'number' ? input.limit : undefined
      const range = from !== undefined || count !== undefined ? `:${from ?? 1}${count ? `-${(from ?? 1) + count - 1}` : ''}` : ''
      return `${path(input.file_path)}${range}${input.pages ? ` (pages ${str(input.pages)})` : ''}`
    }
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return path(input.file_path)
    case 'NotebookEdit':
      return `${path(input.notebook_path)}${input.cell_id ? ` #${str(input.cell_id)}` : ''}`
    case 'Grep': {
      const where = str(input.glob) || (input.path ? path(input.path) : '')
      return oneLine(`${str(input.pattern)}${where ? ` in ${where}` : ''}`)
    }
    case 'Glob':
      return oneLine(`${str(input.pattern)}${input.path ? ` in ${path(input.path)}` : ''}`)
    case 'WebFetch':
      return oneLine(str(input.url))
    case 'WebSearch':
    case 'ToolSearch':
      return oneLine(str(input.query))
    case 'Skill':
      return oneLine(str(input.skill) || str(input.command))
    case 'Agent':
    case 'Task':
      return oneLine(str(input.description) || str(input.subagent_type))
    case 'TodoWrite':
      return `${Array.isArray(input.todos) ? input.todos.length : 0} quests`
    case 'TaskCreate':
      return oneLine(str(input.subject))
    case 'TaskUpdate': {
      const change = str(input.status) || str(input.subject) || str(input.activeForm)
      return oneLine(`#${str(input.taskId)}${change ? ` → ${change}` : ''}`)
    }
    case 'TaskGet':
    case 'TaskStop':
      return `#${str(input.taskId) || str(input.task_id) || str(input.shell_id)}`
    case 'TaskList':
      return 'quest log'
    case 'AskUserQuestion': {
      const qs = Array.isArray(input.questions) ? (input.questions as { question?: unknown }[]) : []
      return oneLine(str(qs[0]?.question) + (qs.length > 1 ? ` (+${qs.length - 1})` : ''))
    }
    case 'ExitPlanMode':
      return input.planFilePath ? path(input.planFilePath) : 'plan'
  }
  const first = Object.values(input).find((v) => typeof v === 'string' && v.trim())
  return typeof first === 'string' ? oneLine(first) : ''
}

/** Tool input as the detail view shows it: pretty JSON, truncated. */
export function prettyInput(input: unknown) {
  let json: string
  try {
    json = JSON.stringify(input, null, 2) ?? ''
  } catch {
    json = String(input)
  }
  return clip(json)
}

/**
 * The text of a tool result: the tool_result content the model saw, or, when that is empty,
 * the structured `tool_use_result` the SDK attaches.
 */
export function toolOutput(content: unknown, structured?: unknown) {
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    text = content
      .map((b: { type?: string; text?: string }) => (b?.type === 'text' ? (b.text ?? '') : b?.type ? `[${b.type}]` : ''))
      .filter(Boolean)
      .join('\n')
  }
  if (!text.trim() && structured !== undefined && structured !== null) {
    text = typeof structured === 'string' ? structured : prettyInput(structured)
  }
  return clip(text)
}

// ---------------------------------------------------------------- diffs for permission prompts (R20)

/** Unix line endings: the model's old_string uses \n even in a CRLF file, and the Edit tool matches it there. */
const lf = (text: string) => text.replace(/\r\n/g, '\n')

async function readSmall(path: string): Promise<string | undefined> {
  try {
    const s = await stat(path)
    if (!s.isFile() || s.size > MAX_DIFF_FILE) return undefined
    return lf(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length - 1

/**
 * The lines around one replacement, before and after, so the diff shows where the edit lands.
 * Falls back to the bare strings when `old` is not in the file (or no file was read).
 */
function editHunk(file: string | undefined, old: string, next: string, all: boolean) {
  const at = file && old ? file.indexOf(old) : -1
  if (!file || at === -1) return { before: old, after: next, file }
  const last = all ? file.lastIndexOf(old) : at
  const lines = file.split('\n')
  const from = Math.max(0, lineOf(file, at) - DIFF_CONTEXT_LINES)
  const to = Math.min(lines.length, lineOf(file, last + old.length) + 1 + DIFF_CONTEXT_LINES)
  const before = lines.slice(from, to).join('\n')
  const after = all ? before.split(old).join(next) : before.replace(old, () => next)
  const edited = all ? file.split(old).join(next) : file.slice(0, at) + next + file.slice(at + old.length)
  return { before, after, file: edited }
}

type NotebookCell = { id?: string; source?: string | string[] }

function cellSource(notebook: string | undefined, cellId: string) {
  if (!notebook || !cellId) return ''
  try {
    const cells = (JSON.parse(notebook) as { cells?: NotebookCell[] }).cells ?? []
    const cell = cells.find((c) => c.id === cellId) ?? cells[Number(cellId.replace(/^cell-/, ''))]
    return Array.isArray(cell?.source) ? cell.source.join('') : (cell?.source ?? '')
  } catch {
    return ''
  }
}

/** Before/after text for Edit, MultiEdit, Write and NotebookEdit prompts. Other tools get none. */
export async function buildDiffs(name: string, input: Record<string, unknown>, cwd: string): Promise<Diff[]> {
  const rawPath = str(input.file_path) || str(input.notebook_path)
  if (!rawPath) return []
  const abs = resolve(cwd, rawPath)
  const path = displayPath(abs, cwd)
  switch (name) {
    case 'Edit': {
      const file = await readSmall(abs)
      const h = editHunk(file, lf(str(input.old_string)), lf(str(input.new_string)), input.replace_all === true)
      return [{ path, before: h.before, after: h.after }]
    }
    case 'MultiEdit': {
      let file = await readSmall(abs)
      const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : []
      return edits.map((e) => {
        // Each edit applies to the result of the previous one, as the tool does.
        const h = editHunk(file, lf(str(e.old_string)), lf(str(e.new_string)), e.replace_all === true)
        file = h.file
        return { path, before: h.before, after: h.after }
      })
    }
    case 'Write':
      return [{ path, before: (await readSmall(abs)) ?? '', after: clip(lf(str(input.content)), MAX_DIFF_FILE) }]
    case 'NotebookEdit': {
      const mode = str(input.edit_mode) || 'replace'
      const before = mode === 'insert' ? '' : cellSource(await readSmall(abs), str(input.cell_id))
      return [{ path, before, after: mode === 'delete' ? '' : str(input.new_source) }]
    }
  }
  return []
}
