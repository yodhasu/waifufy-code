import React from 'react'
import { AbsoluteFill, OffthreadVideo, interpolate, staticFile, useCurrentFrame, useVideoConfig, spring } from 'remotion'
import { C, MARU, MINCHO, MONO, Petals, Phone, Sky, Title, Window, clamp, ease } from './kit'

/** Where each clip starts in the clean recordings, in seconds (from build/pv/clean-*.json). */
export type Cut = { file: string; at: number; rate?: number; zoom?: { s: number; x: number; y: number } }

const Clip: React.FC<{ cut: Cut }> = ({ cut }) => {
  const { fps } = useVideoConfig()
  const f = useCurrentFrame()
  const z = cut.zoom
  const s = z ? interpolate(f, [0, 80], [1, z.s], { ...clamp, easing: ease }) : 1
  return (
    <AbsoluteFill style={{ transform: `scale(${s})`, transformOrigin: z ? `${z.x * 100}% ${z.y * 100}%` : 'center' }}>
      <OffthreadVideo src={staticFile(cut.file)} trimBefore={Math.round(cut.at * fps)} playbackRate={cut.rate ?? 1} muted style={{ width: '100%', height: '100%' }} />
    </AbsoluteFill>
  )
}

/** A whip in from the right and a push out: every feature scene moves the same way. */
const Shell: React.FC<{ len: number; children: React.ReactNode; warm?: number }> = ({ len, children, warm }) => {
  const f = useCurrentFrame()
  const inP = interpolate(f, [0, 9], [0, 1], { ...clamp, easing: ease })
  const outP = interpolate(f, [len - 6, len], [0, 1], clamp)
  return (
    <AbsoluteFill>
      <Sky warm={warm} />
      <AbsoluteFill style={{
        transform: `translateX(${(1 - inP) * 260 - outP * 200}px) scale(${1 + outP * 0.06})`,
        filter: `blur(${(1 - inP) * 14 + outP * 10}px)`, opacity: Math.min(inP * 1.5, 1 - outP),
      }}>
        {children}
      </AbsoluteFill>
    </AbsoluteFill>
  )
}

const Tilted: React.FC<{ children: React.ReactNode; ry?: number; x: number; y: number; delay?: number }> = ({ children, ry = -10, x, y, delay = 0 }) => {
  const f = useCurrentFrame()
  const drift = interpolate(f, [0, 90], [0, 4])
  return (
    <div style={{ position: 'absolute', left: x, top: y, perspective: 2000 }}>
      <div style={{ transform: `rotateY(${ry + drift}deg)`, transformOrigin: 'center' }}>{children}</div>
    </div>
  )
}

// ---------------------------------------------------------------- work mode

export const Work: React.FC<{ len: number; cut: Cut }> = ({ len, cut }) => (
  <Shell len={len}>
    <Tilted x={620} y={150} ry={-12}>
      <Window w={1200}><Clip cut={cut} /></Window>
    </Tilted>
    <div style={{ position: 'absolute', left: 100, top: 330, width: 560 }}>
      <Title kicker="WORK MODE" title="The real Claude Code." sub="Every tool, subagent and MCP server. She just narrates it." size={70} />
    </div>
  </Shell>
)

// ---------------------------------------------------------------- the refusal

export const Refuse: React.FC<{ len: number; cut: Cut }> = ({ len, cut }) => {
  const f = useCurrentFrame()
  const { fps } = useVideoConfig()
  const ping = spring({ frame: f - 22, fps, config: { damping: 8, stiffness: 200 } })
  return (
    <Shell len={len}>
      <Tilted x={70} y={170} ry={10}>
        <Window w={1080}><Clip cut={cut} /></Window>
      </Tilted>
      <div style={{ position: 'absolute', right: 80, top: 300, width: 540 }}>
        <Title kicker="MID-TASK?" title="She won't let you slack off." sub="Try switching to chat while she works. She'll ask you to wait. Keep pushing and it costs affection." size={64} />
        <div style={{
          marginTop: 30, display: 'inline-flex', gap: 10, alignItems: 'center', font: `700 28px ${MONO}`, color: C.night, background: C.pink,
          padding: '10px 20px', borderRadius: 12, transform: `scale(${ping})`, opacity: ping,
        }}>♥ affection −1</div>
      </div>
    </Shell>
  )
}

// ---------------------------------------------------------------- casual mode: desktop and phone together

