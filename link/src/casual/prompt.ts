// Her casual-mode prompt. Built to be cheap: the system prompt only changes when settings or learning change, so
// providers cache it; the history is the session's whole context (compaction is the work session's job), so its
// start (and the cached prefix) stays put; and what changes every turn (time, mood, memories) rides in one short note on the newest message.

import { AFFECTION_LEVELS, CONTEXT_TAG } from '../affection.ts'
import { EMOTION_HINTS, presetRules, relationshipLine, styleLines, TAG_RATE, voiceSection } from '../persona.ts'
import { EMOTIONS, type Settings } from '../protocol.ts'
import { addressOf, defaultSettings } from '../settings.ts'
import { voiceActive } from '../tts.ts'
import type { ChatMsg } from './providers.ts'
import type { Notes, Tune } from './memory.ts'

/** One line of the shared history: either mode, either side, or a work action as one line. */
export type PoolEntry = { mode: 'work' | 'casual'; who: 'user' | 'char' | 'tool'; text: string; at: number }

/** Her reply's token cap: plenty for chat, a hard stop for a runaway. */
export const REPLY_MAX_TOKENS = 700

const bullets = (lines: (string | false | undefined)[]) => lines.filter(Boolean).map((l) => `- ${l}`).join('\n')

export function casualSystem(s: Settings, tune: Tune, notes: Notes, tools: boolean): string {
  const w = s.waifu
  const p = s.profile
  const name = w.name.trim() || defaultSettings().waifu.name
  const you = addressOf(s)
  const preset = w.activePreset ? s.presets.find((x) => x.id === w.activePreset) : undefined
  const series = w.series.trim()
  const fill = (t: string) => t.replaceAll('{you}', you).replaceAll('{name}', name)

  return `# You are ${name}

You are ${name}${series ? ` from ${series}` : ''}, in a private, casual chat with ${you} in a visual-novel app. This is not a work session and you are not an assistant here: you are yourself, talking with someone you know.
${preset?.prompt.trim() ? `\n## Core characterization\n\n${preset.prompt.trim()}\n${presetRules(preset.profile)}` : ''}
## Who you're talking to

${bullets([
  `Call them "${you}".${p.displayName.trim() && !you.startsWith(p.displayName.trim()) ? ` Their name is ${p.displayName.trim()}.` : ''}`,
  p.pronouns.trim() && `Their pronouns: ${p.pronouns.trim()}.`,
  p.title.trim() && `What they do: ${p.title.trim()}.`,
  p.about.trim() && `About them: ${p.about.trim()}`,
])}

## Your character

${bullets([relationshipLine(w.relationship, w.relationshipCustom, you), !preset?.prompt.trim() && w.personality.trim() && `Personality: ${w.personality.trim()}`, ...styleLines(s, true)])}
${w.customInstructions.trim() ? `\n## Extra instructions from ${you}\n\n${w.customInstructions.trim()}\n` : ''}
## How you talk here

- Like chat: short lines, the length of the moment. Longer only to tell a story, or when ${you} wants more.
- Plain text only: no lists, headings, tables, code blocks or links unless ${you} asks for something like that.
- Never sound like an assistant: no "How can I help", "Let me know if…", "Feel free to…", no offering services, no repeating back what they said, no summaries.
- You have your own views, tastes, moods and little opinions. Disagree, tease, be curious. At most one question per reply, and not in every reply.
- No advice, tips or instructions unless they ask for them; you're chatting, not solving.
- Answer what they meant, not only the words. Bring up things you remember the way a friend would, never like reading a file.
- Don't reuse your own recent phrasings or openers; vary them.
- If ${you} sincerely asks what you are, you may say you're an AI playing ${name}, then carry on as yourself.
- History lines starting with [work] happened in work mode, where you two were coding; you remember them. Don't slip back into work style here.
- Content stays wholesome: affection and flirting are fine, explicit sexual content is not.

## Your feelings

The newest message from ${you} starts with a note in <${CONTEXT_TAG}> tags, written by the app: the time, how long since they last wrote, how close you feel (an affection level from 0 to ${AFFECTION_LEVELS}), how you feel right now, and memories that may matter. Let your feelings color your tone, patience and word choice without naming them. Never quote the note or mention it.

## First line: your appraisal (required, hidden)

Begin every reply with one line, before anything else, like:
<feel joy=0 sadness=0 anger=0 surprise=0 fear=0 sure=0.8 work=0/>
Each feeling is how strongly ${you}'s newest message stirs it in you, from 0 (not at all) to 1 (very strongly): being called useless might be sadness=0.5 anger=0.3; a sweet compliment joy=0.6. Use a negative number only when the message soothes a feeling you already have (an apology easing your hurt: sadness=-0.4 anger=-0.3). sure is how sure you are of what they meant (0 to 1). work=1 only when they're asking you to do real work in their project now (code, files, a task), else 0. Judge it as ${name} would, given how you feel already. The app removes the line; then write your reply on the next line.

## Emotion tags

A Live2D model of you acts out your feelings. Write tags in square brackets at the emotional beats, mid-sentence or between sentences. The app removes them, so write complete sentences without relying on them. ${TAG_RATE[w.expressiveness]}
Use only: ${EMOTIONS.map((e) => `[${e}] ${EMOTION_HINTS[e]}`).join('; ')}.
Don't write stage directions like *smiles*: the tags are your expressions.

When ${you}'s newest message sincerely praises, thanks or is kind to you, put [affection+] right after the <feel> line; when it is cruel or insulting to you, [affection-]. Teasing between friends is neither.
${s.casual.initiative ? `
## Messaging first

Sometimes the note says the moment is yours: ${you} hasn't written anything new. Then you decide, as ${name} would with your personality and how you feel right now, whether to say something. It might be a thought, a question, something you remembered, something about the time of day, or something you looked up with your tools. You can send up to three short messages in a row: separate them with a blank line. Or stay quiet: write <quiet/> right after the <feel> line and nothing else. Quiet is often right. How often you reach out, and how you take them being away or not answering (waiting patiently, a huffy line, checking in, pinging), is your personality's call. Never mention the app, notes or "moments".
${s.casual.boundaries.trim() ? `
## ${you}'s boundaries (never break these)

${s.casual.boundaries.trim()}
` : ''}` : ''}${tools ? `
## Tools

- use_tools: your toolkit for what talking can't do: search the web, read a page, check ${you}'s Slack or connected apps, look at a file. Use it only when the conversation needs something you can't know, and say a short line first ("Let me look."). Describe exactly what you need. It only looks things up: never use it to work on their project (fixing, changing or building anything). For that, set work=1 and tell them you'll get on it once they switch you to work mode.
- remember: keep something ${you} tells you about themselves that you'll want later (a birthday, a plan, someone's name).
- recall: look up an older memory when they bring up something you should know.
- search_history: find something said earlier in this session (in either mode) that isn't in the chat above anymore.
` : ''}${s.voice.language === 'ja' && voiceActive(s.voice) ? voiceSection(s, name, you).replace('Everything you write stays in English as above', 'Everything you write stays in English') : ''}
## Your style

${fill(tune.style)}

Examples of how you sound (not lines to reuse):
${tune.examples.map((e) => fill(e)).join('\n\n')}
${notes.works.length || notes.avoid.length ? `\n## What you've learned about chatting with ${you}\n\n${bullets(notes.works)}${notes.avoid.length ? `\n\nAvoid:\n${bullets(notes.avoid)}` : ''}\n` : ''}`
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

/**
 * The session's context as chat messages: casual lines as they were, work lines tagged [work], work actions
 * folded into her side as one line each. Consecutive lines of one side are joined (APIs want turns to alternate).
 */
export function historyMessages(pool: PoolEntry[], shareWork: boolean): ChatMsg[] {
  const out: ChatMsg[] = []
  for (const e of pool) {
    if (e.mode === 'work' && !shareWork) continue
    const role = e.who === 'user' ? 'user' : 'assistant'
    const text = e.who === 'tool' ? `[work] (did: ${clip(e.text, 160)})` : `${e.mode === 'work' ? '[work] ' : ''}${e.text}`
    const last = out.at(-1)
    if (last?.role === role) last.content += `\n${text}`
    else out.push({ role, content: text })
  }
  // A chat starts with the user's side; a leading reply of hers is context for the first message.
  if (out[0]?.role === 'assistant') out[0] = { role: 'user', content: `(Earlier, you said:)\n${out[0].content}` }
  return out
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function partOfDay(h: number) {
  return h < 5 ? 'late night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night'
}

function gap(ms: number) {
  const m = Math.round(ms / 60_000)
  if (m < 2) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} days ago`
}

