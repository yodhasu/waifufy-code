import React from 'react'
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig, spring } from 'remotion'
import { C, MARU, MINCHO, MONO, Petals, Sky, Title, Words, Window, Flash, clamp, ease, useIn, useOut } from './kit'

// ---------------------------------------------------------------- 1. hook: a cold terminal cracks open

const TYPED = 'fix the failing tests'

export const Hook: React.FC = () => {
  const f = useCurrentFrame()
  const crack = 44
  const chars = Math.floor(interpolate(f, [6, 34], [0, TYPED.length], clamp))
  const shake = f > crack - 8 && f < crack ? Math.sin(f * 9) * (f - (crack - 8)) * 1.6 : 0
  const termOut = interpolate(f, [crack, crack + 8], [1, 0], clamp)
  const termScale = interpolate(f, [0, crack, crack + 8], [0.96, 1.02, 1.5], clamp)
  const out = useOut(90, 6)
  return (
    <AbsoluteFill style={{ background: '#030409', opacity: out }}>
      {f >= crack && <Sky warm={interpolate(f, [crack, crack + 20], [0, 1], clamp)} />}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: termOut }}>
        <div style={{
          width: 980, padding: '34px 40px', borderRadius: 14, background: '#0b0d12', border: '1px solid #262a33',
          transform: `translateX(${shake}px) scale(${termScale})`, boxShadow: '0 30px 90px rgba(0,0,0,.8)',
          filter: f > crack - 6 ? `drop-shadow(${(f % 2 ? 6 : -6)}px 0 0 rgba(255,60,120,.7)) drop-shadow(${(f % 2 ? -6 : 6)}px 0 0 rgba(60,200,255,.7))` : undefined,
        }}>
          <div style={{ font: `400 22px ${MONO}`, color: '#6b7280', marginBottom: 18 }}>~/project $ claude</div>
          <div style={{ font: `600 46px ${MONO}`, color: '#d1d5db' }}>
            <span style={{ color: '#9ca3af' }}>› </span>{TYPED.slice(0, chars)}
            <span style={{ opacity: Math.floor(f / 8) % 2 ? 0 : 1, color: '#d1d5db' }}>▌</span>
          </div>
        </div>
      </AbsoluteFill>
      <Flash at={crack} len={12} />
      <Petals n={60} seed="burst" burst={crack} />
      {f >= crack + 4 && (
        <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', color: C.ink, textShadow: '0 8px 50px rgba(74,111,216,.8)' }}>
          <Words text="What if your terminal" delay={crack + 6} style={{ font: `800 92px/1.1 ${MINCHO}` }} />
          <Words text="had a heart?" delay={crack + 18} gap={4} accent={['heart']} style={{ font: `800 128px/1.1 ${MINCHO}`, marginTop: 10 }} />
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  )
}

// ---------------------------------------------------------------- 2. then: v0

export const Then: React.FC = () => {
  const f = useCurrentFrame()
  const p = useIn(2, { damping: 20, stiffness: 90 } as never)
  const push = interpolate(f, [0, 120], [1, 1.07])
  const out = useOut(120, 8)
  return (
    <AbsoluteFill style={{ opacity: out }}>
      <Sky />
      <AbsoluteFill style={{ perspective: 1800 }}>
        <div style={{
          position: 'absolute', right: 110, top: 200, transform: `rotateY(${-16 + 6 * p}deg) translateX(${(1 - p) * 300}px) scale(${push})`,
          opacity: p, transformOrigin: 'right center',
        }}>
          <Window w={1000} title="Waifufy Code v0 — Oct 24">
            <Img src={staticFile('v0-chat.png')} style={{ width: '100%', height: '100%', objectFit: 'cover', filter: 'saturate(.55) sepia(.18) brightness(.92)' }} />
            <AbsoluteFill style={{ background: 'repeating-linear-gradient(0deg, rgba(0,0,0,.06) 0 2px, transparent 2px 4px)' }} />
          </Window>
        </div>
      </AbsoluteFill>
      <div style={{ position: 'absolute', left: 110, top: 340, width: 700 }}>
        <Title kicker="DAY 1 · v0" title="She started as a skin." sub="A Live2D maid on top of Claude Code. Cute. That was about it." size={72} delay={8} />
      </div>
      <Stamp text="THEN" at={30} x={1440} y={150} />
    </AbsoluteFill>
  )
}

const Stamp: React.FC<{ text: string; at: number; x: number; y: number; color?: string }> = ({ text, at, x, y, color = C.pink }) => {
  const f = useCurrentFrame()
  const { fps } = useVideoConfig()
  const s = spring({ frame: f - at, fps, config: { damping: 9, stiffness: 220, mass: 0.7 } })
  return (
    <div style={{
      position: 'absolute', left: x, top: y, font: `800 54px ${MONO}`, letterSpacing: '.2em', color, border: `5px solid ${color}`, padding: '6px 22px',
      borderRadius: 10, transform: `rotate(-8deg) scale(${interpolate(s, [0, 1], [2.6, 1])})`, opacity: s > 0.02 ? Math.min(1, s * 2) : 0,
      boxShadow: `0 0 40px ${color}55`, background: 'rgba(5,7,15,.55)',
    }}>{text}</div>
  )
}