export const Casual: React.FC<{ len: number; desk: Cut; phone: Cut }> = ({ len, desk, phone }) => {
  const f = useCurrentFrame()
  const { fps } = useVideoConfig()
  const ph = spring({ frame: f - 8, fps, config: { damping: 15, stiffness: 120 } })
  return (
    <Shell len={len} warm={0.6}>
      <Petals n={14} seed="cas" />
      <div style={{ position: 'absolute', top: 70, width: '100%' }}>
        <Title kicker="WORK DONE?" title="Casual mode. She just talks." sub="Her own chat harness, on GPT or Claude. Same memory of everything you did." align="center" size={70} />
      </div>
      <Tilted x={150} y={350} ry={8}>
        <Window w={1060}><Clip cut={desk} /></Window>
      </Tilted>
      <div style={{ position: 'absolute', left: 1330, top: 300, transform: `translateY(${(1 - ph) * 500}px) rotate(${(1 - ph) * 8 + 3}deg)` }}>
        <Phone h={700}><Clip cut={phone} /></Phone>
      </div>
      <Tag text="desktop" x={180} y={1000} />
      <Tag text="android" x={1420} y={1030} />
    </Shell>
  )
}

const Tag: React.FC<{ text: string; x: number; y: number }> = ({ text, x, y }) => (
  <div style={{ position: 'absolute', left: x, top: y, font: `600 22px ${MONO}`, letterSpacing: '.25em', color: C.blue }}>{text.toUpperCase()}</div>
)

// ---------------------------------------------------------------- memory

export const Memory: React.FC<{ len: number; cut: Cut }> = ({ len, cut }) => {
  const f = useCurrentFrame()
  const card = (d: number) => interpolate(f, [d, d + 12], [0, 1], { ...clamp, easing: ease })
  return (
    <Shell len={len}>
      <div style={{ position: 'absolute', left: 260, top: 110 }}>
        <Phone h={820}><Clip cut={cut} /></Phone>
      </div>
      <div style={{ position: 'absolute', left: 860, top: 230, width: 900 }}>
        <Title kicker="LONG-TERM MEMORY" title="She remembers." sub="Who you are, what you told her, what works with you. Looked up locally, for free." size={84} />
        {[
          ['fact', 'Mia is your sister'],
          ['fact', 'Mia visits this weekend'],
          ['moment', 'A long day. I made tea.'],
        ].map(([k, v], i) => (
          <div key={v} style={{
            marginTop: i ? 14 : 40, display: 'flex', gap: 16, alignItems: 'center', padding: '16px 24px', borderRadius: 14, width: 620,
            background: 'rgba(158,192,255,.1)', border: '1px solid rgba(158,192,255,.3)', opacity: card(18 + i * 8),
            transform: `translateX(${(1 - card(18 + i * 8)) * 80}px)`,
          }}>
            <span style={{ font: `600 18px ${MONO}`, color: C.pink, letterSpacing: '.2em', width: 90 }}>{k.toUpperCase()}</span>
            <span style={{ font: `500 30px ${MARU}`, color: C.ink }}>{v}</span>
          </div>
        ))}
      </div>
    </Shell>
  )
}

// ---------------------------------------------------------------- feelings

const FEELINGS = [
  ['joy', '#ffd36b'],
  ['sadness', '#7fb2ff'],
  ['anger', '#ff6b8b'],
  ['surprise', '#c49bff'],
  ['fear', '#7ee0c6'],
] as const

export const Feelings: React.FC<{ len: number; cut: Cut }> = ({ len, cut }) => {
  const f = useCurrentFrame()
  const { fps } = useVideoConfig()
  return (
    <Shell len={len} warm={1}>
      <Tilted x={460} y={190} ry={0}>
        <Window w={1000}><Clip cut={cut} /></Window>
      </Tilted>
      <div style={{ position: 'absolute', top: 60, width: '100%' }}>
        <Title title="Feelings that change with you." align="center" size={68} />
      </div>
      {FEELINGS.map(([name, color], i) => {
        const p = spring({ frame: f - 6 - i * 4, fps, config: { damping: 12, stiffness: 140 } })
        const joy = name === 'joy' ? interpolate(f, [24, 44], [1, 1.5], { ...clamp, easing: ease }) : 1
        const side = i < 3 ? -1 : 1
        const x = i < 3 ? 150 : 1560
        const y = i < 3 ? 280 + i * 210 : 380 + (i - 3) * 230
        return (
          <div key={name} style={{
            position: 'absolute', left: x, top: y, width: 200, textAlign: 'center', opacity: p,
            transform: `translateX(${(1 - p) * side * 120}px) translateY(${Math.sin((f + i * 20) / 14) * 8}px)`,
          }}>
            <div style={{
              width: 92 * joy, height: 92 * joy, margin: '0 auto', borderRadius: 999,
              background: `radial-gradient(circle at 35% 35%, #fff, ${color} 55%, ${color}00 75%)`, boxShadow: `0 0 ${40 * joy}px ${color}`,
            }} />
            <div style={{ font: `600 22px ${MONO}`, color: C.ink, letterSpacing: '.2em', marginTop: 10 }}>{name.toUpperCase()}</div>
          </div>
        )
      })}
      <div style={{ position: 'absolute', bottom: 46, width: '100%', textAlign: 'center', font: `500 30px ${MARU}`, color: C.dim }}>
        Never shown as numbers. Only in her face, her voice and her words.
      </div>
    </Shell>
  )
}

