// Her long-term memory (v0.7), one folder per character under DATA_DIR/memory: facts about the user, an
// episode per stretch of casual chat (in her own words), what works and what to avoid with them, and the
// tunable part of her casual prompt that idle learning may revise. Lookup is local word matching (BM25), so
// remembering costs no tokens until a memory is actually put in front of her.

import { existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_DIR } from '../settings.ts'

export type Fact = { text: string; at: number; uses: number }
export type Episode = { text: string; at: number; sid?: string }
export type Notes = { works: string[]; avoid: string[] }
/** The only part of her casual prompt learning may change. Her character card is never in here. */
export type Tune = { rev: number; style: string; examples: string[]; at: number }
/** One casual exchange, kept until learning has read it. */
export type JournalEntry = { at: number; sid?: string; you: string; her: string }
export type LearnState = { learned: number; lastRunAt: number }

const MAX_FACTS = 400
const MAX_EPISODES = 2000
const MAX_NOTES = 12
/** Known when this share of its words is already said by a stored one: nearly all, so one new word ("nurse" in
 *  "Their sister Mia is a nurse" next to "Their sister Mia lives in Osaka") still makes it new. */
const KNOWN = 0.9

export const DEFAULT_TUNE: Tune = {
  rev: 0,
  at: 0,
  style: [
    'Chat lines, not paragraphs: often one or two sentences, sometimes a single word or a reaction.',
    'Vary how you open: not every reply starts by reacting to their last line, and never with their name every time.',
    'Small, concrete details make you feel real: what you were doing, a passing thought, a little opinion.',
  ].join('\n'),
  examples: [
    '{you}: im back\n{name}: [happy] Welcome back! You took your time, you know. [pout] …Did you at least eat something?',
    '{you}: what do you think about pineapple on pizza\n{name}: [think] Hmm… I won\'t judge you for it. [smile] Out loud, anyway.',
    '{you}: ugh today was so long\n{name}: [worried] That bad? [smile] Come here, sit for a bit. Tell me the worst part first.',
    '{you}: you\'re cute when you get flustered\n{name}: [shy] W-who said I was flustered?! [pout] I\'m perfectly composed.',
  ],
}

export type Memory = ReturnType<typeof loadMemory>

/** One memory per character for the whole link: every session and the startup reflection share it, so no copy
 *  saves a stale list over what another one learned. */
const open = new Map<string, Memory>()

export function openMemory(slug: string): Memory {
  const dir = join(DATA_DIR, 'memory', slug || 'character')
  let m = open.get(dir)
  if (!m) open.set(dir, (m = loadMemory(dir, slug)))
  return m
}