// ---------------------------------------------------------------- 3. five days, six releases

const NODES = [
  { v: 'v0', d: 'Oct 24', t: 'A VN skin with a Live2D Rem' },
  { v: 'v0.1', d: 'Oct 24', t: 'Real Claude Code underneath' },
  { v: 'v0.5', d: 'Oct 24', t: 'Every panel: rewind, /tasks, MCP' },
  { v: 'v0.5.1', d: 'Oct 25', t: 'Her voice and affection' },
  { v: 'v0.6', d: 'Oct 27', t: 'Your phone, and Slack' },
  { v: 'v0.7', d: 'Oct 29', t: 'Casual mode. Feelings. Memory.' },
]
const STEP = 14
const GAP = 430

export const Timeline: React.FC = () => {
  const f = useCurrentFrame()
  const out = useOut(120, 6)
  // The camera glides right as each node lights.
  const idx = interpolate(f, [8, 8 + STEP * (NODES.length - 1)], [0, NODES.length - 1], { ...clamp, easing: ease })
  const camX = 560 + (idx / (NODES.length - 1)) * 820 - 200 - idx * GAP
  const day = Math.min(5, 1 + Math.floor(interpolate(f, [8, 8 + STEP * 5], [0, 4.999], clamp)))
  const lineW = idx * GAP
  const last = interpolate(f, [8 + STEP * 5, 8 + STEP * 5 + 12], [0, 1], clamp)
  return (
    <AbsoluteFill style={{ opacity: out }}>
      <Sky warm={last} />
      <Petals n={18} seed="tl" speed={2.4} />
      <div style={{ position: 'absolute', top: 120, width: '100%', textAlign: 'center', color: C.ink }}>
        <div style={{ font: `600 24px ${MONO}`, letterSpacing: '.35em', color: C.pink }}>BUILT IN</div>
        <div style={{ font: `800 150px/1 ${MINCHO}`, textShadow: '0 8px 60px rgba(74,111,216,.8)' }}>
          {day} <span style={{ fontSize: 80 }}>day{day > 1 ? 's' : ''}</span>
        </div>
      </div>
      <div style={{ position: 'absolute', top: 600, left: 0, transform: `translateX(${camX}px)` }}>
        <div style={{ position: 'absolute', top: -2, left: 200, width: GAP * (NODES.length - 1), height: 4, background: 'rgba(158,192,255,.15)' }} />
        <div style={{ position: 'absolute', top: -2, left: 200, width: lineW, height: 4, background: `linear-gradient(90deg, ${C.deep}, ${C.blue}, ${C.pink})`, boxShadow: `0 0 24px ${C.blue}` }} />
        {NODES.map((n, i) => {
          const on = interpolate(f, [8 + i * STEP - 4, 8 + i * STEP + 6], [0, 1], clamp)
          const isLast = i === NODES.length - 1
          const sz = isLast ? 46 : 30
          return (
            <div key={n.v} style={{ position: 'absolute', left: 200 + i * GAP, top: 0 }}>
              <div style={{
                position: 'absolute', left: -sz / 2, top: -sz / 2, width: sz, height: sz, borderRadius: sz,
                background: on > 0.5 ? (isLast ? C.pink : C.blue) : '#1a2350', border: `3px solid ${C.blue}`,
                boxShadow: on > 0.5 ? `0 0 ${30 + (isLast ? 40 * last : 0)}px ${isLast ? C.pink : C.blue}` : 'none', transform: `scale(${0.6 + 0.4 * on})`,
              }} />
              <div style={{ position: 'absolute', left: -230, width: 460, top: 50, textAlign: 'center', opacity: 0.25 + 0.75 * on, transform: `translateY(${(1 - on) * 20}px)` }}>
                <div style={{ font: `800 ${isLast ? 76 : 56}px ${MONO}`, color: isLast ? C.pink : C.ink }}>{n.v}</div>
                <div style={{ font: `600 20px ${MONO}`, color: C.dim, letterSpacing: '.2em', marginTop: 4 }}>{n.d.toUpperCase()}</div>
                <div style={{ font: `500 30px/1.3 ${MARU}`, color: C.ink, marginTop: 14 }}>{n.t}</div>
              </div>
            </div>
          )
        })}
      </div>
    </AbsoluteFill>
  )
}

// ---------------------------------------------------------------- 4. then | now: one wipe

