// Stages what the installer ships next to the app (bundle.resources in app/src-tauri/tauri.installer.conf.json):
//   build/sidecar/node/node.exe       the Node that runs this script (24+, for .ts type stripping)
//   build/sidecar/link/{src,package.json,package-lock.json,node_modules}
// node_modules comes from `npm ci --omit=dev`, which brings the runtime deps and the SDK's win32-x64 claude.exe.
// Safe to run again: src is replaced, and npm ci is skipped when the last one that finished used the same lockfile.
// `--clean` forces a fresh install.
import { execSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIN_NODE_MAJOR = 24
const MB = 1024 * 1024
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LINK = join(ROOT, 'link')
const OUT = join(ROOT, 'build', 'sidecar')
const OUT_NODE = join(OUT, 'node')
const OUT_LINK = join(OUT, 'link')
const CLAUDE_EXE = join(OUT_LINK, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe')
const LOCKFILE = 'package-lock.json'
// The lockfile of the last npm ci that completed. It sits outside the staged tree so the installer does not ship it,
// and an install cut short (Ctrl+C, a network drop) leaves it stale, so the next run installs again.
const INSTALLED_LOCK = join(ROOT, 'build', 'sidecar-installed.lock.json')
const clean = process.argv.includes('--clean')

function fail(message) {
  console.error(`stage-sidecar: ${message}`)
  process.exit(1)
}

/** Total bytes under a path. */
function size(path) {
  if (!existsSync(path)) return 0
  const s = statSync(path)
  if (!s.isDirectory()) return s.size
  return readdirSync(path).reduce((sum, name) => sum + size(join(path, name)), 0)
}

const mb = (bytes) => `${(bytes / MB).toFixed(1)} MB`.padStart(10)

if (process.platform !== 'win32' || process.arch !== 'x64') {
  fail(`the installer is Windows x64 only (this is ${process.platform}-${process.arch})`)
}
const major = Number(process.versions.node.split('.')[0])
if (major < MIN_NODE_MAJOR) {
  fail(`Node ${MIN_NODE_MAJOR}+ is required to run the link's .ts sources, but ${process.execPath} is v${process.versions.node}`)
}

// Node: the binary itself, plus its license since it is redistributed.
mkdirSync(OUT_NODE, { recursive: true })
copyFileSync(process.execPath, join(OUT_NODE, 'node.exe'))
const nodeLicense = join(dirname(process.execPath), 'LICENSE')
if (existsSync(nodeLicense)) copyFileSync(nodeLicense, join(OUT_NODE, 'LICENSE'))

// The link sources, replaced whole so files deleted from link/src do not linger.
rmSync(join(OUT_LINK, 'src'), { recursive: true, force: true })
cpSync(join(LINK, 'src'), join(OUT_LINK, 'src'), { recursive: true })
copyFileSync(join(LINK, 'package.json'), join(OUT_LINK, 'package.json'))

const lock = readFileSync(join(LINK, LOCKFILE))
copyFileSync(join(LINK, LOCKFILE), join(OUT_LINK, LOCKFILE))
const installed = existsSync(INSTALLED_LOCK) && lock.equals(readFileSync(INSTALLED_LOCK))
if (clean || !installed || !existsSync(CLAUDE_EXE)) {
  console.log('stage-sidecar: npm ci --omit=dev in build/sidecar/link')
  rmSync(INSTALLED_LOCK, { force: true })
  // npm is a .cmd shim on Windows, so it has to start through a shell.
  execSync('npm ci --omit=dev --no-audit --no-fund', { cwd: OUT_LINK, stdio: 'inherit' })
  writeFileSync(INSTALLED_LOCK, lock)
} else {
  console.log('stage-sidecar: lockfile unchanged, keeping node_modules (pass --clean to reinstall)')
}
if (!existsSync(CLAUDE_EXE)) {
  fail(`npm ci did not install ${relative(ROOT, CLAUDE_EXE)}; is @anthropic-ai/claude-agent-sdk-win32-x64 in the lockfile?`)
}

const claude = size(CLAUDE_EXE)
const modules = size(join(OUT_LINK, 'node_modules'))
console.log(`stage-sidecar: staged ${relative(ROOT, OUT)} with Node v${process.versions.node}`)
console.log(`${mb(size(OUT_NODE))}  node/`)
console.log(`${mb(size(join(OUT_LINK, 'src')))}  link/src/`)
console.log(`${mb(claude)}  link/node_modules/…/claude.exe`)
console.log(`${mb(modules - claude)}  link/node_modules/ (everything else)`)
console.log(`${mb(size(OUT))}  total`)
