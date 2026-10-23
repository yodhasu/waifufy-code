import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { ANSI } from './tools.ts'

/** `!cmd` runs at most this long, like the CLI's default Bash timeout. */
const TIMEOUT_MS = 120_000
const MS_PER_S = 1000
/** Output kept per stream; the rest is dropped with a note. */
const MAX_OUTPUT = 30_000
/** After the shell exits, output still in the pipes gets this long to arrive. */
const EXIT_GRACE_MS = 250

export type ShellRun = {
  /** stdout and stderr interleaved as they arrived, for the app. */
  output: string
  stdout: string
  stderr: string
  /** Exit code; null when the command was killed (timeout, Esc) or could not start. */
  code: number | null
}

type Shell = { file: string; args: (command: string) => string[] }

const isWindows = process.platform === 'win32'

/**
 * The environment for the CLI and for `!cmd`: the sidecar's own, minus the link's WebSocket credentials,
 * which a `printenv` would otherwise put in the transcript.
 */
export function childEnv(): NodeJS.ProcessEnv {
  const { WC_TOKEN: _token, WC_PORT: _port, ...env } = process.env
  return env
}

/** Git Bash, the shell the CLI's own Bash tool uses on Windows. WSL's bash.exe in System32 is not it. */
function gitBash(): string | undefined {
  const candidates = [
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
    ...[process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]
      .filter((d): d is string => !!d)
      .map((d) => join(d, 'Git', 'bin', 'bash.exe')),
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .filter((d) => d && !/\\(system32|windowsapps)\\?$/i.test(d))
      .map((d) => join(d, 'bash.exe')),
  ]
  return candidates.find((p): p is string => !!p && existsSync(p))
}

/**
 * PowerShell's -Command exits 0 or 1 whatever a native program returned, and prints errors as multi-line
 * records. This keeps the program's own exit code and prints errors on one line. Piped output otherwise
 * uses the OEM code page, which garbles anything outside ASCII.
 */
const powershellScript = (command: string) =>
  [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    "$ErrorView = 'CategoryView'",
    '$global:LASTEXITCODE = 0',
    command,
    '$__ok = $?',
    'exit $(if ($LASTEXITCODE) { $LASTEXITCODE } elseif ($__ok) { 0 } else { 1 })',
  ].join('\n')

let cached: Shell | undefined

function pickShell(): Shell {
  if (cached) return cached
  const bash = isWindows ? gitBash() : process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/bash'
  cached = bash
    ? { file: bash, args: (c) => ['-c', c] }
    : { file: 'powershell.exe', args: (c) => ['-NoProfile', '-NonInteractive', '-Command', powershellScript(c)] }
  return cached
}

/** Collects one stream up to the cap, remembering how much was dropped. */
class Capped {
  text = ''
  dropped = 0

  add(s: string) {
    const room = MAX_OUTPUT - this.text.length
    this.text += s.slice(0, room)
    this.dropped += Math.max(0, s.length - room)
  }

  /** The text without terminal colors, which tools forcing color (npm, FORCE_COLOR) would leave as garbage. */
  done() {
    const text = this.text.replace(/\r\n/g, '\n').replace(ANSI, '')
    return this.dropped ? `${text}\n… (output truncated: ${this.dropped.toLocaleString('en-US')} more characters)` : text
  }
}

function killTree(pid: number | undefined) {
  if (pid === undefined) return
  // The shell's children (npm, node, …) would outlive a plain kill on Windows.
  if (isWindows) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
  else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

/**
 * Runs `command` in `cwd` with no stdin, so a command that waits for input gets EOF instead of hanging.
 * Aborting `signal` (Esc, the session closing) kills the whole process tree, as the CLI does in bash mode.
 */
export function runShell(command: string, cwd: string, signal?: AbortSignal): Promise<ShellRun> {
  const shell = pickShell()
  return new Promise((done) => {
    const out = new Capped()
    const err = new Capped()
    const all = new Capped()
    let timedOut = false
    if (signal?.aborted) return done({ output: 'Interrupted', stdout: '', stderr: 'Interrupted', code: null })
    let child: ReturnType<typeof spawn>
    try {
      const options = { cwd, env: childEnv(), windowsHide: true, detached: !isWindows }
      child = spawn(shell.file, shell.args(command), { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return done({ output: message, stdout: '', stderr: message, code: null })
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
      finish(null)
    }, TIMEOUT_MS)
    const onAbort = () => {
      killTree(child.pid)
      finish(null, '\nInterrupted')
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.setEncoding('utf8').on('data', (s: string) => (out.add(s), all.add(s)))
    child.stderr?.setEncoding('utf8').on('data', (s: string) => (err.add(s), all.add(s)))
    let finished = false
    const finish = (code: number | null, failure?: string) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (failure) (err.add(failure), all.add(failure))
      if (timedOut) {
        const note = `\nCommand timed out after ${TIMEOUT_MS / MS_PER_S}s`
        err.add(note)
        all.add(note)
      }
      child.stdout?.destroy()
      child.stderr?.destroy()
      done({ output: all.done(), stdout: out.done(), stderr: err.done(), code: timedOut || failure ? null : code })
    }
    child.on('error', (e) => finish(null, e.message))
    // A background job (`cmd &`) keeps the pipes open after the shell exits, so don't wait for them to close.
    child.on('exit', (code) => setTimeout(() => finish(code), EXIT_GRACE_MS))
    child.on('close', (code) => finish(code))
  })
}

/**
 * What the CLI's bash mode appends to the transcript: a caveat that the command was the user's own,
 * the input, then the output. Sent with shouldQuery:false, so it becomes context for the next prompt.
 */
export function bashModeMessages(command: string, run: ShellRun): string[] {
  return [
    "<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user. It's recorded here as context for later messages.</local-command-caveat>",
    `<bash-input>${command}</bash-input>`,
    `<bash-stdout>${run.stdout.trimEnd()}</bash-stdout><bash-stderr>${run.stderr.trimEnd()}</bash-stderr>`,
  ]
}
