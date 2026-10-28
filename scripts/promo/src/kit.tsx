import { loadFont as loadMincho } from '@remotion/google-fonts/ShipporiMincho'
import { loadFont as loadMaru } from '@remotion/google-fonts/ZenMaruGothic'
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono'
import React from 'react'
import { AbsoluteFill, interpolate, random, spring, useCurrentFrame, useVideoConfig, Easing } from 'remotion'

export const MINCHO = loadMincho('normal', { weights: ['600', '800'], subsets: ['latin'] }).fontFamily
export const MARU = loadMaru('normal', { weights: ['500', '700'], subsets: ['latin'] }).fontFamily
export const MONO = loadMono('normal', { weights: ['400', '600'], subsets: ['latin'] }).fontFamily

export const C = {
  night: '#05070f',
  navy: '#0b1230',
  blue: '#9ec0ff',
  deep: '#4a6fd8',
  pink: '#ff9ccf',
  ink: '#eef2ff',
  dim: 'rgba(238,242,255,.62)',
}

export const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
export const ease = Easing.bezier(0.16, 1, 0.3, 1)

/** 0→1 spring from `delay` frames. */
export function useIn(delay = 0, config = { damping: 200 }, durationInFrames?: number) {
  const f = useCurrentFrame()
  const { fps } = useVideoConfig()
  return spring({ frame: f - delay, fps, config, durationInFrames })
}

/** Fades the whole scene out over its last `n` frames. */
export function useOut(total: number, n = 8) {
  const f = useCurrentFrame()
  return interpolate(f, [total - n, total], [1, 0], clamp)
}

/** Night sky: a deep gradient, slow light shafts, a soft vignette. */
export const Sky: React.FC<{ warm?: number }> = ({ warm = 0 }) => {
  const f = useCurrentFrame()
  return (
    <AbsoluteFill style={{ background: `radial-gradient(ellipse 70% 60% at 50% 40%, ${warm ? '#1c2a6b' : '#141d4a'} 0%, ${C.navy} 45%, ${C.night} 100%)` }}>
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          style={{
            position: 'absolute', top: -200, left: 300 + i * 380 + Math.sin((f + i * 40) / 70) * 40, width: 140, height: 1600,
            background: 'linear-gradient(180deg, rgba(158,192,255,.16), transparent 70%)', transform: 'rotate(18deg)', filter: 'blur(18px)',
          }}
        />
      ))}
      <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 50%, transparent 55%, rgba(0,0,0,.65) 100%)` }} />
      {warm > 0 && <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 45%, rgba(255,156,207,${0.18 * warm}), transparent 60%)` }} />}
    </AbsoluteFill>
  )
}

/** Drifting petals, deterministic per seed. */
export const Petals: React.FC<{ n?: number; seed?: string; speed?: number; burst?: number }> = ({ n = 26, seed = 'p', speed = 1, burst }) => {
  const f = useCurrentFrame()
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {Array.from({ length: n }, (_, i) => {
        const r = (k: string) => random(`${seed}-${i}-${k}`)
        let x: number, y: number, o: number
        if (burst !== undefined) {
          // Out from the centre from frame `burst`.
          const t = Math.max(0, f - burst)
          const a = r('a') * Math.PI * 2
          const v = 9 + r('v') * 22
          x = 960 + Math.cos(a) * v * t
          y = 540 + Math.sin(a) * v * t + 0.25 * t * t
          o = interpolate(t, [0, 4, 40], [0, 1, 0], clamp)
        } else {
          x = (r('x') * 2200 - 140 + f * (0.6 + r('s')) * speed * 1.4) % 2100 - 90
          y = (r('y') * 1300 + f * (0.9 + r('d')) * speed * 1.6) % 1200 - 60
          o = 0.35 + r('o') * 0.5
        }
        const s = 10 + r('z') * 16
        return (
          <div key={i} style={{
            position: 'absolute', left: x, top: y, width: s, height: s * 0.62, opacity: o,
            background: 'linear-gradient(135deg, #ffe3f1, #ffb3d9)', borderRadius: '100% 0 100% 0',
            transform: `rotate(${f * (2 + r('r') * 4) + r('q') * 360}deg)`, boxShadow: '0 0 12px rgba(255,180,220,.6)',
          }} />
        )
      })}
    </AbsoluteFill>
  )
}

