import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { clampPoints, levelOf } from './affection.ts'
import { MODEL_KINDS, type CardSummary, type Settings, type WaifuCard } from './protocol.ts'
import { slugify } from './research.ts'
import { DATA_DIR, defaultSettings } from './settings.ts'

// Waifu cards: one file per character under DATA_DIR/cards. The active card's fields live in settings.json too
// (settings.waifu, .presets, the look and voice fields), because every screen and the persona read them there; the
// link writes them back to the card on each settings_set and copies a card's fields in on a switch.
// What she learned about the user (casual memory, her mood) is keyed by the card id elsewhere and is never written
// into a card file, so an exported card carries the character and her love meter, not the user's personal save.

export const CARDS_DIR = join(DATA_DIR, 'cards')
/** Exported cards end in this, so a file picker can filter for them. */
export const CARD_EXT = '.waifu.json'
const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/
const ID_RANDOM_BYTES = 3
/** A card file is persona text and a few presets; anything far bigger isn't one. */
const CARD_MAX_BYTES = 2 * 1024 * 1024

export const isCardId = (id: unknown): id is string => typeof id === 'string' && ID_RE.test(id)
const fileOf = (id: string) => join(CARDS_DIR, `${id}.json`)

/** Writes run one after another, so a love-meter tick can't lose a settings sync written at the same moment. */
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job)
  queue = run.catch(() => {})
  return run
}

/** The card fields of `s`, on top of `prev` (which keeps its love meter and creation time). */
export function cardOf(s: Settings, prev?: WaifuCard): WaifuCard {
  const a = s.appearance
  const v = s.voice
  const now = Date.now()
  return {
    version: 1,
    id: prev?.id ?? s.card,
    waifu: structuredClone(s.waifu),
    // The library is shared by every card; a card keeps only the preset she plays, so an export carries it.
    presets: structuredClone(s.presets.filter((p) => p.id === s.waifu.activePreset)),
    look: { model: a.model, modelsDir: a.modelsDir, costume: a.costume, zoom: a.zoom, mmdFile: a.mmdFile },
    voice: { voiceId: v.voiceId, language: v.language, speed: v.speed, styleNotes: v.styleNotes, pronunciations: v.pronunciations },
    love: { points: prev?.love.points ?? 0 },
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  }
}

/** Copies a card's fields into `s` and makes it the active card. Everything that isn't hers stays. */
export function applyCard(s: Settings, c: WaifuCard) {
  s.card = c.id
  s.waifu = structuredClone(c.waifu)
  // Her preset joins the shared library; the presets researched for anyone else stay.
  s.presets = [...s.presets.filter((p) => !c.presets.some((x) => x.id === p.id)), ...structuredClone(c.presets)]
  // A card from another machine may name a models folder that isn't here: the default one stands in.
  const modelsDir = c.look.modelsDir && existsSync(c.look.modelsDir) ? c.look.modelsDir : s.appearance.modelsDir
  Object.assign(s.appearance, c.look, { modelsDir })
  Object.assign(s.voice, c.voice)
}

/** Keeps only the keys `base` has, each of its type (a wrong or missing value takes the base's). */
function sameShape<T extends object>(base: T, v: unknown): T {
  const out = { ...base } as Record<string, unknown>
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  for (const [k, b] of Object.entries(base)) {
    const x = o[k]
    if (x !== null && typeof x === typeof b && Array.isArray(x) === Array.isArray(b)) out[k] = x
  }
  return out as T
}

/** Puts the active card's fields of `from` back into `into`, leaving the rest of `into` as it is. */
export function keepCard(into: Settings, from: Settings) {
  applyCard(into, cardOf(from))
  into.appearance.modelsDir = from.appearance.modelsDir
}

/** Any JSON shaped roughly like a card, made into one: unknown keys dropped, missing or mistyped ones from the defaults. */
function normalize(raw: unknown, id: string): WaifuCard {
  const base = cardOf({ ...defaultSettings(), card: id })
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const waifu = sameShape(base.waifu, r.waifu)
  waifu.catchphrases = waifu.catchphrases.filter((p) => typeof p === 'string')
  const look = sameShape(base.look, r.look)
  if (!MODEL_KINDS.includes(look.model)) look.model = 'live2d'
  const voice = sameShape(base.voice, r.voice)
  if (voice.language !== 'en') voice.language = 'ja'
  const presets = (Array.isArray(r.presets) ? r.presets : []).filter(
    (p): p is WaifuCard['presets'][number] => !!p && typeof p.id === 'string' && typeof p.prompt === 'string' && !!p.profile && typeof p.profile === 'object',
  )
  if (waifu.activePreset && !presets.some((p) => p.id === waifu.activePreset)) waifu.activePreset = ''
  const love = r.love && typeof r.love === 'object' ? (r.love as { points?: unknown }).points : 0
  const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : base.createdAt)
  return { version: 1, id, waifu, presets, look, voice, love: { points: clampPoints(Number(love)) }, createdAt: time(r.createdAt), updatedAt: time(r.updatedAt) }
}

export async function readCard(id: string): Promise<WaifuCard | undefined> {
  if (!isCardId(id)) return undefined
  try {
    return normalize(JSON.parse(await readFile(fileOf(id), 'utf8')), id)
  } catch {
    return undefined
  }
}

