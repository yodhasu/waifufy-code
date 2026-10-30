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
  `Waifufy Code ${version}: waifu cards, and her in 3D

Everything that makes her *her* now lives on a waifu card you can swap, and a card can draw her as a 3D model.

**Waifu cards** (Settings → Cards)
- A card is one whole character: her persona, her Roleplay presets, her model, her voice and her **love meter**. Make a new one, duplicate one, and swap between sessions; resuming a save swaps to the card it was played with
- The love meter belongs to the card now: it carries from one New Game to the next, and each card has its own
- What she remembers about you stays with each card on your computer and is never put in a card file. Export a card as a \`.waifu.json\`, import one as a new card
- Upgrading makes your first card from your current settings, keeping her memory and your latest love meter

**Her in 3D**
- A card can draw her as an MMD model (\`.pmx\`): MMD shading and outlines, hair and cloth physics, her emotions as face expressions and small head and shoulder movements, lip sync with her voice, eyes that follow the cursor
- Bring your own model; if it can't load, her Live2D costume stands in

**Messages while she works, as in the CLI**
- **Enter** reaches her at her next step (when the running tool call finishes); **Ctrl+X Enter** waits until her turn ends
- **Send now** (Ctrl+Enter, Ctrl+X Ctrl+S, or the button on the queue) sends what you queued and your draft at once
- **Esc** interrupts and sends what you queued next; **Ctrl+S** stashes the draft; **↑** takes queued messages back
- The queue sits on the input's top edge, clear of the quick menu

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
