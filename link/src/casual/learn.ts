// What she does after a quiet spell in casual mode (v0.7): reads the chat since last time and, in one call,
// remembers (facts, an episode in her words, what worked and what didn't) and is judged against a fixed rubric.
// Only below the threshold does a critic revise her style and examples, and the revision is kept only if it wins
// a replay of real messages. Her character card, traits and feelings are never touched: only `Tune` can change.

import { EMOTIONS, type Settings } from '../protocol.ts'
import { addressOf, defaultSettings } from '../settings.ts'
import { FeelParser, stripForPool } from './engine.ts'
import type { JournalEntry, Memory, Tune } from './memory.ts'
import { casualSystem } from './prompt.ts'
import { claudeProvider, mockCasual, pickProvider, type Provider } from './providers.ts'

/** Fewer new exchanges than this aren't worth a reflection. */
const MIN_NEW = 6
/** At most this many exchanges are read per reflection (the newest). */
const READ_MAX = 40
const LINE_MAX = 300
const REPLAYS = 3
const RUBRIC = ['character', 'natural', 'length', 'memory', 'attunement'] as const

let running = false

export type LearnOptions = { settings: Settings; memory: Memory; claudePath?: string; idleMs: number; force?: boolean }
export type LearnResult = { skipped?: string; overall?: number; facts?: number; revised?: boolean; kept?: boolean }

/** Starts a reflection in the background when enough has been said and she's been quiet long enough. */
export function scheduleLearning(o: LearnOptions) {
  if (running) return
  void learn(o).then(
    (r) => r.skipped || console.log(`[learn] ${JSON.stringify(r)}`),
    (e) => console.warn(`[learn] failed: ${e instanceof Error ? e.message : e}`),
  )
}

export async function learn(o: LearnOptions): Promise<LearnResult> {
  if (running) return { skipped: 'already running' }
  const { memory, settings: s } = o
  const state = memory.learnState()
  const fresh = memory.readJournal(state.learned)
  if (!o.force && fresh.length < MIN_NEW) return { skipped: `${fresh.length} new exchanges` }
  if (!o.force && Date.now() - (fresh.at(-1)?.at ?? 0) < o.idleMs * 0.9) return { skipped: 'not idle yet' }
  running = true
  const abort = new AbortController()
  const name = s.waifu.name.trim() || defaultSettings().waifu.name
  const you = addressOf(s)
  const ctx = { claudePath: o.claudePath, you, name }
  const judge: Provider = s.casual.learnWith === 'casual' || mockCasual() ? pickProvider(s.casual, ctx) : claudeProvider(s.casual, ctx)
  try {
    const recent = fresh.slice(-READ_MAX)
    const transcript = lines(recent, you, name)
    const tune = memory.tune()
    const notes = memory.notes()

    const reflection = parseJson(
      await judge.complete(
        REFLECT_SYSTEM(name, you),
        `## Her current style guidance\n${tune.style}\n\n## What she has learned so far\nWorks: ${notes.works.join(' | ') || '(nothing yet)'}\nAvoid: ${notes.avoid.join(' | ') || '(nothing yet)'}\n\n## Facts she already knows\n${memory.facts().slice(-60).map((f) => `- ${f.text}`).join('\n') || '(none)'}\n\n## The chat (oldest first)\n${transcript}`,
        abort.signal,
        2000,
      ),
    )
    // Nothing readable: try the same chat again next time, rather than judging it 0/10 and moving past it.
    if (!Object.keys(reflection).length) return { skipped: 'the reflection was not JSON' }
    const facts = await memory.addFacts(strings(reflection.facts))
    if (typeof reflection.episode === 'string') await memory.addEpisode(reflection.episode, recent.at(-1)?.sid)
    await memory.updateNotes(strings(reflection.works), strings(reflection.avoid), strings(reflection.drop))
    // Memories but no scores: keep what was remembered, judge nothing (missing scores would read as zeros).
    if (!reflection.scores || typeof reflection.scores !== 'object') {
      console.warn('[learn] the reflection had no scores; remembered, not judged')
      await memory.setLearnState({ learned: state.learned + fresh.length, lastRunAt: Date.now() })
      return { facts }
    }
    const scores = Object.fromEntries(RUBRIC.map((k) => [k, num((reflection.scores as Record<string, unknown> | undefined)?.[k])]))
    const overall = num(reflection.overall) || RUBRIC.reduce((n, k) => n + scores[k], 0) / RUBRIC.length
    // A low score with no reasons given still gets a revision: the weakest rubric items stand in for them.
    const named = strings(reflection.problems)
    const problems = named.length ? named : RUBRIC.filter((k) => scores[k] < s.casual.judgeThreshold).map((k) => `${k} scored ${scores[k]}/10`)
    const result: LearnResult = { overall, facts }

    if (overall < s.casual.judgeThreshold && problems.length) {
      const proposal = parseJson(
        await judge.complete(
          CRITIC_SYSTEM(name, you),
          `## Current style guidance\n${tune.style}\n\n## Current example exchanges\n${tune.examples.join('\n\n')}\n\n## Problems the judge found (score ${overall.toFixed(1)}/10)\n${problems.map((p) => `- ${p}`).join('\n')}\n\n## The chat\n${transcript}`,
          abort.signal,
          1500,
        ),
      )
      const candidate = validTune(proposal)
      result.revised = !!candidate
      if (candidate) {
        result.kept = await replayWins(s, memory, tune, candidate, recent, judge, ctx, abort.signal)
        if (result.kept) await memory.setTune(candidate, `judge ${overall.toFixed(1)}: ${problems.slice(0, 3).join('; ')}`)
      }
    }
    await memory.logJudge({ scores, overall, problems, facts, revised: result.revised ?? false, kept: result.kept ?? false })
    await memory.setLearnState({ learned: state.learned + fresh.length, lastRunAt: Date.now() })
    return result
  } finally {
    running = false
  }
}