/** Words that rise in one after another, blurred to sharp. */
export const Words: React.FC<{ text: string; delay?: number; gap?: number; style?: React.CSSProperties; accent?: string[] }> = ({ text, delay = 0, gap = 3, style, accent = [] }) => {
  const f = useCurrentFrame()
  const { fps } = useVideoConfig()
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '0 .28em', ...style }}>
      {text.split(' ').map((w, i) => {
        const p = spring({ frame: f - delay - i * gap, fps, config: { damping: 14, stiffness: 160, mass: 0.6 } })
        return (
          <span key={i} style={{
            display: 'inline-block', opacity: Math.min(1, p * 1.4), transform: `translateY(${(1 - p) * 60}px) scale(${0.85 + 0.15 * p})`,
            filter: `blur(${(1 - Math.min(1, p)) * 12}px)`, color: accent.includes(w.replace(/[.,?…!]/g, '')) ? C.pink : undefined,
          }}>{w}</span>
        )
      })}
    </div>
  )
}

/** A desktop window: dark chrome bar and rounded corners around its content. */
export const Window: React.FC<{ w: number; children: React.ReactNode; title?: string; style?: React.CSSProperties }> = ({ w, children, title = 'Waifufy Code', style }) => (
  <div style={{
    width: w, borderRadius: 18, overflow: 'hidden', background: '#0a0f24', border: '1px solid rgba(158,192,255,.28)',
    boxShadow: '0 40px 120px rgba(0,0,0,.6), 0 0 80px rgba(74,111,216,.25)', ...style,
  }}>
    <div style={{ height: 34, display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px', background: 'linear-gradient(#141b3b,#0e1430)' }}>
      {['#ff6b8b', '#ffd36b', '#7ee0a6'].map((c) => <i key={c} style={{ width: 11, height: 11, borderRadius: 6, background: c, opacity: 0.85 }} />)}
      <span style={{ marginLeft: 10, font: `500 14px ${MARU}`, color: C.dim }}>{title}</span>
    </div>
    <div style={{ width: w, height: (w * 9) / 16, position: 'relative', overflow: 'hidden' }}>{children}</div>
  </div>
)

/** A phone: a thick rounded bezel around 9:16 content. */
export const Phone: React.FC<{ h: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ h, children, style }) => {
  const w = (h * 9) / 16
  return (
    <div style={{
      width: w + 24, height: h + 24, padding: 12, borderRadius: 54, background: 'linear-gradient(145deg,#2a3150,#0b0f20)',
      boxShadow: '0 40px 120px rgba(0,0,0,.65), 0 0 0 2px rgba(158,192,255,.25), 0 0 70px rgba(255,156,207,.18)', ...style,
    }}>
      <div style={{ width: w, height: h, borderRadius: 44, overflow: 'hidden', position: 'relative', background: '#000' }}>
        {children}
        <div style={{ position: 'absolute', top: 12, left: '50%', width: 90, height: 24, marginLeft: -45, borderRadius: 14, background: '#000' }} />
      </div>
    </div>
  )
}

/** A headline with a small kicker above and a sub line below; slides in from the side. */
export const Title: React.FC<{ kicker?: string; title: string; sub?: string; align?: 'left' | 'center'; delay?: number; size?: number }> = ({ kicker, title, sub, align = 'left', delay = 0, size = 76 }) => {
  const p = useIn(delay, { damping: 18, stiffness: 140 } as never)
  const q = useIn(delay + 6, { damping: 200 })
  return (
    <div style={{ textAlign: align, color: C.ink }}>
      {kicker && (
        <div style={{ font: `600 22px ${MONO}`, letterSpacing: '.3em', color: C.pink, opacity: q, transform: `translateX(${(1 - q) * -30}px)`, marginBottom: 14 }}>
          {kicker}
        </div>
      )}
      <div style={{ font: `800 ${size}px/1.05 ${MINCHO}`, letterSpacing: '.01em', opacity: p, transform: `translateX(${(1 - p) * -60}px)`, textShadow: '0 6px 40px rgba(74,111,216,.6)' }}>
        {title}
      </div>
      {sub && <div style={{ font: `500 30px/1.35 ${MARU}`, color: C.dim, marginTop: 16, opacity: q }}>{sub}</div>}
    </div>
  )
}

/** A flash of white light, peaking at `at`. */
export const Flash: React.FC<{ at: number; len?: number; color?: string; peak?: number }> = ({ at, len = 10, color = '#fff', peak = 0.85 }) => {
  const f = useCurrentFrame()
  const o = interpolate(f, [at - 2, at, at + len], [0, peak, 0], clamp)
  return <AbsoluteFill style={{ background: color, opacity: o, mixBlendMode: 'screen', pointerEvents: 'none' }} />
}
