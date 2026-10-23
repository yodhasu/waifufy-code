// The dialogue engine (R25–R30): turns the streamed text into VN pages with inline emotion markers,
// collapses long blocks, and types pages out at speaking pace while driving her face and mouth.
// The first half is pure (no DOM) so it can be unit-tested in isolation.

import type { Emotion } from '../../../link/src/protocol.ts'
import type { Character, Store } from '../contracts'
import { esc, renderMarkdown } from '../ui'

// ---------------------------------------------------------------- pure core

/** Visible characters one page holds before prose is split at a sentence boundary (R30). */
export const PAGE_CHARS = 200
/** Paragraphs longer than this collapse to a short lead-in page (R29). */
export const COLLAPSE_CHARS = 320
/** Lists with more items than this collapse (R29). */
export const LIST_MAX_ITEMS = 4
/** System output (command results, shell) with more lines than this collapses. */
export const MONO_MAX_LINES = 6
/** Characters of a code line shown in a collapsed code page. */
const CODE_PREVIEW_CHARS = 60
/** List items shown in a collapsed list page. */
const LIST_PREVIEW_ITEMS = 2
export const SHORT_PAUSE_MS = 180
export const LONG_PAUSE_MS = 420
const ELLIPSIS = '…'

// Emotions ride inside the text as single private-use characters, so splitting and paging keep them
// at their exact position. The Record makes the compiler check this list against the protocol's Emotion.
const EMOTION_CODES: Record<Emotion, number> = {
  normal: 0, smile: 1, happy: 2, delighted: 3, nod: 4, think: 5, worried: 6, serious: 7,
  surprised: 8, shy: 9, pout: 10, sad: 11, angry: 12, sigh: 13, teary: 14,
}
const MARK_BASE = 0xe000
const BY_CODE: Emotion[] = []
for (const [e, code] of Object.entries(EMOTION_CODES)) BY_CODE[code] = e as Emotion
// Only the codes in use: other private-use glyphs (Nerd Font and powerline icons) are ordinary text.
const MARK_END = MARK_BASE + Object.keys(EMOTION_CODES).length - 1
const MARK_CLASS = `\\u${MARK_BASE.toString(16)}-\\u${MARK_END.toString(16)}`
const MARK_RE = new RegExp(`[${MARK_CLASS}]`, 'g')
const NOT_MARK_RE = new RegExp(`[^${MARK_CLASS}]`, 'g')
const isMark = (c: string) => c.charCodeAt(0) >= MARK_BASE && c.charCodeAt(0) <= MARK_END
// A stray `[smile]` that reached the app (history, a tag the link did not catch) still never shows (R25).
const TAG_RE = new RegExp(` ?\\[(${Object.keys(EMOTION_CODES).join('|')})\\]`, 'g')

export const marker = (e: Emotion) => String.fromCharCode(MARK_BASE + EMOTION_CODES[e])
export const stripMarks = (s: string) => s.replace(MARK_RE, '')
const marksOf = (s: string) => s.replace(NOT_MARK_RE, '')
export const tagsToMarks = (s: string) => s.replace(TAG_RE, (_, e: Emotion) => marker(e))
/** Text with tags and markers removed, for the log, save metadata and copying. */
export const cleanText = (s: string) => stripMarks(tagsToMarks(s))
/** The last emotion in `s`, from markers or tags. */
export function lastEmotion(s: string): Emotion | undefined {
  const marks = marksOf(tagsToMarks(s))
  return marks ? BY_CODE[marks.charCodeAt(marks.length - 1) - MARK_BASE] : undefined
}