export const Wipe: React.FC<{ now: string; phone: string }> = ({ now, phone }) => {
  const f = useCurrentFrame()
  const { fps } = useVideoConfig()
  const x = interpolate(f, [6, 40], [1920, 0], { ...clamp, easing: ease })
  const ph = spring({ frame: f - 44, fps, config: { damping: 16, stiffness: 110 } })
  const out = useOut(90, 6)
  const zoom = interpolate(f, [0, 90], [1.04, 1])
  return (
    <AbsoluteFill style={{ opacity: out, background: C.night }}>
      <AbsoluteFill style={{ transform: `scale(${zoom})` }}>
        <Img src={staticFile('v0-chat.png')} style={{ width: 1920, height: 1080, filter: 'saturate(.55) sepia(.18) brightness(.85)' }} />
        <AbsoluteFill style={{ clipPath: `inset(0 0 0 ${x}px)` }}>
          <Img src={staticFile(now)} style={{ width: 1920, height: 1080 }} />
        </AbsoluteFill>
      </AbsoluteFill>
      <div style={{ position: 'absolute', left: x - 3, top: 0, width: 6, height: 1080, background: '#fff', boxShadow: `0 0 40px 10px ${C.blue}, 0 0 90px 20px ${C.pink}`, opacity: x > 2 && x < 1918 ? 1 : 0 }} />
      <Label text="THEN · v0" x={60} y={50} o={interpolate(x, [200, 600], [0, 1], clamp)} />
      <Label text="NOW · v0.7" x={1500} y={50} o={interpolate(x, [1200, 1700], [1, 0], clamp)} accent />
      <div style={{ position: 'absolute', right: 120, bottom: -40, transform: `translateY(${(1 - ph) * 700}px) rotate(${(1 - ph) * 12 - 4}deg)` }}>
        <PhoneStill src={phone} />
      </div>
    </AbsoluteFill>
  )
}

const Label: React.FC<{ text: string; x: number; y: number; o: number; accent?: boolean }> = ({ text, x, y, o, accent }) => (
  <div style={{
    position: 'absolute', left: x, top: y, opacity: o, font: `800 34px ${MONO}`, letterSpacing: '.18em', color: accent ? C.night : C.ink,
    background: accent ? C.pink : 'rgba(5,7,15,.7)', padding: '10px 22px', borderRadius: 10,
  }}>{text}</div>
)

const PhoneStill: React.FC<{ src: string }> = ({ src }) => (
  <div style={{ width: 400, height: 711 + 24, padding: 12, borderRadius: 54, background: 'linear-gradient(145deg,#2a3150,#0b0f20)', boxShadow: '0 40px 120px rgba(0,0,0,.7), 0 0 0 2px rgba(158,192,255,.35), 0 0 80px rgba(255,156,207,.3)' }}>
    <Img src={staticFile(src)} style={{ width: 376, height: 711 - 24 + 24, borderRadius: 44, objectFit: 'cover' }} />
  </div>
)

// ---------------------------------------------------------------- 6. end card

export const End: React.FC = () => {
  const f = useCurrentFrame()
  const { fps } = useVideoConfig()
  const icon = spring({ frame: f - 4, fps, config: { damping: 11, stiffness: 120 } })
  const glow = 0.6 + 0.4 * Math.sin(f / 9)
  const lineIn = (d: number) => interpolate(f, [d, d + 14], [0, 1], { ...clamp, easing: ease })
  return (
    <AbsoluteFill>
      <Sky warm={1} />
      <Petals n={34} seed="end" />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', color: C.ink }}>
        <Img src={staticFile('icon.png')} style={{
          width: 230, height: 230, transform: `scale(${icon}) rotate(${(1 - icon) * -25}deg)`,
          filter: `drop-shadow(0 0 ${40 * glow}px rgba(158,192,255,.8))`,
        }} />
        <div style={{ font: `800 128px/1 ${MINCHO}`, letterSpacing: '.06em', marginTop: 30, textShadow: '0 8px 60px rgba(74,111,216,.9)' }}>
          <Words text="Waifufy Code" delay={14} gap={6} accent={['Code']} />
        </div>
        <div style={{ font: `500 40px ${MARU}`, marginTop: 26, opacity: lineIn(30), transform: `translateY(${(1 - lineIn(30)) * 20}px)` }}>
          Claude Code, as a visual novel. <span style={{ color: C.pink }}>Now she just talks, too.</span>
        </div>
        <div style={{ display: 'flex', gap: 18, marginTop: 40, opacity: lineIn(44) }}>
          {['v0.7', 'Windows', 'Android', 'Free & open source'].map((t, i) => (
            <span key={t} style={{
              font: `600 26px ${MONO}`, padding: '10px 22px', borderRadius: 999, border: `2px solid ${i ? 'rgba(158,192,255,.5)' : C.pink}`,
              color: i ? C.ink : C.pink, background: 'rgba(5,7,15,.5)', transform: `translateY(${(1 - lineIn(44 + i * 4)) * 30}px)`, opacity: lineIn(44 + i * 4),
            }}>{t}</span>
          ))}
        </div>
        <div style={{ font: `600 34px ${MONO}`, marginTop: 44, padding: '14px 30px', borderRadius: 14, background: 'rgba(158,192,255,.14)', opacity: lineIn(62), color: C.blue }}>
          github.com/yodhasu/waifufy-code
        </div>
      </AbsoluteFill>
      <Flash at={2} len={14} peak={0.45} color="#9ec0ff" />
    </AbsoluteFill>
  )
}

