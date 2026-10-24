import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { basename, extname, join, resolve, sep } from 'node:path'
import type { Costume } from './protocol.ts'
import { THUMBS_DIR } from './saves.ts'
import { defaultModelsDir, loadSettings, modelDirCandidates } from './settings.ts'

// Costume models (each a folder with a .model3.json) and save thumbnails, served over plain HTTP:
// the page loads them by URL, so these routes carry no token.

/** The default character. A folder full of many characters is narrowed to this one's costumes. */
const CHARACTER = 'rem'
const CHARACTER_RE = new RegExp(`(?:^|[^a-z])${CHARACTER}(?:[^a-z]|$)`, 'i')
const MODEL_SUFFIX = '.model3.json'
const FOLDER_PREFIX = /^ac_base_/i

/** Labels of Rem's known costumes, in picker order. */
const LABELS: [key: string, label: string][] = [
  ['rem01', 'Maid (default)'],
  ['rem_childhood01', 'Childhood'],
  ['rem_mizugi01', 'Swimsuit'],
  ['rem_nemaki01', 'Nightwear'],
  ['rem_ogre01', 'Oni'],
  ['rem_ogre_normal01', 'Oni (calm)'],
  ['rem_pokerface01', 'Poker face'],
  ['rem_valentine01', 'Valentine'],
  ['rem_xmas01', 'Christmas'],
]
const LABEL = new Map(LABELS)
const ORDER = new Map(LABELS.map(([key], i) => [key, i]))

const MIME: Record<string, string> = {
  '.json': 'application/json',
  '.moc3': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
}

/** Costume id → its folder, from the last listing. Ids not listed yet are looked up in the known roots. */
const folders = new Map<string, string>()

type Found = { id: string; folder: string; model: string }

async function modelFile(folder: string): Promise<string | undefined> {
  const names = await readdir(folder).catch(() => [] as string[])
  return names.find((n) => n.toLowerCase().endsWith(MODEL_SUFFIX))
}

function costumeKey(name: string) {
  const stem = name.toLowerCase().endsWith(MODEL_SUFFIX) ? name.slice(0, -MODEL_SUFFIX.length) : name
  return stem.replace(FOLDER_PREFIX, '').toLowerCase()
}

/** `rem_school_uniform02` → `School Uniform 2`. */
function titleCase(key: string) {
  const [, stem, num] = /^(.*?)(\d*)$/.exec(key) ?? [key, key, '']
  const words = stem.split(/[_\-\s]+/).filter(Boolean)
  if (words.length > 1 && words[0].toLowerCase() === CHARACTER) words.shift()
  const label = words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || key
  return num && Number(num) > 1 ? `${label} ${Number(num)}` : label
}

function describe(f: Found): Costume & { order: number } {
  // A renamed folder (like waifufy's `rem/`) still holds a recognizable model file.
  const keys = [costumeKey(f.id), costumeKey(f.model)]
  const key = keys.find((k) => LABEL.has(k))
  return {
    id: f.id,
    label: key ? LABEL.get(key)! : titleCase(keys[0]),
    modelUrl: `/models/${encodeURIComponent(f.id)}/${encodeURIComponent(f.model)}`,
    order: key ? ORDER.get(key)! : LABELS.length,
  }
}

async function scan(dir: string): Promise<Found[]> {
  // The folder may itself be one model (the user picked a single costume folder).
  const own = await modelFile(dir)
  if (own) return [{ id: basename(dir), folder: dir, model: own }]
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const found = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const folder = join(dir, e.name)
        const model = await modelFile(folder)
        return model ? { id: e.name, folder, model } : undefined
      }),
  )
  return found.filter((f) => f !== undefined)
}

/** The `costumes` reply: Rem's costumes in `dir` (default: the models folder from settings). */
/**
 * Lists the costumes in `dir`. `undefined` = the saved models folder; '' = the default folder (Settings → Use default),
 * which the saved value can't be trusted for: the store saves 400 ms after the change.
 */
export async function listCostumes(dir?: string): Promise<{ list: Costume[]; dir: string; found: boolean }> {
  const requested =
    dir === undefined ? (await loadSettings()).appearance.modelsDir || defaultModelsDir() : dir.trim() ? resolve(dir.trim()) : defaultModelsDir()
  // A saved folder that is missing right now (a drive not plugged in) lists the default folder meanwhile. The reply
  // still names the requested folder: the app matches replies to its request by it.
  const root = requested && existsSync(requested) ? requested : defaultModelsDir()
  if (!root) return { list: [], dir: requested, found: false }
  const all = await scan(root)
  const mine = all.filter((f) => CHARACTER_RE.test(f.id) || CHARACTER_RE.test(f.model))
  const picked = mine.length ? mine : all
  for (const f of picked) folders.set(f.id, f.folder)
  const list = picked
    .map(describe)
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
    .map(({ order: _, ...c }) => c)
  return { list, dir: requested, found: list.length > 0 }
}

