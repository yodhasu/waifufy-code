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
  `Waifufy Code ${version}: a phone that stays connected, and a low-spec mode

**Your phone stays connected**
- After a drop it tries every address it knows at once (home Wi-Fi, Tailscale…), over and over, and gets back in on its own
- If the computer isn't there when you open the app, it waits for it instead of asking you to scan the code again
- Each phone is paired for good with its own key: a new pairing code no longer unpairs anyone, and Settings → Phone lists your phones with Remove
- An emergency key: keep a copy of the pairing link; pasting it on the phone brings it back without your computer's screen (the phone also keeps it, and uses it by itself)
- With phone access on, closing the window keeps Waifufy Code in the tray, so your phone can always reach it (Quit is in the tray menu)

**Reine on the phone**
- Framed from the waist up in the chat, her head centered; zoom closes in on her head
- Lighter 3D on the phone: no outline pass, 1× density, physics at 30 steps a second

**Low-spec mode** (Settings → Phone, on the phone)
- No character at all, and the chat becomes a chat room. Her voice still reads every line, and everything else works

**Also new since 0.7.2** (0.8.0–0.8.2, released here for the first time)
- **Waifu cards** (Settings → Cards): each character is a card with her persona, presets, model, voice and her own love meter; swap between sessions, export and import
- **Her in 3D**: a card can draw her as an MMD model (\`.pmx\`) with physics, expressions, breathing, headpats, wheel zoom and a camera you can turn; phones get lighter textures
- **Her voice** learns how to say her name (Settings → Voice → Pronunciation), and research writes that for you
- **Messages while she works** as in the CLI: Enter reaches her at her next step, Ctrl+Enter sends now, Ctrl+X Enter waits for her turn, Ctrl+S stashes

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
