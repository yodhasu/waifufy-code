// Fetches motion libraries into assets/motions/ for the MMD lab (never committed). Skips files already there, so
// it can be re-run after an interrupted download. Node 18+, no packages; zips are unpacked with the system `tar`.
//
//   node ui-draft/mmd-lab/download-motions.mjs bandai             the conversational gestures (~30 MB with 3 takes)
//   … --to <folder>                                               put the libraries there instead of assets/motions
//   node ui-draft/mmd-lab/download-motions.mjs bandai --takes 10   more takes of each dataset-2 wave / raise-hand
//   node ui-draft/mmd-lab/download-motions.mjs bandai --all        the whole Bandai Namco repository (~310 MB zip)
//   node ui-draft/mmd-lab/download-motions.mjs cmu --from <zip>    unpack the CMU pack you downloaded from itch.io
//   node ui-draft/mmd-lab/download-motions.mjs vrma --from <zip>   unpack the VRoid VRMA motion pack
//
// Sources and terms (keep CREDITS.md next to the files):
// - Bandai Namco Research Motiondataset 1 & 2: CC BY-NC 4.0 (non-commercial, credit required).
//   https://github.com/BandaiNamcoResearchInc/Bandai-Namco-Research-Motiondataset
// - CMU Graphics Lab Motion Capture Database, converted to FBX by RancidMilk: free to use, modify and redistribute,
//   not to sell. Download "Anims_Only_FBX_V1.zip" (441 MB) by hand: https://rancidmilk.itch.io/free-character-animations
// - VRoid Project VRMA Motion Pack (pixiv): free incl. commercial with credit "Animation credits to pixiv Inc.'s
//   VRoid Project"; don't redistribute it in an extractable form without pixiv's permission.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const [what, ...rest] = process.argv.slice(2)
const flag = (name) => rest.includes(name)
const option = (name, fallback) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : fallback)

// --to <folder>: put the libraries somewhere else (each in its own subfolder) instead of the lab's assets.
const ROOT = option('--to') ? resolve(option('--to')) : join(import.meta.dirname, 'assets', 'motions')
const REPO = 'BandaiNamcoResearchInc/Bandai-Namco-Research-Motiondataset'
const RAW = `https://raw.githubusercontent.com/${REPO}/master/`
// Waist-up, conversational: dataset 1 in every style, dataset 2's waves and raised hands.
const D1 = /^dataset\/Bandai-Namco-Research-Motiondataset-1\/data\/dataset-1_(bow|bye|byebye|guide|respond|call)_[a-z-]+_\d+\.bvh$/
const D2 = /^dataset\/Bandai-Namco-Research-Motiondataset-2\/data\/dataset-2_(wave-both-hands|wave-left-hand|wave-right-hand|raise-up-both-hands|raise-up-left-hand|raise-up-right-hand)_[a-z]+_(\d+)\.bvh$/

async function fetchTo(url, file) {
  if (existsSync(file) && statSync(file).size > 0) return false
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  return true
}

/** Runs `jobs` (functions returning promises) a few at a time, printing progress. */
async function pool(jobs, size = 4) {
  let next = 0, done = 0, fetched = 0, failed = 0
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++]
      try {
        if (await job()) fetched++
      } catch (e) {
        failed++
        console.warn(`\n  failed: ${e.message}`)
      }
      process.stdout.write(`\r  ${++done}/${jobs.length}`)
    }
  }
  await Promise.all(Array.from({ length: size }, worker))
  console.log(`\n  ${fetched} downloaded, ${jobs.length - fetched - failed} already there, ${failed} failed`)
}

function unzip(zip, dest) {
  if (!existsSync(zip)) throw new Error(`no such file: ${zip}`)
  mkdirSync(dest, { recursive: true })
  // Windows 10+ and macOS ship a bsdtar that reads zip files; GNU tar on Linux does not, so try unzip there.
  try {
    execFileSync('tar', ['-xf', zip, '-C', dest], { stdio: 'inherit' })
  } catch {
    execFileSync('unzip', ['-o', zip, '-d', dest], { stdio: 'inherit' })
  }
  console.log(`  unpacked ${basename(zip)} into ${dest}`)
}

async function bandai() {
  const dest = join(ROOT, 'bandai')
  mkdirSync(dest, { recursive: true })
  if (flag('--all')) {
    const zip = join(ROOT, 'bandai-full.zip')
    console.log('Bandai Namco, whole repository (~310 MB)…')
    await fetchTo(`https://codeload.github.com/${REPO}/zip/refs/heads/master`, zip)
    return unzip(zip, join(ROOT, 'bandai-full'))
  }
  const takes = Number(option('--takes', 3))
  console.log(`Bandai Namco gestures (dataset 2: ${takes} take${takes > 1 ? 's' : ''} each)…`)
  const tree = await (await fetch(`https://api.github.com/repos/${REPO}/git/trees/master?recursive=1`)).json()
  if (!tree.tree) throw new Error(`GitHub said: ${tree.message ?? 'no file list'} (the anonymous limit is 60 calls an hour)`)
  const paths = tree.tree.map((t) => t.path).filter((p) => D1.test(p) || (D2.test(p) && Number(D2.exec(p)[2]) <= takes))
  await pool(paths.map((p) => () => fetchTo(RAW + p, join(dest, basename(p)))))
  await fetchTo(RAW + 'dataset/Bandai-Namco-Research-Motiondataset-1/LICENSE', join(dest, 'LICENSE.txt'))
}

const credits = `# Motion credits

- Bandai Namco Research Motiondataset 1 & 2 (CC BY-NC 4.0): Kobayashi et al., "Motion Capture Dataset for Practical
  Use of AI-based Motion Editing and Stylization" (2023). https://github.com/${REPO}
- CMU Graphics Lab Motion Capture Database (http://mocap.cs.cmu.edu), FBX conversion by RancidMilk
  (https://rancidmilk.itch.io/free-character-animations). Not for resale.
- Animation credits to pixiv Inc.'s VRoid Project (VRMA Motion Pack).
`

mkdirSync(ROOT, { recursive: true })
writeFileSync(join(ROOT, 'CREDITS.md'), credits)
if (what === 'bandai') await bandai()
else if (what === 'cmu' || what === 'vrma') {
  const zip = option('--from')
  if (!zip) {
    console.log(what === 'cmu'
      ? 'Download "Anims_Only_FBX_V1.zip" from https://rancidmilk.itch.io/free-character-animations (free, "No thanks, just take me to the downloads"), then:\n  node ui-draft/mmd-lab/download-motions.mjs cmu --from <path to the zip>'
      : 'Give the VRoid pack: node ui-draft/mmd-lab/download-motions.mjs vrma --from <path to VRMA_MotionPack.zip>')
    process.exit(1)
  }
  unzip(zip, join(ROOT, what))
} else {
  console.log('Usage: node ui-draft/mmd-lab/download-motions.mjs bandai [--takes N | --all] | cmu --from <zip> | vrma --from <zip>')
  process.exit(1)
}
