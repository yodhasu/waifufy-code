import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { FileHit } from './protocol.ts'

// The `@` file picker (R15): every file and folder of the session folder, respecting .gitignore like the CLI.

const MAX_ENTRIES = 30_000
const CACHE_TTL_MS = 30_000
const GIT_TIMEOUT_MS = 10_000
const GIT_MAX_BUFFER = 64 * 1024 * 1024
const TOP = 30
/** Skipped by the walk used outside git repos, where there is no .gitignore to ask. */
const SKIP = new Set(['node_modules', '.git', 'dist', 'target', 'build'])

// Fuzzy score weights: a match in the file name beats one spread over the path; shorter paths win ties.
const SCORE_EXACT_NAME = 1000
const SCORE_NAME_PREFIX = 600
const SCORE_NAME_CONTAINS = 400
const SCORE_PATH_CONTAINS = 250
const SCORE_NAME_SUBSEQUENCE = 150
const SCORE_CHAR = 1
const SCORE_RUN = 5
const SCORE_BOUNDARY = 8
const PENALTY_PER_CHAR = 0.5

type Entry = { path: string; lower: string; name: string; isDir: boolean; depth: number }

const cache = new Map<string, { at: number; entries: Promise<Entry[]> }>()

function gitFiles(cwd: string): Promise<string[] | undefined> {
  return new Promise((done) => {
    execFile(
      'git',
      ['ls-files', '-z', '-co', '--exclude-standard'],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
      (err, stdout) => done(err ? undefined : stdout.split('\0').filter(Boolean)),
    )
  })
}

/** Breadth-first, so a huge folder still yields its top levels before the cap. Links are not followed. */
async function walk(cwd: string): Promise<string[]> {
  const out: string[] = []
  const queue = ['']
  while (queue.length && out.length < MAX_ENTRIES) {
    const rel = queue.shift()!
    const entries = await readdir(join(cwd, rel), { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (out.length >= MAX_ENTRIES) break
      const path = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) queue.push(path)
      } else if (e.isFile()) out.push(path)
    }
  }
  return out
}

async function index(cwd: string): Promise<Entry[]> {
  const files = (await gitFiles(cwd)) ?? (await walk(cwd))
  const seen = new Set<string>()
  const entries: Entry[] = []
  const add = (path: string, isDir: boolean) => {
    if (seen.has(path) || entries.length >= MAX_ENTRIES) return
    seen.add(path)
    // Folders match with their trailing slash, so `@src/` finds the folder itself first.
    const key = (isDir ? path + '/' : path).toLowerCase()
    const name = key.slice(path.lastIndexOf('/') + 1)
    entries.push({ path, lower: key, name, isDir, depth: path.split('/').length })
  }
  for (const raw of files) {
    const path = raw.replaceAll('\\', '/')
    // Folders come from the file paths: git lists only files, and @-mentioning a folder is common.
    for (let i = path.indexOf('/'); i > 0; i = path.indexOf('/', i + 1)) add(path.slice(0, i), true)
    add(path, false)
    if (entries.length >= MAX_ENTRIES) break
  }
  return entries
}

function entriesFor(cwd: string) {
  const key = process.platform === 'win32' ? resolve(cwd).toLowerCase() : resolve(cwd)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.entries
  const entries = index(cwd)
  cache.set(key, { at: Date.now(), entries })
  entries.catch(() => cache.delete(key))
  return entries
}

const isBoundary = (c: string | undefined) => c === undefined || c === '/' || c === '_' || c === '-' || c === '.' || c === ' '

/** Subsequence match of `q` in the path, with bonuses for the file name, prefixes and runs. */
function score(e: Entry, q: string): number | undefined {
  let s = 0
  let at = 0
  let prev = -2
  for (const ch of q) {
    const i = e.lower.indexOf(ch, at)
    if (i < 0) return undefined
    s += SCORE_CHAR + (i === prev + 1 ? SCORE_RUN : 0) + (isBoundary(e.lower[i - 1]) ? SCORE_BOUNDARY : 0)
    prev = i
    at = i + 1
  }
  if (e.name === q) s += SCORE_EXACT_NAME
  else if (e.name.startsWith(q)) s += SCORE_NAME_PREFIX
  else if (e.name.includes(q)) s += SCORE_NAME_CONTAINS
  else if (e.lower.includes(q)) s += SCORE_PATH_CONTAINS
  else if (isSubsequence(q, e.name)) s += SCORE_NAME_SUBSEQUENCE
  return s - e.path.length * PENALTY_PER_CHAR
}

function isSubsequence(q: string, text: string) {
  let at = 0
  for (const ch of q) {
    const i = text.indexOf(ch, at)
    if (i < 0) return false
    at = i + 1
  }
  return true
}

/** The best matches for `@query` in `cwd`, paths relative with forward slashes. */
export async function searchFiles(cwd: string, query: string): Promise<FileHit[]> {
  const entries = await entriesFor(cwd)
  const q = query.trim().replace(/^@/, '').replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase()
  if (!q) {
    // Nothing typed yet: the top of the folder, folders first, like a directory listing.
    return entries
      .filter((e) => e.depth === 1)
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.lower.localeCompare(b.lower))
      .slice(0, TOP)
      .map(({ path, isDir }) => ({ path, isDir }))
  }
  const ranked: { e: Entry; s: number }[] = []
  for (const e of entries) {
    const s = score(e, q)
    if (s !== undefined) ranked.push({ e, s })
  }
  return ranked
    .sort((a, b) => b.s - a.s || a.e.path.length - b.e.path.length)
    .slice(0, TOP)
    .map(({ e }) => ({ path: e.path, isDir: e.isDir }))
}