/** Roughly what the reader sees: no markers, no Markdown syntax. */
const visLen = (s: string) => stripMarks(s).replace(/\*\*|`/g, '').length
const bare = (line: string) => stripMarks(line).trim()

export type PageSpec = { text: string; collapsed: boolean }

/**
 * Takes the finished blocks (paragraphs, split on blank lines outside code fences) off the front of `buf`.
 * Unless `final`, the last line may still be streaming and stays in `rest`. Markers on blank lines move
 * to the start of the next block, so a face that came between paragraphs opens the next one.
 */
export function takeBlocks(buf: string, final: boolean): { blocks: string[]; rest: string } {
  const lines = buf.split('\n')
  const complete = final ? lines.length : lines.length - 1
  const blocks: string[] = []
  let cur: string[] = []
  let carry = ''
  let restCarry = ''
  let inFence = false
  let consumed = 0
  let pos = 0
  for (let i = 0; i < complete; i++) {
    const line = lines[i]
    pos += line.length + 1
    if (bare(line).startsWith('```')) inFence = !inFence
    if (inFence || bare(line) !== '') {
      cur.push(cur.length ? line : carry + line)
      if (cur.length === 1) carry = ''
      continue
    }
    carry += marksOf(line)
    if (cur.length) blocks.push(cur.join('\n'))
    cur = []
    consumed = Math.min(pos, buf.length)
    restCarry = carry
  }
  if (final) {
    if (cur.length) blocks.push(cur.join('\n'))
    else if (carry && blocks.length) blocks[blocks.length - 1] += carry
    return { blocks, rest: '' }
  }
  return { blocks, rest: restCarry + buf.slice(consumed) }
}

/** "e.g." and friends end in a dot without ending the sentence. */
const ABBREV = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|cf|approx)\.$/i

/** Splits prose after sentence-ending punctuation; a marker-only tail joins the sentence before it. */
export function sentences(s: string): string[] {
  const out: string[] = []
  const re = /[.!?…]+["'”’)\]]*(?=\s|$)\s*|[。！？]+\s*/g
  let start = 0
  for (const m of s.matchAll(re)) {
    if (ABBREV.test(stripMarks(s.slice(start, m.index + 1)))) continue
    const end = m.index + m[0].length
    out.push(s.slice(start, end))
    start = end
  }
  if (start < s.length) out.push(s.slice(start))
  const merged: string[] = []
  for (const piece of out) {
    if (merged.length && !bare(piece)) merged[merged.length - 1] += piece
    else merged.push(piece)
  }
  return merged
}

/** Greedily packs pieces (sentences or lines) into pages of at most PAGE_CHARS visible characters. */
function pack(pieces: string[], joiner: string): string[] {
  const pages: string[] = []
  let page = ''
  for (const piece of pieces) {
    if (page && visLen(page) + visLen(piece) > PAGE_CHARS) {
      pages.push(page)
      page = ''
    }
    page += page ? joiner + piece : piece
  }
  if (bare(page) || marksOf(page)) pages.push(page)
  return pages.map((p) => p.trim())
}

const FENCE = /^```/
const TABLE_ROW = /^\|.*\|$/
const TABLE_RULE = /^\|?\s*:?-{3,}/
const LIST_ITEM = /^([-*+•]|\d+[.)])\s+/
const HEADING = /^#{1,6}\s/

export type BlockKind = 'prose' | 'code' | 'table' | 'list'

/** What a block is, and where its spoken lead-in (prose before the structure) ends, as a line index. */
export function classify(block: string): { kind: BlockKind; leadLines: number; items: number } {
  const lines = block.split('\n').map(bare)
  const items = lines.filter((l) => LIST_ITEM.test(l)).length
  const first = (re: RegExp) => lines.findIndex((l) => re.test(l))
  const fence = first(FENCE)
  if (fence >= 0) return { kind: 'code', leadLines: fence, items }
  if (lines.filter((l) => TABLE_ROW.test(l)).length >= 2 && lines.some((l) => TABLE_RULE.test(l))) {
    return { kind: 'table', leadLines: first(TABLE_ROW), items }
  }
  if (items > 0) return { kind: 'list', leadLines: first(LIST_ITEM), items }
  return { kind: 'prose', leadLines: lines.length, items }
}

/**
 * `s` cut at a word boundary to at most `max` visible characters. Markers before the cut stay, and a `**` or
 * backtick run the cut leaves open is closed, so the page never shows stray Markdown.
 */
function clipVisible(s: string, max: number) {
  let seen = 0
  let cut = s.length
  let lastSpace = -1
  for (let i = 0; i < s.length; i++) {
    if (isMark(s[i])) continue
    if (/\s/.test(s[i])) lastSpace = i
    if (++seen > max) {
      cut = lastSpace > 0 ? lastSpace : i
      break
    }
  }
  let out = s.slice(0, cut).trimEnd()
  if ((out.match(/\*\*/g)?.length ?? 0) % 2) out += '**'
  if ((out.replace(/\*\*/g, '').match(/`/g)?.length ?? 0) % 2) out += '`'
  return out
}

