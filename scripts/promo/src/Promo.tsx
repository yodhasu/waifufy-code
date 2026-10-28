import React from 'react'
import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion'
import { Casual, Feelings, Memory, Refuse, Work, type Cut } from './features'
import { End, Hook, Then, Timeline, Wipe } from './scenes'
import { CUTS } from './cuts'

/** The story, in frames at 30 fps. gen-audio.mjs hits these same times. */
const S = [
  ['hook', 0, 90],
  ['then', 90, 120],
  ['timeline', 210, 120],
  ['wipe', 330, 90],
  ['work', 420, 72],
  ['refuse', 492, 72],
  ['casual', 564, 84],
  ['memory', 648, 72],
  ['feelings', 720, 60],
  ['end', 780, 120],
] as const
export const DURATION = 900

const at = (name: string) => S.find((s) => s[0] === name)!

export const Promo: React.FC = () => {
  const seq = (name: string, el: (len: number) => React.ReactNode) => {
    const [, from, len] = at(name)
    return <Sequence key={name} from={from} durationInFrames={len} name={name}>{el(len)}</Sequence>
  }
  return (
    <AbsoluteFill style={{ background: '#05070f' }}>
      {seq('hook', () => <Hook />)}
      {seq('then', () => <Then />)}
      {seq('timeline', () => <Timeline />)}
      {seq('wipe', () => <Wipe now="now-desktop.png" phone="now-phone.png" />)}
      {seq('work', (len) => <Work len={len} cut={CUTS.work as Cut} />)}
      {seq('refuse', (len) => <Refuse len={len} cut={CUTS.refuse as Cut} />)}
      {seq('casual', (len) => <Casual len={len} desk={CUTS.casualDesk as Cut} phone={CUTS.casualPhone as Cut} />)}
      {seq('memory', (len) => <Memory len={len} cut={CUTS.memory as Cut} />)}
      {seq('feelings', (len) => <Feelings len={len} cut={CUTS.feelings as Cut} />)}
      {seq('end', () => <End />)}
      <Audio src={staticFile('music.wav')} />
    </AbsoluteFill>
  )
}
