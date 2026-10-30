// Builds both installers for the current version and puts them on a GitHub DRAFT release, so they can be
// checked before anyone sees them. Publishing stays a manual step (the release page, or `gh release edit --draft=false`).
//
//   node scripts/release-draft.mjs              build the Windows setup + Android APK, push the branch, draft the release
//   node scripts/release-draft.mjs --no-build   reuse what is already in build/ (only push and upload)
//
// Needs everything build-installer.mjs and build-android.mjs need, plus the GitHub CLI signed in (`gh auth login`).
// Running it again replaces the draft's assets (the release stays a draft).

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const { version } = JSON.parse(readFileSync(join(ROOT, 'app', 'src-tauri', 'tauri.conf.json'), 'utf8'))
const tag = `v${version}`
const build = !process.argv.includes('--no-build')

const run = (cmd) => {
  console.log(`\n> ${cmd}`)
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' })
}
const out = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim()

if (build) {
  run('npm run build:installer')
  run('node scripts/build-android.mjs')
}

const setup = join(ROOT, 'build', `Waifufy-Code-${version}-setup.exe`)
const apk = [`-arm64.apk`, `-arm64-unsigned.apk`].map((s) => join(ROOT, 'build', 'android', `Waifufy-Code-${version}${s}`)).find(existsSync)
if (!existsSync(setup)) throw new Error(`missing ${setup}`)
if (!apk) throw new Error(`missing build/android/Waifufy-Code-${version}-arm64.apk`)

const branch = out('git rev-parse --abbrev-ref HEAD')
run(`git push origin ${branch}`)

const notes = join(tmpdir(), `waifufy-${tag}-notes.md`)
writeFileSync(
  notes,
  `Waifufy Code ${version}: her in 3D on the phone

A patch for 0.8.1: 3D cards now load in the Android app.

**On the phone**
- The phone gets her model with textures scaled to 1024 pixels (Reine's: 68 MB → 12 MB, and about a tenth of the GPU memory), converted once on the computer and cached. The computer keeps the full textures
- The phone draws her lighter: no self-shadows, no antialiasing, a capped pixel density
- If the phone still can't hold her, she falls back to her Live2D costume, a toast says why, and the reason is written to the computer's \`link.log\`

Install: \`Waifufy-Code-${version}-setup.exe\` on Windows, the \`.apk\` on Android (arm64).
`,
)

const assets = `"${setup}" "${apk}"`
let draft = ''
try {
  draft = out(`gh release view ${tag} --json isDraft -q .isDraft`)
} catch {}
if (draft === 'false') throw new Error(`${tag} is already published; not touching it`)
if (draft === 'true') {
  run(`gh release upload ${tag} ${assets} --clobber`)
  // Otherwise an older draft keeps its old title and notes.
  run(`gh release edit ${tag} --title "Waifufy Code ${version}" --notes-file "${notes}"`)
} else {
  run(`gh release create ${tag} ${assets} --draft --target ${branch} --title "Waifufy Code ${version}" --notes-file "${notes}"`)
}
console.log(`\nDraft release ${tag} is ready (not published): ${out(`gh release view ${tag} --json url -q .url`)}`)