/** The opening sentences of `s` that fit one page; a first sentence longer than a page is cut at a word (R29). */
function leadSentences(s: string) {
  let out = ''
  for (const sentence of sentences(s)) {
    if (out && visLen(out) + visLen(sentence) > PAGE_CHARS) break
    out += sentence
  }
  return visLen(out) > PAGE_CHARS ? clipVisible(out.trim(), PAGE_CHARS) : out.trim()
}

/**
 * A short page for a collapsed block: its lead-in or a preview, then "…". Of the emotions in the part
 * that is not shown, the last one still plays when the page finishes.
 */
function collapsed(shown: string, block: string): PageSpec {
  const hidden = marksOf(block).slice(marksOf(shown).length)
  return { text: `${shown.trim()} ${ELLIPSIS}${hidden.slice(-1)}`, collapsed: true }
}

/** Builds the pages for one block of the character's text (R29, R30). */
export function pagesForBlock(raw: string): PageSpec[] {
  const block = tagsToMarks(raw)
  if (!bare(block)) return []
  const lines = block.split('\n')
  const { kind, leadLines, items } = classify(block)
  const lead = lines.slice(0, leadLines).join(' ')
  const body = lines.slice(leadLines)

  if (kind === 'prose') {
    // Lines run together, except after a heading: "## Summary\nI fixed it." keeps the title on its own line.
    const prose = lines.map((l) => (HEADING.test(bare(l)) ? `${l}\n` : `${l} `)).join('').trimEnd()
    if (visLen(prose) <= COLLAPSE_CHARS) return pack(sentences(prose), '').map((text) => ({ text, collapsed: false }))
    return [collapsed(leadSentences(prose), block)]
  }
  if (kind === 'list' && items <= LIST_MAX_ITEMS) return pack(lines, '\n').map((text) => ({ text, collapsed: false }))
  if (bare(lead)) return [collapsed(leadSentences(lead), block)]
  // No lead-in: a glimpse of the structure itself.
  if (kind === 'code') {
    const code = body.slice(1).map(bare).find((l) => l && !FENCE.test(l)) ?? ''
    const preview = code.length > CODE_PREVIEW_CHARS ? `${code.slice(0, CODE_PREVIEW_CHARS - 1)}…` : code
    return [collapsed(preview ? `\`${preview.replace(/`/g, "'")}\`` : 'A code block', block)]
  }
  if (kind === 'table') {
    const header = bare(body[0]).split('|').map((c) => c.trim()).filter(Boolean).join(' · ')
    return [collapsed(header, block)]
  }
  return [collapsed(body.filter((l) => LIST_ITEM.test(bare(l))).slice(0, LIST_PREVIEW_ITEMS).join('\n'), block)]
}

/** Pages for a whole text at once (history, notices). */
export function pagesForText(text: string): PageSpec[] {
  return takeBlocks(text, true).blocks.flatMap(pagesForBlock)
}

/** Pages for monospace system output: shown as is, collapsed to its first lines when tall (R29). */
export function pagesForMono(text: string): PageSpec[] {
  const lines = text.replace(/\s+$/, '').split('\n')
  const long = lines.length > MONO_MAX_LINES || text.length > COLLAPSE_CHARS
  if (!long) return [{ text: lines.join('\n'), collapsed: false }]
  let shown = lines.slice(0, MONO_MAX_LINES - 1).join('\n')
  if (shown.length > COLLAPSE_CHARS) shown = shown.slice(0, COLLAPSE_CHARS)
  return [{ text: `${shown}\n${ELLIPSIS}`, collapsed: true }]
}

/**
 * Builds pages from the text stream: `face` events become markers at their exact position, a page
 * goes out as soon as its paragraph is complete, and `end` flushes the rest and reports the full message.
 */
export function createPager(out: { page(p: PageSpec): void; message(full: string): void; emote(e: Emotion): void }) {
  let buf = ''
  let full = ''
  const flush = (final: boolean) => {
    // A face after the last paragraph has no page to ride on; it still plays.
    const trailing = final && !bare(buf) ? lastEmotion(buf) : undefined
    if (trailing) return void ((buf = ''), out.emote(trailing))
    const { blocks, rest } = takeBlocks(buf, final)
    buf = rest
    for (const b of blocks) for (const p of pagesForBlock(b)) out.page(p)
  }
  return {
    text(delta: string) {
      buf += delta
      full += delta
      flush(false)
    },
    face(e: Emotion) {
      buf += marker(e)
    },
    end() {
      flush(true)
      const text = cleanText(full).trim()
      full = ''
      if (text) out.message(text)
    },
    reset() {
      buf = full = ''
    },
  }
}