function lines(entries: JournalEntry[], you: string, name: string) {
  const c = (t: string) => (t.length > LINE_MAX ? `${t.slice(0, LINE_MAX)}…` : t)
  return entries.map((e) => `${you}: ${c(e.you)}\n${name}: ${c(e.her)}`).join('\n')
}

const REFLECT_SYSTEM = (name: string, you: string) => `You review a casual chat between ${you} and ${name}, an AI companion character in a visual-novel app. Do two jobs and reply with only one JSON object.

1. Remember, as ${name} would:
- "facts": new facts about ${you} worth knowing later (people, plans, likes, events, feelings), one short third-person sentence each; skip ones she already knows; [] if none.
- "episode": 2–4 sentences in ${name}'s first-person voice about what happened and how it felt, like a diary line.
- "works" / "avoid": up to 3 each: what in her replies landed well or badly with ${you}, judged from how ${you} reacted next (laughing along, opening up, long replies = good; short, cold, changing the subject, correcting her = bad). Concrete, about style (length, teasing, questions, topics), never about her personality.
- "drop": earlier learned notes this chat proved wrong; [] if none.

2. Judge her replies, 0–10 each, strict (7 = good, 9 = excellent):
- "character": sounds like ${name} throughout, consistent personality.
- "natural": talks like a person, not an assistant (no service phrases, lists, summaries; varied openings).
- "length": fits each moment.
- "memory": uses what she knows naturally; no contradictions.
- "attunement": responds to what ${you} meant and felt.
Give "scores", "overall" (0–10), and "problems": the specific failures behind any score under 7, each with a short quote.

JSON shape: {"facts":[],"episode":"","works":[],"avoid":[],"drop":[],"scores":{"character":0,"natural":0,"length":0,"memory":0,"attunement":0},"overall":0,"problems":[]}`

