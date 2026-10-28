// Synthesizes the promo's 30 s soundtrack into public/music.wav: a pad that follows the story, a beat under the
// feature montage, and hits timed to the cuts in src/Promo.tsx. Deterministic (seeded noise).
import { writeFileSync } from 'node:fs'

const SR = 44100
const LEN = 30
const N = SR * LEN
const L = new Float32Array(N)
const R = new Float32Array(N)

let seed = 7
const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x3fffffff) - 1
const hz = (n) => 440 * 2 ** ((n - 69) / 12)
const add = (i, l, r = l) => { if (i >= 0 && i < N) { L[i] += l; R[i] += r } }

/** A soft pad chord (MIDI notes) from t0 to t1. */
function pad(notes, t0, t1, vol = 0.05, atk = 0.6, rel = 0.8) {
  const a = Math.floor(t0 * SR), b = Math.floor((t1 + rel) * SR)
  for (const n of notes) {
    const f = hz(n)
    for (let i = a; i < b; i++) {
      const t = (i - a) / SR
      const env = Math.min(1, t / atk) * (i / SR > t1 ? Math.max(0, 1 - (i / SR - t1) / rel) : 1)
      const ph = 2 * Math.PI * f * t
      const s = Math.sin(ph) + 0.3 * Math.sin(2 * ph) + 0.12 * Math.sin(3 * ph)
      const trem = 1 + 0.08 * Math.sin(2 * Math.PI * 0.25 * t)
      add(i, s * env * vol * trem * (1 + 0.002 * Math.sin(ph * 0.003)), Math.sin(ph * 1.003) * env * vol * trem + 0.3 * Math.sin(2 * ph * 1.002) * env * vol)
    }
  }
}

function kick(t, vol = 0.55) {
  const a = Math.floor(t * SR)
  let ph = 0
  for (let k = 0; k < SR * 0.35; k++) {
    const tt = k / SR
    ph += (2 * Math.PI * (45 + 90 * Math.exp(-tt * 30))) / SR
    add(a + k, Math.sin(ph) * Math.exp(-tt * 9) * vol)
  }
}

function hat(t, vol = 0.05) {
  const a = Math.floor(t * SR)
  let prev = 0
  for (let k = 0; k < SR * 0.05; k++) {
    const x = noise(), hp = x - prev
    prev = x
    add(a + k, hp * Math.exp(-k / SR * 90) * vol)
  }
}

/** Filtered noise whose brightness and loudness swell and fall: a whoosh (or a long riser). */
function whoosh(t, dur = 0.5, vol = 0.25, rise = false) {
  const a = Math.floor(t * SR), n = Math.floor(dur * SR)
  let y = 0
  for (let k = 0; k < n; k++) {
    const p = k / n
    const env = rise ? p ** 2.2 : Math.sin(Math.PI * p) ** 1.5
    const cut = rise ? 0.02 + 0.5 * p ** 2 : 0.05 + 0.35 * Math.sin(Math.PI * p)
    y += cut * (noise() - y)
    const pan = rise ? 0 : Math.sin(Math.PI * 2 * p) * 0.6
    add(a + k, y * env * vol * (1 - pan), y * env * vol * (1 + pan))
  }
}

function boom(t, vol = 0.7) {
  const a = Math.floor(t * SR)
  let y = 0
  for (let k = 0; k < SR * 2.2; k++) {
    const tt = k / SR
    y += 0.08 * (noise() - y)
    add(a + k, Math.sin(2 * Math.PI * (38 + 30 * Math.exp(-tt * 6)) * tt) * Math.exp(-tt * 2.2) * vol + y * Math.exp(-tt * 5) * vol * 0.8)
  }
}

function blip(t, f = 1320, vol = 0.12, dur = 0.25) {
  const a = Math.floor(t * SR)
  for (let k = 0; k < SR * dur; k++) {
    const tt = k / SR
    add(a + k, (Math.sin(2 * Math.PI * f * tt) + 0.4 * Math.sin(2 * Math.PI * f * 2 * tt)) * Math.exp(-tt * 14) * vol)
  }
}