// ---------------------------------------------------------------- inline Markdown and timing

export type Run = { s: string; style: 'plain' | 'b' | 'code' }
export type Rich = { runs: Run[]; marks: { at: number; e: Emotion }[]; plain: string }

const LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)/

/**
 * Minimal Markdown for dialogue (R25): **bold**, `code`, [links](url) as their text, headings as bold,
 * bullets as •. Markers become `marks` at their visible offset. Leading and trailing blanks are dropped.
 */
export function parseInline(text: string, markdown = true): Rich {
  const runs: Run[] = []
  const marks: Rich['marks'] = []
  let plain = ''
  let bold = false
  let code = false
  let heading = false
  const put = (c: string) => {
    if (!plain && /\s/.test(c)) return
    const style = code ? 'code' : bold || heading ? 'b' : 'plain'
    const last = runs[runs.length - 1]
    if (last?.style === style) last.s += c
    else runs.push({ s: c, style })
    plain += c
  }
  let atLine = true
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (isMark(c)) {
      marks.push({ at: plain.length, e: BY_CODE[c.charCodeAt(0) - MARK_BASE] })
      continue
    }
    if (markdown && !code && atLine) {
      const head = /^#{1,6}\s+/.exec(text.slice(i))
      const bullet = /^\s*[-*+]\s+/.exec(text.slice(i))
      if (head) (heading = true), (i += head[0].length - 1)
      else if (bullet) put('•'), put(' '), (i += bullet[0].length - 1)
      atLine = false
      if (head || bullet) continue
    }
    atLine = c === '\n'
    if (c === '\n') heading = false
    // An opening ` or ** only counts when it is closed later on the page.
    if (markdown && c === '`' && (code || text.indexOf('`', i + 1) > i)) {
      code = !code
      continue
    }
    if (markdown && !code && text.startsWith('**', i) && (bold || text.indexOf('**', i + 2) > i)) {
      bold = !bold
      i++
      continue
    }
    const link = markdown && !code && c === '[' ? LINK.exec(text.slice(i)) : null
    if (link) {
      for (const ch of link[1]) put(ch)
      i += link[0].length - 1
      continue
    }
    put(c)
  }
  // Trim trailing blanks; marks past the end fire when the page finishes.
  const trimmed = plain.replace(/\s+$/, '')
  let cut = plain.length - trimmed.length
  while (cut > 0 && runs.length) {
    const last = runs[runs.length - 1]
    const take = Math.min(cut, last.s.length)
    last.s = last.s.slice(0, last.s.length - take)
    cut -= take
    if (!last.s) runs.pop()
  }
  for (const m of marks) m.at = Math.min(m.at, trimmed.length)
  return { runs, marks, plain: trimmed }
}

/** HTML for the first `n` visible characters of `rich`. */
export function renderRich(rich: Rich, n = rich.plain.length): string {
  let html = ''
  let left = n
  for (const r of rich.runs) {
    if (left <= 0) break
    const s = esc(r.s.slice(0, left)).replace(/\n/g, '<br>')
    left -= r.s.length
    html += r.style === 'b' ? `<b>${s}</b>` : r.style === 'code' ? `<code>${s}</code>` : s
  }
  return html
}

const CLOSERS = '"\'”’)]」』'

/**
 * How long to wait after revealing character `i` of `text` at `cps` characters per second (R27), and
 * whether that wait is a pause (her mouth closes). Pauses come after `,;:` (short) and `.!?…` (long)
 * that end a phrase, so "v2.1" or "e.g.x" don't stutter; CJK punctuation needs no space after it.
 */
export function delayAfter(text: string, i: number, cps: number, pauses: boolean): { ms: number; pause: boolean } {
  const base = 1000 / cps
  const next = text[i + 1]
  if (!pauses || next === undefined) return { ms: base, pause: false }
  // `."` pauses after the closing quote, not between the dot and the quote.
  if (CLOSERS.includes(next)) return { ms: base, pause: false }
  const at = CLOSERS.includes(text[i]) && i > 0 ? i - 1 : i
  const c = text[at]
  const spaced = /\s/.test(next)
  const ends = spaced && '.!?…'.includes(c) && !(c === '.' && ABBREV.test(text.slice(0, at + 1)))
  if ('。！？'.includes(c) || ends) return { ms: base + LONG_PAUSE_MS, pause: true }
  if ('、，'.includes(c) || (spaced && ',;:'.includes(c)) || c === '\n') return { ms: base + SHORT_PAUSE_MS, pause: true }
  return { ms: base, pause: false }
}

