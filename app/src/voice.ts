// Her voice in the page (docs/research/rem-voice.md): clips come from the link (Fish Audio, key kept there),
// are decoded with Web Audio so their exact length is known before they play, and expose their progress (the
// typewriter follows it) and their loudness (her mouth follows it).

import type { ServerMsg } from '../../link/src/protocol.ts'
import type { Link, Store } from './contracts'

const CLIP_TIMEOUT_MS = 30_000
const ANALYSER_SIZE = 512
/** RMS of speech sits around 0.05–0.25: this gain puts a normal syllable near a full mouth. */
const LEVEL_GAIN = 4.5
/** Settings' volume 80 plays the clip as it came. */
const VOLUME_UNITY = 80

export type Playback = {
  /** 0 → 1 through the clip, by the audio clock. */
  progress(): number
  /** Loudness right now, 0 → 1. */
  level(): number
  readonly duration: number
  ended(): boolean
  /** Runs once the clip ends or is stopped (at once if it already has). */
  onEnd(fn: () => void): void
  stop(): void
}

export type Voice = {
  hasKey(): boolean
  /** On, a key stored, and a voice picked: her lines are spoken. */
  active(): boolean
  /** Calls `fn` when the key is stored or removed. */
  onChange(fn: () => void): () => void
  setKey(key: string): void
  /** One decoded clip for `text`; rejects with the link's reason. */
  clip(text: string): Promise<AudioBuffer>
  play(clip: AudioBuffer): Playback
}

let seq = 0

export function createVoice(link: Link, store: Store, hasKeyAtStart: boolean): Voice {
  let hasKey = hasKeyAtStart
  const subs = new Set<() => void>()
  let ctx: AudioContext | undefined

  link.on((m: ServerMsg) => {
    if (m.t !== 'voice_key') return
    hasKey = m.has
    for (const fn of subs) fn()
  })

  const audio = () => {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  }
  // Autoplay rules want a gesture first; any key or tap in the app counts. The context is made on that first gesture
  // too, not when the first clip arrives: one made outside a gesture can start suspended (a phone's WebView).
  for (const ev of ['pointerdown', 'keydown'] as const) addEventListener(ev, () => void audio(), { capture: true, passive: true })

  return {
    hasKey: () => hasKey,
    active() {
      const v = store.get().voice
      return hasKey && v.enabled && v.voiceId.trim() !== ''
    },
    onChange(fn) {
      subs.add(fn)
      return () => void subs.delete(fn)
    },
    setKey(key) {
      link.send({ t: 'voice_key', key })
    },
    async clip(text) {
      const id = `tts-${++seq}`
      type Reply = Extract<ServerMsg, { t: 'tts' }>
      const reply = link.next((m): m is Reply => m.t === 'tts' && m.id === id, CLIP_TIMEOUT_MS)
      link.send({ t: 'tts', id, text })
      const m = await reply
      if (!m.audio) throw new Error(m.error ?? 'No audio came back.')
      const bytes = Uint8Array.from(atob(m.audio), (c) => c.charCodeAt(0))
      return audio().decodeAudioData(bytes.buffer)
    },
    play(clip) {
      const ac = audio()
      const src = ac.createBufferSource()
      src.buffer = clip
      const gain = ac.createGain()
      gain.gain.value = Math.max(0, store.get().voice.volume) / VOLUME_UNITY
      const analyser = ac.createAnalyser()
      analyser.fftSize = ANALYSER_SIZE
      src.connect(gain).connect(analyser).connect(ac.destination)
      const samples = new Float32Array(ANALYSER_SIZE)
      const startAt = ac.currentTime
      let isEnded = false
      const ends: (() => void)[] = []
      const end = () => {
        if (isEnded) return
        isEnded = true
        for (const fn of ends.splice(0)) fn()
      }
      src.onended = end
      src.start()
      return {
        duration: clip.duration,
        progress: () => (isEnded ? 1 : Math.min(1, Math.max(0, (ac.currentTime - startAt) / clip.duration))),
        level() {
          if (isEnded) return 0
          analyser.getFloatTimeDomainData(samples)
          let sum = 0
          for (const s of samples) sum += s * s
          return Math.min(1, Math.sqrt(sum / samples.length) * LEVEL_GAIN)
        },
        ended: () => isEnded,
        onEnd(fn) {
          if (isEnded) fn()
          else ends.push(fn)
        },
        stop() {
          if (isEnded) return
          try {
            src.stop()
          } catch {
            // Never started or already stopped.
          }
          end()
        },
      }
    },
  }
}