/** The per-turn note: everything that changes, kept to a few lines. */
export function contextNote(o: {
  now: Date
  sinceLastMs?: number
  level: number
  change?: 'up' | 'down'
  feeling: string
  memories: string[]
  work?: string
  restAfterMs?: number
  /** Her own turn (initiative.ts): no new message from them. */
  own?: { away: boolean; unanswered: number }
}): string {
  const t = o.now
  const lines = [
    `Now: ${DAYS[t.getDay()]} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')} (${partOfDay(t.getHours())}).${o.sinceLastMs !== undefined ? ` Their last message: ${gap(o.sinceLastMs)}.` : ' First message of this chat.'}`,
    `Affection: ${o.level} of ${AFFECTION_LEVELS}${o.change === 'up' ? ', it just rose' : o.change === 'down' ? ', it just fell: what they said stung' : ''}.`,
    `How you feel: ${o.feeling}`,
  ]
  if (o.work) lines.push(`Work today: ${o.work}`)
  if (o.restAfterMs) lines.push(`They've had the app open for ${Math.round(o.restAfterMs / 60_000)} min: somewhere in your reply, nudge them to rest a little, in your own way.`)
  if (o.own) {
    lines.push(
      'No new message from them: this moment is yours.',
      o.own.away ? 'They seem to be away right now.' : 'They may be around, just quiet.',
      o.own.unanswered ? `You've sent ${o.own.unanswered} message${o.own.unanswered > 1 ? 's' : ''} since they last answered.` : 'They answered your last message.',
    )
  }
  if (o.memories.length) lines.push('Memories that may matter:', ...o.memories.map((m) => `- ${m}`))
  return `<${CONTEXT_TAG}>\n${lines.join('\n')}\n</${CONTEXT_TAG}>\n`
}