/** Full Markdown for the LOG and the plan: links as "text (url)" and tables in monospace, outside code fences. */
export function markdown(src: string): string {
  const prose = (s: string) => s
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
    .replace(/(?:^\|.*\|[ \t]*(?:\n|$)){2,}/gm, (table) => `\`\`\`\n${table.replace(/\n$/, '')}\n\`\`\`\n`)
  return renderMarkdown(cleanText(src).split(/(```[\s\S]*?(?:```|$))/g).map((p) => (p.startsWith('```') ? p : prose(p))).join(''))
}

/** How long AUTO lingers on a finished page (R30). */
export const autoDelay = (chars: number, baseMs: number) => baseMs + chars * AUTO_PER_CHAR_MS
const AUTO_PER_CHAR_MS = 30

// ---------------------------------------------------------------- the dialogue box (DOM)

export type PageKind = 'char' | 'user' | 'system' | 'narration' | 'error'
export type DisplayPage = {
  kind: PageKind
  text: string
  collapsed?: boolean
  /** Monospace system output (command results, shell). */
  mono?: boolean
  /** Buttons under the text, e.g. "Log in" on an auth error. */
  actions?: { label: string; v: string; run(): void }[]
}

export type Dialogue = {
  /** Queues a page. It shows at once unless an unread character page is on screen. */
  push(p: DisplayPage): void
  /** Replaces everything with `p`, shown without typing (history, the greeting). */
  show(p: DisplayPage): void
  /** Click / Space / Enter: finish the page being typed, else turn to the next one. */
  advance(): void
  setAuto(on: boolean): void
  setSkip(on: boolean): void
  /**
   * While the chat is off screen, pages land silently: no typing, no mouth, no faces, no AUTO.
   * Muting finishes the page being typed without playing its emotions.
   */
  setMuted(on: boolean): void
}

/** Page interval while Ctrl is held. */
const SKIP_MS = 70
/** Typewriter ticks are never shorter than this; faster speeds reveal several characters per tick. */
const MIN_TICK_MS = 16

/** Typewriter only for the character's own lines; everything else appears at once. */
const typed = (p: DisplayPage) => p.kind === 'char' && !p.mono

