import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { DATA_DIR } from './settings.ts'

// Workspace trust, as the terminal's "Quick safety check" dialog decides it. Through the SDK the CLI runs
// non-interactively and treats every folder as trusted, so a cloned repo's hooks, MCP servers and permission
// rules would apply without asking. The app asks first, like the terminal does (R3, R24).
//
// A folder is trusted when it, or a parent up to its git root, was trusted in the terminal (the CLI's
// `projects[<dir>].hasTrustDialogAccepted`, read only: the CLI owns that file) or accepted in this app.

const FILE = join(DATA_DIR, 'trust.json')
/** Shown in the dialog: what the folder's project settings would apply without asking. */
const MAX_CONCERNS = 6

type TrustFile = { version: 1; folders: string[] }

const isWindows = process.platform === 'win32'
/** The CLI keys folders as `C:/Users/…`; Windows paths compare without case. */
const key = (p: string) => {
  const s = resolve(p).replaceAll('\\', '/').replace(/\/+$/, '')
  return isWindows ? s.toLowerCase() : s
}

/** The CLI's global config: `~/.claude.json`, or `.claude.json` in CLAUDE_CONFIG_DIR. */
function cliConfigFile() {
  return join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json')
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function cliTrusted(): Set<string> {
  const projects = (readJson(cliConfigFile()) as { projects?: Record<string, { hasTrustDialogAccepted?: unknown }> } | undefined)?.projects
  const out = new Set<string>()
  for (const [dir, p] of Object.entries(projects ?? {})) if (p?.hasTrustDialogAccepted === true) out.add(key(dir))
  return out
}

function appTrusted(): Set<string> {
  const folders = (readJson(FILE) as Partial<TrustFile> | undefined)?.folders
  return new Set(Array.isArray(folders) ? folders.filter((f) => typeof f === 'string').map(key) : [])
}

/** Folders trusted with everything under them, for the E2E suite (WC_TRUST_FOLDERS, separated like PATH). */
function envTrusted(): string[] {
  return (process.env.WC_TRUST_FOLDERS ?? '').split(delimiter).filter(Boolean).map(key)
}

function gitRoot(dir: string): string | undefined {
  for (let d = dir; ; ) {
    if (existsSync(join(d, '.git'))) return d
    const up = dirname(d)
    if (up === d) return undefined
    d = up
  }
}

/** True when `cwd` or a parent up to its git root (or the drive root outside a repo) is in `trusted`. */
function covered(cwd: string, trusted: Set<string>) {
  const start = resolve(cwd)
  const root = gitRoot(start)
  for (let d = start; ; ) {
    if (trusted.has(key(d))) return true
    if (root !== undefined && d === root) return false
    const up = dirname(d)
    if (up === d) return false
    d = up
  }
}

export function isTrusted(cwd: string) {
  if (process.env.CLAUDE_CODE_SANDBOXED) return true
  const k = key(cwd)
  if (envTrusted().some((t) => k === t || k.startsWith(`${t}/`))) return true
  return covered(cwd, cliTrusted()) || covered(cwd, appTrusted())
}

/** Records that the user accepted the trust dialog for `cwd`. Atomic, like the other app files. */
export async function acceptTrust(cwd: string) {
  const current = (readJson(FILE) as Partial<TrustFile> | undefined)?.folders
  const folders = Array.isArray(current) ? current.filter((f) => typeof f === 'string') : []
  if (folders.some((f) => key(f) === key(cwd))) return
  await mkdir(DATA_DIR, { recursive: true })
  const tmp = `${FILE}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify({ version: 1, folders: [...folders, resolve(cwd)] } satisfies TrustFile, null, 2) + '\n')
  await rename(tmp, FILE)
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** What the folder's own settings would apply without asking once trusted, in the CLI dialog's spirit. */
export async function trustConcerns(cwd: string): Promise<string[]> {
  const read = async (file: string) => {
    try {
      return JSON.parse(await readFile(join(cwd, file), 'utf8')) as Record<string, unknown>
    } catch {
      return undefined
    }
  }
  const [shared, local, mcp] = await Promise.all([read('.claude/settings.json'), read('.claude/settings.local.json'), read('.mcp.json')])
  const out: string[] = []
  for (const s of [shared, local]) {
    if (!s) continue
    const hooks = s.hooks && typeof s.hooks === 'object' ? Object.keys(s.hooks) : []
    if (hooks.length) out.push(`runs hooks on ${hooks.join(', ')}`)
    const allow = (s.permissions as { allow?: unknown } | undefined)?.allow
    if (Array.isArray(allow) && allow.length) out.push(`pre-approves ${count(allow.length, 'tool permission')}`)
    const env = s.env && typeof s.env === 'object' ? Object.keys(s.env) : []
    if (env.length) out.push(`sets ${count(env.length, 'environment variable')}`)
    for (const helper of ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper']) {
      if (typeof s[helper] === 'string') out.push(`runs a helper command (${helper})`)
    }
  }
  const servers = mcp?.mcpServers && typeof mcp.mcpServers === 'object' ? Object.keys(mcp.mcpServers) : []
  if (servers.length) out.push(`declares ${count(servers.length, 'MCP server')} (${servers.slice(0, 3).join(', ')})`)
  return [...new Set(out)].slice(0, MAX_CONCERNS)
}
