import { execFile, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import type { Auth } from './protocol.ts'

// Claude Code login state. The SDK has no login API, so this asks the CLI itself (`claude auth …`).
// Credentials live in ~/.claude, shared with the terminal CLI: a user signed in there is signed in here.

const STATUS_TIMEOUT_MS = 10_000
const LOGIN_POLL_MS = 3_000
const LOGIN_WATCH_MS = 5 * 60_000
const LOGIN_WINDOW_TITLE = 'Claude Code login'

/** `claudePath`, or the binary the SDK ships in its platform package. */
export function claudeExecutable(claudePath?: string): string {
  if (claudePath) return claudePath
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
  try {
    return createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${exe}`)
  } catch {
    return exe
  }
}

type StatusJson = { loggedIn?: boolean; email?: string; subscriptionType?: string; authMethod?: string }

/** Runs `claude auth status --json`. Never throws: failures come back as `{ loggedIn: false, error }`. */
function status(claudePath?: string): Promise<Auth> {
  const exe = claudeExecutable(claudePath)
  return new Promise((done) => {
    execFile(exe, ['auth', 'status', '--json'], { timeout: STATUS_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      // A logged-out CLI exits non-zero but still prints the JSON.
      try {
        const s = JSON.parse(stdout) as StatusJson
        return done({ loggedIn: s.loggedIn === true, email: s.email, subscription: s.subscriptionType, method: s.authMethod })
      } catch {
        const code = (err as NodeJS.ErrnoException | null)?.code
        const error =
          code === 'ENOENT'
            ? `Claude Code was not found at ${exe}.`
            : err?.killed
              ? 'Claude Code did not answer in time.'
              : (stderr.trim() || err?.message || 'Claude Code returned no login status.').split('\n')[0]
        done({ loggedIn: false, error })
      }
    })
  })
}

const same = (a: Auth | undefined, b: Auth) => JSON.stringify(a) === JSON.stringify(b)

/** Cached login status with change notifications, and the login flow. */
export function createAuth(claudePath: string | undefined, onChange: (a: Auth) => void) {
  let cached: Auth | undefined
  let inFlight: Promise<Auth> | undefined
  let watch: ReturnType<typeof setInterval> | undefined

  const refresh = () => {
    inFlight ??= status(claudePath).then((a) => {
      inFlight = undefined
      const changed = !same(cached, a)
      cached = a
      if (changed) onChange(a)
      return a
    })
    return inFlight
  }

  return {
    /** The cached status (refreshed in the background), or the first check's result. */
    get(): Promise<Auth> {
      if (!cached) return refresh()
      void refresh()
      return Promise.resolve(cached)
    },
    refresh,
    /** Opens `claude auth login` in its own console window, then watches until the login lands. */
    login() {
      const exe = claudeExecutable(claudePath)
      const child =
        process.platform === 'win32'
          ? // `start` gives the CLI a visible console even though this process runs without one. `|| pause`
            // keeps the window open when the login fails, so its reason can be read.
            spawn('cmd.exe', ['/c', 'start', `"${LOGIN_WINDOW_TITLE}"`, 'cmd.exe', '/c', `""${exe}" auth login || pause"`], {
              detached: true,
              stdio: 'ignore',
              windowsVerbatimArguments: true,
            })
          : spawn(exe, ['auth', 'login'], { detached: true, stdio: 'ignore' })
      child.on('error', (e) => console.error(`[auth] could not open the login window: ${e.message}`))
      child.unref()

      clearInterval(watch)
      const before = cached
      const until = Date.now() + LOGIN_WATCH_MS
      // Done once a (different) account is signed in; switching accounts counts too.
      watch = setInterval(async () => {
        const a = await refresh()
        if ((a.loggedIn && !same(before, a)) || Date.now() > until) clearInterval(watch)
      }, LOGIN_POLL_MS)
    },
  }
}

/** Server names that can't break the cmd.exe line they are quoted into. */
const SAFE_NAME = /^[^"%^&|<>\r\n]+$/

/**
 * Opens `claude mcp login <name>` in its own console window, in `cwd` so project servers resolve: the CLI's
 * /mcp "Authenticate", which the SDK has no control for. The browser flow finishes there; the panel reconnects after.
 */
export function mcpLogin(name: string, cwd: string, claudePath?: string) {
  if (!SAFE_NAME.test(name)) throw new Error(`Can't authenticate a server named ${name} from here; run claude mcp login in a terminal`)
  const exe = claudeExecutable(claudePath)
  const child =
    process.platform === 'win32'
      ? spawn('cmd.exe', ['/c', 'start', `"MCP login: ${name}"`, 'cmd.exe', '/c', `""${exe}" mcp login "${name}" || pause"`], {
          cwd,
          detached: true,
          stdio: 'ignore',
          windowsVerbatimArguments: true,
        })
      : spawn(exe, ['mcp', 'login', name], { cwd, detached: true, stdio: 'ignore' })
  child.on('error', (e) => console.error(`[auth] could not open the MCP login window: ${e.message}`))
  child.unref()
}

/** Runs `claude mcp logout <name>` (the CLI's "Clear authentication"); resolves with its output, rejects with its error. */
export function mcpLogout(name: string, cwd: string, claudePath?: string): Promise<string> {
  return new Promise((done, fail) => {
    execFile(claudeExecutable(claudePath), ['mcp', 'logout', name], { cwd, timeout: STATUS_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return fail(new Error((stderr.trim() || stdout.trim() || err.message).split('\n')[0]))
      done(stdout.trim())
    })
  })
}