export function createDialogue(
  root: HTMLElement,
  deps: { store: Store; character: Character; names(): { char: string; user: string }; openLog(): void },
): Dialogue {
  root.innerHTML = `
    <div class="nameplate" data-test="dialogue-name"></div>
    <div class="dlg-text" data-test="dialogue-text"></div>
    <div class="dlg-foot">
      <button class="dlg-hint" type="button" title="Open the LOG (Ctrl+L)">(full text in LOG)</button>
      <div class="dlg-actions"></div>
    </div>
    <div class="advance" data-test="dialogue-advance">▼<span></span></div>`
  const nameEl = root.querySelector<HTMLElement>('.nameplate')!
  const textEl = root.querySelector<HTMLElement>('.dlg-text')!
  const hintEl = root.querySelector<HTMLElement>('.dlg-hint')!
  const actionsEl = root.querySelector<HTMLElement>('.dlg-actions')!
  const advEl = root.querySelector<HTMLElement>('.advance')!
  hintEl.addEventListener('click', (e) => (e.stopPropagation(), deps.openLog()))

  const queue: DisplayPage[] = []
  let current: { page: DisplayPage; rich: Rich } | undefined
  let shown = 0
  let fired = 0
  let typing: number | undefined
  let later: number | undefined
  let auto = false
  let skip = false
  /** The reader clicked past the last page, so the next page that arrives shows at once. */
  let acked = false
  let muted = false

  const motion = () => deps.store.get().motion
  const talk = (on: boolean) => deps.character.setTalking(on && !muted && motion().lipSync)
  const done = () => !current || shown >= current.rich.plain.length
  // Her unread lines, command and shell output (she may answer it next), and pages with buttons (Log in,
  // Restart) stay until the reader moves on.
  const waitsForReader = () => !!current && (typed(current.page) || !!current.page.mono || !!current.page.actions?.length) && !acked

  function updateAdvance() {
    const ready = done() && queue.length > 0
    advEl.classList.toggle('show', ready)
    advEl.dataset.count = String(queue.length)
    advEl.querySelector('span')!.textContent = queue.length > 1 ? `+${queue.length}` : ''
  }

  function fireMarks(upTo: number, onlyLast: boolean) {
    const due = current!.rich.marks.slice(fired).filter((m) => m.at <= upTo)
    fired += due.length
    if (!muted) for (const m of onlyLast ? due.slice(-1) : due) deps.character.emote(m.e)
  }

  function paint() {
    textEl.innerHTML = renderRich(current!.rich, shown)
  }

  function finish() {
    clearTimeout(typing)
    typing = undefined
    if (!current) return
    shown = current.rich.plain.length
    fireMarks(shown, true)
    paint()
    talk(false)
    updateAdvance()
    scheduleNext()
  }

  /** AUTO and skip turn the page by themselves once it is finished. */
  function scheduleNext() {
    clearTimeout(later)
    if (!queue.length || !(auto || skip) || muted) return
    const ms = skip ? SKIP_MS : autoDelay(current?.rich.plain.length ?? 0, motion().autoDelayMs)
    later = window.setTimeout(() => done() && next(), ms)
  }

  function tick() {
    const { rich } = current!
    const { textCps, punctuationPauses } = motion()
    const step = Math.max(1, Math.ceil(MIN_TICK_MS / (1000 / textCps)))
    shown = Math.min(rich.plain.length, shown + step)
    fireMarks(shown, false)
    paint()
    if (shown >= rich.plain.length) return finish()
    const { ms, pause } = delayAfter(rich.plain, shown - 1, textCps, punctuationPauses)
    talk(!pause)
    typing = window.setTimeout(tick, Math.max(MIN_TICK_MS, ms))
  }

  function render(page: DisplayPage, instant: boolean) {
    clearTimeout(typing)
    clearTimeout(later)
    typing = undefined
    const rich = parseInline(page.text, !page.mono)
    // Only her own lines move her face; a tag-like word in your message or in tool output does not.
    if (page.kind !== 'char') rich.marks = []
    current = { page, rich }
    fired = 0
    acked = false
    const names = deps.names()
    nameEl.textContent = page.kind === 'char' ? names.char : page.kind === 'user' ? names.user : page.kind === 'system' ? 'System' : ''
    nameEl.className = `nameplate ${page.kind}`
    root.dataset.kind = page.kind
    textEl.className = `dlg-text${page.mono ? ' mono' : ''}`
    textEl.scrollTop = 0
    hintEl.hidden = !page.collapsed
    actionsEl.innerHTML = ''
    for (const a of page.actions ?? []) {
      const b = document.createElement('button')
      b.className = 'btn primary'
      b.type = 'button'
      b.textContent = a.label
      b.dataset.test = 'dialogue-action'
      b.dataset.v = a.v
      b.onclick = (e) => (e.stopPropagation(), a.run())
      actionsEl.append(b)
    }
    const speed = motion().textCps
    if (instant || skip || muted || !typed(page) || speed <= 0) {
      shown = rich.plain.length
      return finish()
    }
    shown = 0
    fireMarks(0, false)
    paint()
    talk(true)
    typing = window.setTimeout(tick, 1000 / speed)
    updateAdvance()
  }

  function next() {
    const page = queue.shift()
    if (page) render(page, false)
    else updateAdvance()
  }

  return {
    push(p) {
      queue.push(p)
      if (!current || (done() && !waitsForReader())) next()
      else {
        updateAdvance()
        if (done()) scheduleNext()
      }
    },
    show(p) {
      queue.length = 0
      render(p, true)
    },
    advance() {
      if (!done()) return finish()
      if (queue.length) next()
      else acked = true
    },
    setAuto(on) {
      auto = on
      if (done()) scheduleNext()
    },
    setSkip(on) {
      if (skip === on) return
      skip = on
      if (!on) return clearTimeout(later)
      if (!done()) finish()
      else if (queue.length) next()
    },
    setMuted(on) {
      if (muted === on) return
      muted = on
      if (!on) return void (done() && scheduleNext())
      if (!done()) finish()
      clearTimeout(later)
      talk(false)
    },
  }
}
