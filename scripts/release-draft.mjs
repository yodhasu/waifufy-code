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
  `Waifufy Code ${version}: pose her yourself, and a smoother phone

**The pose studio** (Settings → Appearance → Motions → Pose her, desktop)
- Every emotion of a 3D card can have a motion of yours: drag her hands, elbows, head and body into place (her arms stay out of her body), or click a joint for rotation rings and sliders
- Fingers from a grid, hand shapes, mirror, undo/redo, up to 30 keys on the way into the pose, ▶ to play it
- The camera turns all the way round her (◀ ▶, Front, Side, Back)
- Every change saves itself on her card, and "✓ Saved" says so
- **Open in Blender**: edit the motion in Blender with MMD Tools; each Ctrl+S comes straight back onto her card

**On the phone**
- She runs at 60 fps for less CPU than 30 fps cost before; when a phone can't keep up she rests at 30 for a while so it cools
- Pinch to zoom her; headpats and taps finally work on a touch screen
- Sideways fills the screen; the app can't be zoomed like a web page any more; Settings, the title and Save/Load fit sideways
- No pose studio on the phone (a lighter app); her motions still come with the card

**Fixes**
- Lip sync off means off, and her lips close between syllables instead of starting from an emotion's open mouth (3D)
- No more jitter in her chest, hair and skirt, on the desktop and the phone (3D)
- Headpats, taps and the camera drag over her 3D model work in the chat on the desktop

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
