import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { claudeExecutable } from './auth.ts'

// The files behind the CLI's settings panels, for the app's versions of /permissions, /hooks, /skills, /memory and
// /plugin. The SDK has no writer for most of them (updateSettings only takes outputStyle and effortLevel), so the
// app edits them the way the CLI's own panels do: one key at a time, keeping everything else in the file.

export type SettingsSource = 'user' | 'project' | 'local'

export type SettingsFile = { source: SettingsSource; path: string; exists: boolean; json: Record<string, unknown>; error?: string }

/** One change to a settings file: `path` is the key path (["permissions", "allow"]). */
export type SettingsEdit =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'delete'; path: string[] }
  /** Adds `value` to the array at `path` unless it is already there. */
  | { op: 'append'; path: string[]; value: unknown }
  /** Removes `value` from the array at `path`. */
  | { op: 'remove'; path: string[]; value: unknown }

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')

export function settingsPath(source: SettingsSource, cwd: string) {
  if (source === 'user') return join(claudeDir(), 'settings.json')
  return join(cwd, '.claude', source === 'project' ? 'settings.json' : 'settings.local.json')
}

async function readSettings(source: SettingsSource, cwd: string): Promise<SettingsFile> {
  const path = settingsPath(source, cwd)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { source, path, exists: false, json: {} }
  }
  try {
    const json = JSON.parse(text) as unknown
    return { source, path, exists: true, json: json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {} }
  } catch (e) {
    return { source, path, exists: true, json: {}, error: `Not valid JSON: ${(e as Error).message}` }
  }
}

/** The user, project and local settings files for `cwd`, parsed. A missing file reads as `{}`. */
export function settingsFiles(cwd: string) {
  return Promise.all((['user', 'project', 'local'] as const).map((s) => readSettings(s, cwd)))
}

/** Applies `edits` to one settings file and writes it atomically. Refuses a file that isn't valid JSON. */
export async function editSettings(source: SettingsSource, cwd: string, edits: SettingsEdit[]) {
  const file = await readSettings(source, cwd)
  if (file.error) throw new Error(`${file.path}: ${file.error}. Fix it by hand first.`)
  const json = file.json
  for (const e of edits) applyEdit(json, e)
  await mkdir(dirname(file.path), { recursive: true })
  const tmp = `${file.path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
  await rename(tmp, file.path)
  return readSettings(source, cwd)
}

function applyEdit(root: Record<string, unknown>, e: SettingsEdit) {
  if (!e.path.length) throw new Error('An edit needs a key path')
  const keys = e.path.slice(0, -1)
  const last = e.path.at(-1)!
  let node = root
  for (const k of keys) {
    const next = node[k]
    if (next && typeof next === 'object' && !Array.isArray(next)) node = next as Record<string, unknown>
    else if (e.op === 'delete' || e.op === 'remove') return
    else node = node[k] = {}
  }
  if (e.op === 'set') node[last] = e.value
  else if (e.op === 'delete') delete node[last]
  else {
    const list = Array.isArray(node[last]) ? (node[last] as unknown[]) : []
    const same = (x: unknown) => JSON.stringify(x) === JSON.stringify(e.value)
    if (e.op === 'append') node[last] = list.some(same) ? list : [...list, e.value]
    else {
      node[last] = list.filter((x) => !same(x))
      if (!(node[last] as unknown[]).length) delete node[last]
    }
  }
}

/** CLI subcommands the panels may run: `claude plugin …` (no SDK control exists for plugins) and `claude mcp list|get`. */
const CLI_ALLOWED: string[][] = [['plugin'], ['mcp', 'list'], ['mcp', 'get'], ['agents']]
const CLI_TIMEOUT_MS = 120_000

/**
 * Runs `claude <args>` hidden in `cwd` and resolves with its output and exit code: /plugin's install, enable,
 * marketplace and list --json. Only CLI_ALLOWED subcommands run.
 */
export function cliExec(args: string[], cwd: string, claudePath?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  if (!args.every((a) => typeof a === 'string') || !CLI_ALLOWED.some((p) => p.every((x, i) => args[i] === x))) {
    return Promise.reject(new Error(`claude ${args.join(' ')} can't be run from the app`))
  }
  return new Promise((done) => {
    execFile(claudeExecutable(claudePath), args, { cwd, timeout: CLI_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : 1) : 0
      done({ code, stdout, stderr: stderr || (err && !stdout ? err.message : '') })
    })
  })
}

const TEXT_LIMIT = 2 * 1024 * 1024

/** Whether `path` is inside `dir` (or is it). */
function inside(path: string, dir: string) {
  const rel = relative(resolve(dir), resolve(path))
  // Another drive comes back absolute; a parent comes back as "..".
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/**
 * Reads a text file for a panel (CLAUDE.md, a hook script, ~/.claude/stats-cache.json): only inside the session
 * folder, the Claude config folder, or ~/.claude.json. Resolves `undefined` for a missing file.
 */
export async function readText(path: string, cwd: string): Promise<string | undefined> {
  const full = resolve(cwd, path.replace(/^~(?=[\\/]|$)/, homedir()))
  const ok = inside(full, cwd) || inside(full, claudeDir()) || full === join(homedir(), '.claude.json')
  if (!ok) throw new Error(`${path} is outside this project and the Claude config folder`)
  try {
    const text = await readFile(full, 'utf8')
    return text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) : text
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
}

/** The file and CLI controls (CTL_OPS) a session answers without the SDK, or `undefined` for an SDK control. */
export function fileControl(op: string, args: unknown[], cwd: string, claudePath?: string): Promise<unknown> | undefined {
  const source = (v: unknown): SettingsSource => {
    if (v === 'user' || v === 'project' || v === 'local') return v
    throw new Error(`Unknown settings source ${String(v)}`)
  }
  switch (op) {
    case 'settingsFiles':
      return settingsFiles(cwd)
    case 'editSettings':
      return editSettings(source(args[0]), cwd, (Array.isArray(args[1]) ? args[1] : []) as SettingsEdit[])
    case 'cliExec':
      return cliExec((Array.isArray(args[0]) ? args[0] : []) as string[], cwd, claudePath)
    case 'readText':
      return readText(String(args[0]), cwd)
  }
  return undefined
}
