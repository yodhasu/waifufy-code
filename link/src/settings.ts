import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Settings } from './protocol.ts'

/** Everything the app writes: settings, saves registry, thumbnails, logs. */
export const DATA_DIR = process.env.WC_DATA_DIR || join(process.env.APPDATA ?? join(homedir(), '.config'), 'waifufy-code')
const FILE = join(DATA_DIR, 'settings.json')

/** Where costume folders are looked for when `appearance.modelsDir` is empty or missing, in order. */
export function modelDirCandidates(): string[] {
  // The E2E suite turns the search off to play a first run on a machine without the costumes.
  if (process.env.WC_NO_MODEL_SEARCH === '1') return []
  const home = homedir()
  return [
    join(home, 'Downloads', 'ReZero LiM Live2D Characters', 'Live2D Characters'),
    join(home, 'Documents', 'Work', 'waifufy', 'assets', 'models'),
    ...(process.env.WAIFUFY_HOME ? [join(process.env.WAIFUFY_HOME, 'assets', 'models')] : []),
  ]
}

export function defaultModelsDir() {
  return modelDirCandidates().find((d) => existsSync(d)) ?? ''
}

export function defaultSettings(): Settings {
  return {
    version: 1,
    onboarded: false,
    profile: {
      displayName: 'Master',
      callMe: 'Master',
      honorific: 'kun',
      customHonorific: '',
      pronouns: 'he/him',
      title: 'Developer',
      about: '',
      avatar: '',
      nameColor: '#c9973f',
    },
    waifu: {
      name: 'Rem',
      series: 'Re:Zero − Starting Life in Another World',
      relationship: 'maid',
      relationshipCustom: '',
      personalityPreset: 'devoted',
      personality: 'Devoted, earnest and warm, a little playful. Takes pride in doing work properly, worries when something is risky, and is quietly happy when things go well. Never sarcastic toward the user.',
      formality: 60,
      playfulness: 40,
      verbosity: 45,
      catchphrases: [],
      japanese: true,
      kaomoji: false,
      workVoice: 'full',
      expressiveness: 'normal',
      customInstructions: '',
      activePreset: '',
    },
    presets: [],
    appearance: {
      theme: 'system',
      accent: '#5b8de0',
      fontSize: 21,
      boxOpacity: 0.94,
      background: 'auto',
      petals: true,
      costume: 'ac_base_rem01',
      zoom: 1,
      modelsDir: defaultModelsDir(),
    },
    motion: {
      textCps: 14,
      punctuationPauses: true,
      autoDelayMs: 1200,
      lipSync: true,
      idle: true,
      cursor: true,
      headpats: true,
      taps: true,
      gestures: true,
    },
    claude: { model: '', permissionMode: 'default', defaultDir: '', settingSources: ['user', 'project', 'local'] },
    voice: { provider: 'off' },
    lastDir: '',
  }
}

/** Deep-merges `stored` over the defaults, so settings written by an older version gain new keys. */
function merge<T>(base: T, stored: unknown): T {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) {
    return stored === undefined || (stored !== null && typeof stored !== typeof base) ? base : (stored as T)
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [k, v] of Object.entries(stored)) out[k] = k in out ? merge(out[k], v) : v
  }
  return out as T
}

export async function loadSettings(): Promise<Settings> {
  let stored: unknown
  try {
    stored = JSON.parse(await readFile(FILE, 'utf8'))
  } catch {
    stored = undefined
  }
  const s = merge(defaultSettings(), stored)
  // v0 stored only { userName }. Migrated once: a file that already has a profile is v1, and the old key is
  // dropped so it is never written back (it would otherwise undo a later "Master" or a Reset on every load).
  const old = stored as { userName?: unknown; profile?: unknown } | undefined
  if (typeof old?.userName === 'string' && old.userName.trim() && !old.profile) {
    s.profile.displayName = s.profile.callMe = old.userName.trim()
  }
  delete (s as { userName?: unknown }).userName
  // Only an empty folder gets the default here. A saved folder that is missing right now (an external drive not
  // plugged in yet) is kept; listing and serving costumes fall back to the default on their own meanwhile.
  if (!s.appearance.modelsDir) s.appearance.modelsDir = defaultModelsDir()
  return s
}

/** Writes atomically (temp file + rename), so a crash mid-write never corrupts settings. */
export async function saveSettings(s: Settings) {
  await mkdir(DATA_DIR, { recursive: true })
  const tmp = `${FILE}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(s, null, 2) + '\n')
  await rename(tmp, FILE)
}

export { addressOf } from './address.ts'
