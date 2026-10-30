import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { VoiceSettings } from './protocol.ts'
import { DATA_DIR } from './settings.ts'

// Her voice through Fish Audio (docs/research/rem-voice.md). The key lives here, in its own file next to the
// settings and never inside them, so it never reaches the page or the CLI. FISH_API_KEY overrides the file.

const KEY_FILE = join(DATA_DIR, 'fish-audio.key')
const API = 'https://api.fish.audio/v1/tts'
/** Below Fish's Starter concurrency (5), so a burst of pages never earns a 429. */
const MAX_IN_FLIGHT = 3
const RETRY_MS = 1200
const REQUEST_TIMEOUT_MS = 30_000
/** Recent clips, so a page shown again (LOG replay, a repeated greeting) costs nothing. */
const CACHE_MAX = 40
/** A voice line past this is not a line; it is cut rather than sent. */
const TEXT_MAX = 600
const MP3_BITRATE = 128

export type Clip = { audio: Buffer; mime: string }

const MOCK = process.env.WC_MOCK === '1'
const MOCK_FAIL_KEY = 'mock-fail'

export function voiceKey(): string {
  const env = process.env.FISH_API_KEY?.trim()
  if (env) return env
  try {
    return existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8').trim() : ''
  } catch {
    return ''
  }
}

export const hasVoiceKey = () => voiceKey() !== ''

/** Whether this session speaks: on, a key stored, and a voice picked. */
export const voiceActive = (v: VoiceSettings) => v.enabled && v.voiceId.trim() !== '' && hasVoiceKey()

export async function setVoiceKey(key: string) {
  const k = key.trim()
  if (!k) return rm(KEY_FILE, { force: true })
  await mkdir(DATA_DIR, { recursive: true })
  const tmp = `${KEY_FILE}.${process.pid}.tmp`
  await writeFile(tmp, k + '\n', { mode: 0o600 })
  await rename(tmp, KEY_FILE)
}

const cache = new Map<string, Clip>()
let inFlight = 0
const waiting: (() => void)[] = []

async function slot() {
  if (inFlight < MAX_IN_FLIGHT) return void inFlight++
  await new Promise<void>((r) => waiting.push(r))
  inFlight++
}

function release() {
  inFlight--
  waiting.shift()?.()
}

class VoiceError extends Error {}

/** What a Fish status means for the user. */
function statusText(status: number, body: string) {
  if (status === 401) return 'Fish Audio rejected the API key.'
  if (status === 402) return 'Fish Audio is out of credits for this key.'
  if (status === 400) return `Fish Audio refused the request (check the voice id; the free model may not take this voice)${body ? `: ${body.slice(0, 160)}` : ''}`
  if (status === 429) return 'Fish Audio is rate limiting: too many requests at once.'
  if (status === 503) return 'Fish Audio is overloaded right now.'
  return `Fish Audio answered ${status}${body ? `: ${body.slice(0, 160)}` : ''}`
}

async function request(text: string, v: VoiceSettings, key: string): Promise<Clip> {
  const res = await fetch(API, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', model: v.model },
    body: JSON.stringify({
      text,
      reference_id: v.voiceId.trim(),
      format: 'mp3',
      mp3_bitrate: MP3_BITRATE,
      latency: 'balanced',
      normalize: true,
      // Volume is the app's own gain: changing it needs no new clip.
      prosody: { speed: Math.max(0.5, Math.min(2, v.speed || 1)) },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const err = new VoiceError(statusText(res.status, body.trim()))
    ;(err as VoiceError & { status?: number }).status = res.status
    throw err
  }
  return { audio: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type')?.split(';')[0] || 'audio/mpeg' }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Respells words the voice gets wrong, from `Reine = Ray-neh` lines (`→` or `->` work too); longer words first, so
 * "Pavolia Reine" wins over "Reine". Latin words match whole and ignore case; others (kana, kanji) match as written.
 */
export function pronounce(text: string, rules: string): string {
  const pairs = (rules ?? '')
    .split('\n')
    .map((l) => l.split(/\s*(?:=|→|->)\s*/))
    .filter((p): p is [string, string] => p.length === 2 && !!p[0]!.trim() && !!p[1]!.trim())
    .map(([w, say]) => [w.trim(), say.trim()] as const)
    .sort((a, b) => b[0].length - a[0].length)
  let out = text
  for (const [word, say] of pairs) {
    const latin = /^[\p{Script=Latin}\d\s'-]+$/u.test(word)
    const re = latin ? new RegExp(`(?<![\\p{L}\\d])${escapeRe(word)}(?![\\p{L}\\d])`, 'giu') : new RegExp(escapeRe(word), 'gu')
    out = out.replace(re, say)
  }
  return out
}

/** One clip for `text` in her voice. Retries a 429 or 503 once; throws a VoiceError with a readable message. */
export async function synthesize(text: string, v: VoiceSettings): Promise<Clip> {
  const line = pronounce(text, v.pronunciations).trim().slice(0, TEXT_MAX)
  if (!line) throw new VoiceError('Nothing to say.')
  const id = `${v.model}|${v.voiceId}|${v.speed}|${line}`
  const hit = cache.get(id)
  if (hit) return hit
  const key = voiceKey()
  if (!key) throw new VoiceError('No Fish Audio API key is stored.')
  await slot()
  try {
    let clip: Clip
    // The E2E suite's way to see Fish refuse a key.
    if (MOCK && key === MOCK_FAIL_KEY) throw new VoiceError(statusText(401, ''))
    if (MOCK) clip = mockClip(line, v.speed)
    else {
      try {
        clip = await request(line, v, key)
      } catch (e) {
        const status = (e as { status?: number }).status
        if (status !== 429 && status !== 503) throw e
        await new Promise((r) => setTimeout(r, RETRY_MS))
        clip = await request(line, v, key)
      }
    }
    cache.set(id, clip)
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
    return clip
  } catch (e) {
    if (e instanceof VoiceError) throw e
    throw new VoiceError(e instanceof Error && e.name === 'TimeoutError' ? 'Fish Audio took too long to answer.' : `Couldn't reach Fish Audio: ${e instanceof Error ? e.message : e}`)
  } finally {
    release()
  }
}

// ---------------------------------------------------------------- mock (E2E): a syllable-like tone

const MOCK_RATE = 16_000
/** Mock speech pace: characters per second at speed 1 (Japanese is ~8). */
const MOCK_CPS = 8
const MOCK_MIN_S = 0.6
const MOCK_SYLLABLE_HZ = 6

/** A WAV whose length follows the text and whose loudness pulses like syllables, so sync and lip sync are testable. */
export function mockClip(text: string, speed = 1): Clip {
  const seconds = Math.max(MOCK_MIN_S, [...text].length / (MOCK_CPS * (speed || 1)))
  const n = Math.round(seconds * MOCK_RATE)
  const data = Buffer.alloc(44 + n * 2)
  data.write('RIFF', 0)
  data.writeUInt32LE(36 + n * 2, 4)
  data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16)
  data.writeUInt16LE(1, 20)
  data.writeUInt16LE(1, 22)
  data.writeUInt32LE(MOCK_RATE, 24)
  data.writeUInt32LE(MOCK_RATE * 2, 28)
  data.writeUInt16LE(2, 32)
  data.writeUInt16LE(16, 34)
  data.write('data', 36)
  data.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const t = i / MOCK_RATE
    const env = Math.max(0, Math.sin(Math.PI * MOCK_SYLLABLE_HZ * t)) ** 2
    data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * t) * env * 12_000), 44 + i * 2)
  }
  return { audio: data, mime: 'audio/wav' }
}
