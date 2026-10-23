// `npm run build:installer`: stages the sidecar, builds the app with the bundle resources from
// tauri.installer.conf.json, and copies the NSIS setup.exe to build/Waifufy-Code-<version>-setup.exe.
// Extra arguments go to `tauri build` (e.g. `-- --verbose`).
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const MB = 1024 * 1024
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP = join(ROOT, 'app')
const TAURI = join(APP, 'src-tauri')
// The CLI's own entry script, run with this Node so the arguments reach it as given, with no shell quoting.
const TAURI_CLI = join(APP, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
const NSIS_OUT = join(TAURI, 'target', 'release', 'bundle', 'nsis')
const tauriArgs = process.argv.slice(2)

function fail(message) {
  console.error(`build-installer: ${message}`)
  process.exit(1)
}

if (!existsSync(TAURI_CLI)) fail(`${relative(ROOT, TAURI_CLI)} is missing; run \`npm run setup\` first`)

execFileSync(process.execPath, [join(ROOT, 'scripts', 'stage-sidecar.mjs')], { stdio: 'inherit' })

const startedAt = Date.now()
try {
  execFileSync(process.execPath, [TAURI_CLI, 'build', '--config', join(TAURI, 'tauri.installer.conf.json'), ...tauriArgs], {
    cwd: APP,
    stdio: 'inherit',
  })
} catch {
  fail('tauri build failed (its output is above)')
}

const { version } = JSON.parse(readFileSync(join(TAURI, 'tauri.conf.json'), 'utf8'))
const setup = (existsSync(NSIS_OUT) ? readdirSync(NSIS_OUT) : [])
  .filter((name) => name.endsWith('-setup.exe') && name.includes(`_${version}_`))
  .map((name) => join(NSIS_OUT, name))
  .find((path) => statSync(path).mtimeMs >= startedAt)
if (!setup) fail(`tauri build finished but no new ${version} setup.exe is in ${relative(ROOT, NSIS_OUT)}`)
const target = join(ROOT, 'build', `Waifufy-Code-${version}-setup.exe`)
copyFileSync(setup, target)
console.log(`build-installer: ${relative(ROOT, target)} (${(statSync(target).size / MB).toFixed(1)} MB)`)
