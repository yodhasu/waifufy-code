// Affection: points she earns from your praise and headpats, and loses (one at a time) to unkind words.
// Hearts are levels; each one costs AFFECTION_STEP more points than the last, so she warms up slower and
// slower. Shared by the link (the persona note) and the app (the hearts, the saves list).

/** Hearts on the gauge. */
export const AFFECTION_LEVELS = 5
/** The first heart costs this many points, the second twice as many, and so on. */
export const AFFECTION_STEP = 3

/** Points at which `level` hearts are full: 0, 3, 9, 18, 30, 45. */
export const levelStart = (level: number) => (AFFECTION_STEP * level * (level + 1)) / 2
export const AFFECTION_MAX_POINTS = levelStart(AFFECTION_LEVELS)

export const clampPoints = (points: number) => Math.max(0, Math.min(AFFECTION_MAX_POINTS, Math.round(points) || 0))

export function levelOf(points: number) {
  const p = clampPoints(points)
  let level = 0
  while (level < AFFECTION_LEVELS && p >= levelStart(level + 1)) level++
  return level
}

/** The level, and how far into the next heart: `into` of `need` points (both 0 at the top). */
export function affectionProgress(points: number) {
  const p = clampPoints(points)
  const level = levelOf(p)
  if (level >= AFFECTION_LEVELS) return { level, into: 0, need: 0 }
  return { level, into: p - levelStart(level), need: levelStart(level + 1) - levelStart(level) }
}

/** Her reply opens with one of these when your message was kind or unkind to her; the link removes them. */
export const AFFECTION_TAGS = { 'affection+': 1, 'affection-': -1 } as const
export type AffectionTag = keyof typeof AFFECTION_TAGS

/** What the app knows about her mood when you send a message; the link turns it into a note for the model. */
export type Mood = {
  level: number
  /** The level moved since the last message: she gets to notice. */
  change?: 'up' | 'down'
  /** The app has been open this long and a rest reminder is due. */
  restAfterMs?: number
}

/** The hidden note that rides in front of a user message. Removed from history and the rewind list. */
export const CONTEXT_TAG = 'waifufy-context'
const CONTEXT_RE = new RegExp(`<${CONTEXT_TAG}>[\\s\\S]*?</${CONTEXT_TAG}>\\s*`, 'g')
export const stripContext = (s: string) => s.replace(CONTEXT_RE, '')

const hours = (ms: number) => {
  const m = Math.round(ms / 60_000)
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`
}

export function moodNote(mood: Mood, you: string): string {
  const lines = [`Affection level: ${mood.level} of ${AFFECTION_LEVELS}.`]
  if (mood.change === 'up') lines.push(`It just rose: you feel closer to ${you}. Let it show a little in this reply.`)
  if (mood.change === 'down') lines.push(`It just fell: what ${you} said stung. Let it show briefly, then carry on as helpfully as ever.`)
  if (mood.restAfterMs) {
    lines.push(
      `${you} has had the app open for ${hours(mood.restAfterMs)}. Somewhere in this reply, add one short, caring rest reminder in your voice that fits the work at hand: a quick stretch, a glass of water, resting their eyes, or a short break before the next big step. One sentence; don't stop or delay the work.`,
    )
  }
  return `<${CONTEXT_TAG}>\n${lines.join('\n')}\n</${CONTEXT_TAG}>`
}

/** A Mood from the wire, or undefined when it is not one. */
export function asMood(v: unknown): Mood | undefined {
  if (!v || typeof v !== 'object') return undefined
  const m = v as Record<string, unknown>
  if (typeof m.level !== 'number' || !Number.isFinite(m.level)) return undefined
  return {
    level: Math.max(0, Math.min(AFFECTION_LEVELS, Math.round(m.level))),
    ...(m.change === 'up' || m.change === 'down' ? { change: m.change } : {}),
    ...(typeof m.restAfterMs === 'number' && m.restAfterMs > 0 ? { restAfterMs: m.restAfterMs } : {}),
  }
}