const CRITIC_SYSTEM = (name: string, you: string) => `You tune the casual-chat style of ${name}, an AI companion character, to fix problems a judge found. You may change only two things: her style guidance (a few short lines about how she talks: length, rhythm, openers, questions, humor) and her example exchanges (4–6 short ones). You must not change who she is: her personality, values, relationship with ${you}, backstory and how she feels are fixed and are not yours to edit, so write nothing about them. Keep what works; fix what the problems point at; stay concise (the guidance is part of every prompt, so every word costs).

Examples use the placeholders {you} and {name}, one exchange each, like:
{you}: im back
{name}: [happy] Welcome back! [pout] …You took your time.
Emotion tags in square brackets are allowed in her lines, only these: ${EMOTIONS.map((e) => `[${e}]`).join(' ')}.

Reply with only JSON: {"style":"…","examples":["…","…"],"reason":"one sentence"}`

function validTune(p: Record<string, unknown>): Omit<Tune, 'rev' | 'at'> | undefined {
  const style = typeof p.style === 'string' ? p.style.trim() : ''
  // One line per speaker, and only tags the app can play: any other [word] would show as text.
  const examples = strings(p.examples)
    .map((e) => e.replace(/\s*(\{name\}:)/, '\n$1').replace(/\[([a-z+?-]+)\]\s*/gi, (m, w: string) => ((EMOTIONS as readonly string[]).includes(w.toLowerCase()) ? m : '')))
    .filter((e) => e.includes('{name}:') && e.length <= 400)
  if (!style || style.length > 1500 || examples.length < 2) return undefined
  return { style, examples: examples.slice(0, 6) }
}

/** The candidate replays the last few real messages; it is kept only if a judge prefers most of its replies. */
async function replayWins(
  s: Settings, memory: Memory, oldTune: Tune, candidate: Omit<Tune, 'rev' | 'at'>, recent: JournalEntry[],
  judge: Provider, ctx: { claudePath?: string; you: string; name: string }, signal: AbortSignal,
): Promise<boolean> {
  const chat = pickProvider(s.casual, ctx)
  const system = casualSystem(s, { ...oldTune, ...candidate }, memory.notes(), false)
  const cases = recent.slice(-REPLAYS)
  const fresh: string[] = []
  for (const [i, c] of cases.entries()) {
    const before = recent.slice(Math.max(0, recent.length - REPLAYS - 4 + i), recent.length - REPLAYS + i)
    const messages = [
      ...before.flatMap((e) => [{ role: 'user' as const, content: e.you }, { role: 'assistant' as const, content: e.her }]),
      { role: 'user' as const, content: c.you },
    ]
    let raw = ''
    const feel = new FeelParser((d) => (raw += d))
    await chat.chat({ system, messages, maxTokens: 500, signal, onText: (d) => feel.feed(d) })
    feel.flush()
    fresh.push(stripForPool(raw))
  }
  // A and B in random order per case, so the judge can't favor a position.
  const flips = cases.map(() => Math.random() < 0.5)
  const prompt = cases
    .map((c, i) => {
      const [a, b] = flips[i] ? [fresh[i], c.her] : [c.her, fresh[i]]
      return `### Case ${i + 1}\n${ctx.you}: ${c.you}\nA: ${a}\nB: ${b}`
    })
    .join('\n\n')
  const verdict = parseJson(
    await judge.complete(
      `You compare two candidate replies by ${ctx.name}, an AI companion character, to the same message. For each case pick the reply that sounds more like ${ctx.name} and more like a real person chatting (not an assistant), fitting the moment better. Reply with only JSON: {"picks":["A"|"B", …]} in case order.`,
      prompt,
      signal,
      300,
    ),
  )
  const picks = strings(verdict.picks)
  const wins = picks.filter((p, i) => (p.toUpperCase() === 'A') === flips[i]).length
  return wins * 2 > cases.length
}

export function parseJson(text: string): Record<string, unknown> {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return {}
  try {
    const v = JSON.parse(text.slice(start, end + 1))
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [])
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(10, v)) : 0)