function chime(t, notes, vol = 0.07) {
  notes.forEach((n, j) => {
    const a = Math.floor((t + j * 0.07) * SR), f = hz(n)
    for (let k = 0; k < SR * 2.5; k++) {
      const tt = k / SR
      const s = Math.sin(2 * Math.PI * f * tt) * Math.exp(-tt * 2.2) * vol
      add(a + k, s * (j % 2 ? 0.6 : 1), s * (j % 2 ? 1 : 0.6))
    }
  })
}

// ---- the story (keep in step with src/Promo.tsx)
const CRACK = 44 / 30
// Cold: a low hum under the terminal, a riser into the crack.
pad([29, 36], 0, CRACK, 0.03, 0.2, 0.1)
whoosh(0.25, CRACK - 0.25, 0.35, true)
boom(CRACK, 0.75)
chime(CRACK + 0.05, [77, 81, 84, 88], 0.05)
// Then and the timeline: warm, hopeful.
pad([53, 57, 60, 64], CRACK, 7, 0.045)
whoosh(2.95, 0.45, 0.22)
boom(4.0, 0.35)
pad([45, 52, 57, 60, 64], 7, 11.1, 0.045)
whoosh(6.95, 0.45, 0.22)
;[0, 1, 2, 3, 4, 5].forEach((i) => blip((210 + 8 + i * 14) / 30, hz(76 + [0, 2, 4, 7, 9, 12][i]), i === 5 ? 0.16 : 0.1, i === 5 ? 0.6 : 0.25))
// The wipe: a build.
pad([46, 53, 58, 62, 65], 11.1, 14, 0.05)
whoosh(11.1, 1.1, 0.3)
whoosh(12.35, 0.4, 0.18)
for (let b = 12; b < 14; b += 0.25) hat(b, 0.02 + (b - 12) * 0.015)
// The montage: a beat at 120 bpm.
const prog = [[50, 57, 62, 65], [46, 53, 58, 62], [41, 48, 57, 60], [48, 55, 60, 64]]
for (let i = 0; i < 6; i++) pad(prog[i % 4], 14 + i * 2, 16 + i * 2, 0.04, 0.05, 0.3)
for (let b = 14; b < 26; b += 0.5) { kick(b, 0.45); hat(b + 0.25, 0.05) }
;[14, 16.4, 18.8, 21.6, 24].forEach((t) => whoosh(t - 0.12, 0.42, 0.25))
blip(17.13, 660, 0.14, 0.35)
blip(17.2, 523, 0.12, 0.35)
chime(24.8, [84, 88, 91], 0.05)
// The end: one hit, then light.
boom(26, 0.8)
pad([41, 48, 53, 57, 60, 67], 26, 29.2, 0.05, 0.05, 0.8)
chime(26.05, [77, 81, 84, 88, 91], 0.06)

// ---- master: gentle limiter, fade out, 16-bit WAV
const out = Buffer.alloc(44 + N * 4)
out.write('RIFF', 0); out.writeUInt32LE(36 + N * 4, 4); out.write('WAVE', 8); out.write('fmt ', 12)
out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(2, 22); out.writeUInt32LE(SR, 24)
out.writeUInt32LE(SR * 4, 28); out.writeUInt16LE(4, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(N * 4, 40)
for (let i = 0; i < N; i++) {
  const fade = Math.min(1, (LEN - i / SR) / 0.8)
  out.writeInt16LE(Math.round(Math.tanh(L[i] * 1.2) * fade * 30000), 44 + i * 4)
  out.writeInt16LE(Math.round(Math.tanh(R[i] * 1.2) * fade * 30000), 46 + i * 4)
}
writeFileSync(new URL('./public/music.wav', import.meta.url), out)
console.log('wrote public/music.wav')