async function costumeFolder(id: string): Promise<string | undefined> {
  const known = folders.get(id)
  if (known) return known
  const roots = [(await loadSettings()).appearance.modelsDir, ...modelDirCandidates()].filter(Boolean)
  for (const root of roots) {
    const folder = join(root, id)
    if (existsSync(folder) && (await modelFile(folder))) {
      folders.set(id, folder)
      return folder
    }
  }
  return undefined
}

function reply(res: ServerResponse, status: number, body: Buffer | string, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' })
  res.end(body)
}

/** Splits a URL path into decoded segments; undefined for a malformed %-escape. */
function segments(path: string): string[] | undefined {
  try {
    return path.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return undefined
  }
}

// A segment may not climb, carry its own separator, or name a drive or stream.
const BAD_SEGMENT = /^\.\.?$|[\\/:\0]/

async function sendFile(res: ServerResponse, file: string) {
  const info = await stat(file).catch(() => undefined)
  if (!info?.isFile()) return reply(res, 404, 'not found')
  let body: Buffer = await readFile(file)
  if (file.toLowerCase().endsWith('.motion3.json')) body = fixMotionMeta(body)
  reply(res, 200, body, MIME[extname(file).toLowerCase()] ?? 'application/octet-stream')
}

/** Serves `/models/<costumeId>/<path>`, refusing anything that climbs out of the costume's folder. */
export async function serveModel(pathname: string, res: ServerResponse) {
  const parts = segments(pathname.slice('/models/'.length))
  if (!parts) return reply(res, 400, 'bad request')
  if (parts.length < 2 || parts.some((p) => BAD_SEGMENT.test(p))) return reply(res, 403, 'forbidden')
  const [id, ...rest] = parts
  const folder = await costumeFolder(id)
  if (!folder) return reply(res, 404, 'no such costume')
  const file = resolve(folder, ...rest)
  if (!file.startsWith(resolve(folder) + sep)) return reply(res, 403, 'forbidden')
  await sendFile(res, file)
}

/** Serves `/thumbs/<id>.jpg` from the data folder. */
export async function serveThumb(pathname: string, res: ServerResponse) {
  const parts = segments(pathname.slice('/thumbs/'.length))
  if (!parts) return reply(res, 400, 'bad request')
  if (parts.length !== 1 || !/^[\w-]+\.jpg$/.test(parts[0])) return reply(res, 403, 'forbidden')
  await sendFile(res, join(THUMBS_DIR, parts[0]))
}

type Motion = {
  Meta?: Record<string, unknown>
  Curves?: { Segments?: number[] }[]
  UserData?: { Value?: string }[]
}

/**
 * Recounts a motion3.json's `Meta` totals from its curves. Models ripped from games often carry wrong
 * counts, and the Cubism framework sizes its buffers from them, so a wrong count fails the parse.
 * Same fix as waifufy's overlay server.
 */
function fixMotionMeta(bytes: Buffer): Buffer {
  let motion: Motion
  try {
    motion = JSON.parse(bytes.toString('utf8'))
  } catch {
    return bytes
  }
  const curves = motion.Curves ?? []
  let segmentCount = 0
  let points = 0
  for (const curve of curves) {
    const s = curve.Segments ?? []
    if (s.length < 2) continue
    points += 1 // the curve's first point
    let i = 2
    while (i < s.length) {
      // Bezier: two control points and the end point. Linear, stepped, inverse stepped: one point.
      const isBezier = s[i] === 1
      segmentCount += 1
      points += isBezier ? 3 : 1
      i += isBezier ? 7 : 3
    }
  }
  const userData = motion.UserData ?? []
  if (motion.Meta) {
    motion.Meta.CurveCount = curves.length
    motion.Meta.TotalSegmentCount = segmentCount
    motion.Meta.TotalPointCount = points
    motion.Meta.UserDataCount = userData.length
    motion.Meta.TotalUserDataSize = userData.reduce((n, u) => n + (u.Value?.length ?? 0), 0)
  }
  return Buffer.from(JSON.stringify(motion))
}