async function writeCard(c: WaifuCard) {
  await mkdir(CARDS_DIR, { recursive: true })
  const tmp = `${fileOf(c.id)}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(c, null, 2) + '\n')
  await rename(tmp, fileOf(c.id))
}

export async function listCards(): Promise<CardSummary[]> {
  await queue
  const names = await readdir(CARDS_DIR).catch(() => [] as string[])
  const cards = await Promise.all(names.filter((n) => n.endsWith('.json')).map((n) => readCard(n.slice(0, -'.json'.length))))
  return cards
    .filter((c): c is WaifuCard => !!c)
    .map((c) => ({
      id: c.id,
      name: c.waifu.name.trim() || 'Unnamed',
      series: c.waifu.series.trim(),
      model: c.look.model,
      costume: c.look.costume,
      hearts: levelOf(c.love.points),
      points: c.love.points,
      voiced: !!c.voice.voiceId.trim(),
      updatedAt: c.updatedAt,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.updatedAt - b.updatedAt)
}

function newId(name: string) {
  return `${slugify(name) || 'waifu'}-${randomBytes(ID_RANDOM_BYTES).toString('hex')}`
}

/**
 * Makes sure `s` has an active card on disk, and returns the id (`s.card` is set; the caller saves settings).
 * The first one, made from the settings of a version before cards, takes the id her memory already lives under
 * (the slug of her name), so she keeps what she knows; `love` seeds its meter (the latest save's points).
 */
export function ensureCard(s: Settings, love: () => Promise<number>): Promise<string> {
  return serial(async () => {
    if (isCardId(s.card) && existsSync(fileOf(s.card))) {
      // settings.json is the live copy: an older version of the app may have edited it without knowing about cards.
      const prev = await readCard(s.card)
      if (prev) await writeCard(cardOf(s, prev))
      return s.card
    }
    const id = isCardId(s.card) ? s.card : slugify(s.waifu.name.trim() || defaultSettings().waifu.name) || 'character'
    s.card = id
    const c = cardOf(s)
    c.love.points = clampPoints(await love().catch(() => 0))
    await writeCard(c)
    return id
  })
}

/** Writes the card fields of `s` back to its active card. */
export function syncCard(s: Settings): Promise<void> {
  return serial(async () => {
    if (!isCardId(s.card)) return
    const prev = await readCard(s.card)
    if (!prev) return
    await writeCard(cardOf(s, prev))
  })
}

/** The love meter of a card, in points. */
export async function cardLove(id: string): Promise<number> {
  await queue
  return (await readCard(id))?.love.points ?? 0
}

export function setCardLove(id: string, points: number): Promise<void> {
  return serial(async () => {
    const c = await readCard(id)
    if (!c) return
    const next = clampPoints(points)
    if (next === c.love.points) return
    c.love.points = next
    c.updatedAt = Date.now()
    await writeCard(c)
  })
}

/** A new card: a copy of `from` with a fresh love meter, or the default character. */
export function newCard(from?: WaifuCard): Promise<WaifuCard> {
  return serial(async () => {
    const base = from ? structuredClone(from) : cardOf({ ...defaultSettings(), card: '' })
    const c: WaifuCard = { ...base, id: newId(base.waifu.name), love: { points: 0 }, createdAt: Date.now(), updatedAt: Date.now() }
    if (from) c.waifu.name = `${from.waifu.name.trim() || 'Waifu'} (copy)`
    await writeCard(c)
    return c
  })
}

export function deleteCard(id: string): Promise<void> {
  return serial(async () => {
    if (isCardId(id)) await rm(fileOf(id), { force: true })
  })
}

/**
 * The card as a file to share. Paths on this machine don't travel: the models folder is left out, and an MMD
 * model keeps only its file name, which an import finds next to the card file (ship the card in the model's folder).
 */
export async function exportCard(id: string, path: string) {
  const c = await readCard(id)
  if (!c) throw new Error('That card no longer exists.')
  const out = { ...c, look: { ...c.look, modelsDir: '', mmdFile: c.look.mmdFile ? basename(c.look.mmdFile) : '' } }
  const target = path.endsWith(CARD_EXT) ? path : `${path.replace(/\.json$/i, '')}${CARD_EXT}`
  await writeFile(target, JSON.stringify(out, null, 2) + '\n')
  return target
}

/** Reads a card file into a new card with its own id, so it never overwrites one the user has. */
export function importCard(path: string): Promise<WaifuCard> {
  return serial(async () => {
    const text = await readFile(path, 'utf8')
    if (Buffer.byteLength(text) > CARD_MAX_BYTES) throw new Error('That file is too large to be a waifu card.')
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      throw new Error("That file isn't a waifu card (it isn't JSON).")
    }
    if (!raw || typeof raw !== 'object' || !('waifu' in raw)) throw new Error("That file isn't a waifu card.")
    const name = (raw as { waifu?: { name?: unknown } }).waifu?.name
    const c = normalize(raw, newId(typeof name === 'string' ? name : ''))
    const mmd = c.look.mmdFile
    if (mmd && !isAbsolute(mmd)) c.look.mmdFile = existsSync(resolve(dirname(path), mmd)) ? resolve(dirname(path), mmd) : ''
    if (c.look.model === 'mmd' && !c.look.mmdFile) c.look.model = 'live2d'
    c.createdAt = c.updatedAt = Date.now()
    await writeCard(c)
    return c
  })
}
