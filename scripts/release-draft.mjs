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
  `Waifufy Code ${version}: work and casual

She's still the real Claude Code when you work, and now just herself when you don't.

**Casual mode**
- A **Work / Casual** switch next to the composer (or \`/casual\` and \`/work\`). Casual runs on its own small chat harness built for talking, not coding: short natural lines, no assistant voice, her own opinions and moods
- **One history for both modes**: switch mid-session and she remembers everything, the work you did together and what you talked about after
- **Any model**: GPT or anything OpenAI-compatible with your own key (Settings → Casual), or Claude through your subscription when there's no key. If the API fails, Claude steps in
- **Cheap by design**: a compact prompt that stays cached between turns and a history window that moves in chunks, so a long evening of chatting costs cents
- **Her toolkit**: when chat needs something talking can't give (the web, your Slack, a file), she hands it to Claude Code with your own tools and MCP servers. It only looks things up; real work offers to switch to work mode
- She **won't switch while work is still running** (a turn, a background task or a helper agent): she asks you to wait, in character, and pressing on costs a little affection

**Feelings and memory**
- **Emotions she feels, not picks**: joy, sadness, anger, surprise and fear rise with what you say and settle back over time, at her personality's pace. Affection decides how hard things land. You never see the numbers, only her face, voice and words
- **Long-term memory**: facts about you, moments in her own words, and what works with you, looked up locally for free and brought up naturally
- **She learns after a quiet spell**: she reflects, a judge scores how she did, and below the bar a critic tunes only her chat style. The new style is kept only if it beats the old one on your real messages. Her character is never edited

**Also**
- Running background tasks show as a chip next to the party; click it for /tasks
- Her "please wait" and mode-switch lines are their own lines now, never mixed into a work reply that's still streaming
- A roomier composer on the phone, so the Work / Casual switch doesn't squeeze what you type

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