function loadMemory(dir: string, slug: string) {
  const file = (name: string) => join(dir, name)
  const read = <T>(name: string, fallback: T): T => {
    try {
      return existsSync(file(name)) ? ({ ...fallback, ...JSON.parse(readFileSync(file(name), 'utf8')) } as T) : fallback
    } catch (e) {
      console.warn(`[memory] ${slug}/${name}: ${e instanceof Error ? e.message : e}`)
      return fallback
    }
  }
  const readList = <T>(name: string): T[] => {
    const v = read<{ list: T[] }>(name, { list: [] }).list
    return Array.isArray(v) ? v : []
  }
  // One write at a time, so two quick saves of a file never race on its temp file.
  let writes: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = writes.then(fn)
    writes = run.catch(() => {})
    return run
  }
  const write = (name: string, value: unknown) =>
    serial(async () => {
      await mkdir(dir, { recursive: true })
      const tmp = `${file(name)}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(value))
      await rename(tmp, file(name))
    })

  let facts = readList<Fact>('facts.json')
  let episodes = readList<Episode>('episodes.json')
  let notes = read<Notes>('notes.json', { works: [], avoid: [] })
  let tune = read<Tune>('tune.json', structuredClone(DEFAULT_TUNE))
  let learn = read<LearnState>('learn.json', { learned: 0, lastRunAt: 0 })

  return {
    dir,
    facts: () => facts,
    episodes: () => episodes,
    notes: () => notes,
    tune: () => tune,
    learnState: () => learn,

    /** Adds facts, skipping ones she already knows; the least used old ones go when the list is full. */
    async addFacts(list: string[]) {
      const now = Date.now()
      let added = 0
      for (const raw of list) {
        const text = clean(raw, 240)
        // Known when an old fact already says all of it; one that only adds detail takes the old one's place.
        if (!text || facts.some((f) => covers(f.text, text) >= KNOWN)) continue
        const older = facts.findIndex((f) => covers(text, f.text) >= KNOWN)
        if (older >= 0) facts[older] = { text, at: now, uses: facts[older].uses }
        else facts.push({ text, at: now, uses: 0 })
        added++
      }
      if (facts.length > MAX_FACTS) facts = [...facts].sort((a, b) => b.uses - a.uses || b.at - a.at).slice(0, MAX_FACTS)
      if (added) await write('facts.json', { list: facts })
      return added
    },

    async addEpisode(text: string, sid?: string) {
      const t = clean(text, 1200)
      if (!t) return
      episodes.push({ text: t, at: Date.now(), ...(sid ? { sid } : {}) })
      if (episodes.length > MAX_EPISODES) episodes = episodes.slice(-MAX_EPISODES)
      await write('episodes.json', { list: episodes })
    },

    /** Merges learned notes: new ones first, dropped ones removed, each list capped. */
    async updateNotes(works: string[], avoid: string[], drop: string[]) {
      // A drop removes a note only when it says what the note says, so "teasing" never takes every note with the word.
      const gone = (s: string) => drop.some((d) => covers(d, s) >= KNOWN)
      const merge = (old: string[], add: string[]) => {
        const out = [...add.map((s) => clean(s, 200)).filter(Boolean), ...old].filter((s) => !gone(s))
        return out.filter((s, i) => out.findIndex((x) => covers(x, s) >= KNOWN) === i).slice(0, MAX_NOTES)
      }
      notes = { works: merge(notes.works, works), avoid: merge(notes.avoid, avoid) }
      await write('notes.json', notes)
    },

    async setTune(next: Omit<Tune, 'rev' | 'at'>, reason: string) {
      const prev = tune
      tune = { style: clean(next.style, 1500), examples: next.examples.map((e) => cleanLines(e, 400)).filter(Boolean).slice(0, 6), rev: prev.rev + 1, at: Date.now() }
      await write('tune.json', tune)
      await mkdir(dir, { recursive: true })
      await appendFile(file('tune-history.jsonl'), JSON.stringify({ ...tune, reason, previous: prev }) + '\n')
    },

    journal(e: JournalEntry) {
      return serial(async () => {
        await mkdir(dir, { recursive: true })
        await appendFile(file('journal.jsonl'), JSON.stringify(e) + '\n')
      })
    },

    /** Casual exchanges from `from` on (an index into the journal). */
    readJournal(from = 0): JournalEntry[] {
      try {
        if (!existsSync(file('journal.jsonl'))) return []
        return readFileSync(file('journal.jsonl'), 'utf8').split('\n').filter(Boolean).slice(from).flatMap((l) => {
          try {
            return [JSON.parse(l) as JournalEntry]
          } catch {
            return []
          }
        })
      } catch {
        return []
      }
    },

    async setLearnState(next: LearnState) {
      learn = next
      await write('learn.json', learn)
    },

    async logJudge(entry: unknown) {
      await mkdir(dir, { recursive: true })
      await appendFile(file('judge-log.jsonl'), JSON.stringify({ at: Date.now(), ...(entry as object) }) + '\n')
    },

    /** The memories that best match `query`: a few facts and at most two episodes, within `budget` characters. */
    recall(query: string, budget = 700, maxFacts = 5, maxEpisodes = 2): string[] {
      const q = words(query)
      if (!q.length) return []
      const pick = <T extends { text: string; at: number }>(list: T[], max: number) =>
        rank(list.map((x) => x.text), q).slice(0, max).map((i) => list[i])
      const hits = [...pick(facts, maxFacts), ...pick(episodes, maxEpisodes)]
      const out: string[] = []
      let used = 0
      let counted = false
      for (const h of hits) {
        const line = 'uses' in h ? h.text : `(${ago(h.at)}) ${h.text}`
        if (used + line.length > budget) continue
        out.push(line)
        used += line.length
        if ('uses' in h) ((h as Fact).uses++, (counted = true))
      }
      // Uses decide which facts stay when the list is full, so they're saved, not only counted.
      if (counted) void write('facts.json', { list: facts }).catch((e) => console.warn(`[memory] ${slug}/facts.json: ${e}`))
      return out
    },
  }
}

// ---------------------------------------------------------------- matching

const STOP = new Set(
  'the and you your are was were for that this with have has had not but what when then them they she her his him its our out who why how can could would should will just like really very about into from yeah yes okay lol haha also been being did does done get got gonna going want there here where some any all one too more much well'.split(' '),
)

/** Words worth matching: Latin/Cyrillic words of 3+ letters, and pairs of CJK characters. */
export function words(text: string): string[] {
  const out: string[] = []
  for (const w of text.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(w)) {
      for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2))
    } else if (w.length >= 3 && !STOP.has(w)) out.push(w.endsWith('s') && w.length > 4 ? w.slice(0, -1) : w)
  }
  return out
}

/** Indexes of `docs` that match `query` words, best first (BM25), and only those that match well enough. */
export function rank(docs: string[], query: string[]): number[] {
  const k1 = 1.4
  const b = 0.75
  const toks = docs.map(words)
  const avg = toks.reduce((n, t) => n + t.length, 0) / Math.max(1, toks.length) || 1
  const df = new Map<string, number>()
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1)
  const qs = [...new Set(query)]
  const scores = toks.map((t, i) => {
    let s = 0
    for (const w of qs) {
      const tf = t.filter((x) => x === w).length
      if (!tf) continue
      const idf = Math.log(1 + (docs.length - df.get(w)! + 0.5) / (df.get(w)! + 0.5))
      s += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * t.length) / avg)))
    }
    return [i, s] as const
  })
  // Relative, not a fixed floor: a fixed 0.3 hid the only fact she had (one document scores ~0.29 on a perfect
  // match) and any word every memory shares. Within a quarter of the best keeps weak side matches out.
  const best = Math.max(0, ...scores.map(([, s]) => s))
  return scores.filter(([, s]) => s > 0 && s >= best * 0.25).sort((x, y) => y[1] - x[1]).map(([i]) => i)
}

/** Share of `b`'s words found in `a`: 1 when `a` already says everything `b` says. */
export function covers(a: string, b: string) {
  const x = new Set(words(a))
  const y = new Set(words(b))
  if (!y.size) return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0
  let n = 0
  for (const w of y) if (x.has(w)) n++
  return n / y.size
}

/** Share of the smaller set's words found in the other: 1 when one says what the other says. */
export function overlap(a: string, b: string) {
  const x = new Set(words(a))
  const y = new Set(words(b))
  if (!x.size || !y.size) return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0
  let n = 0
  for (const w of x) if (y.has(w)) n++
  return n / Math.min(x.size, y.size)
}

/** Like clean(), keeping line breaks (an example exchange is one line per speaker). */
const cleanLines = (s: string, max: number) => s.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, max)

const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '')

export function ago(at: number, now = Date.now()) {
  const h = (now - at) / 3_600_000
  if (h < 1) return 'earlier today'
  if (h < 24) return `${Math.round(h)} h ago`
  const d = Math.round(h / 24)
  return d < 14 ? `${d} days ago` : d < 60 ? `${Math.round(d / 7)} weeks ago` : `${Math.round(d / 30)} months ago`
}
