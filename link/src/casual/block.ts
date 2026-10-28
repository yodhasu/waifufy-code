// How a casual exchange is kept in the work transcript: a user-role message, appended without a turn, that the
// work persona knows as casual chat and the backlog (saves.ts) turns back into her and your lines.

import { CASUAL_TAG } from '../affection.ts'

const esc = (s: string) => s.replace(/<\/(you|her)>/g, '<\\/$1>')
const unesc = (s: string) => s.replace(/<\\\/(you|her)>/g, '</$1>')

export function casualBlock(you: string, her: string) {
  return `<${CASUAL_TAG}>\n<you>${esc(you)}</you>\n<her>${esc(her)}</her>\n</${CASUAL_TAG}>`
}

const BLOCK = new RegExp(`<${CASUAL_TAG}>([\\s\\S]*?)</${CASUAL_TAG}>`, 'g')

/** Every exchange in `text`, in order; empty when it holds no casual block. */
export function parseCasual(text: string): { you: string; her: string }[] {
  const out: { you: string; her: string }[] = []
  for (const m of text.matchAll(BLOCK)) {
    const you = /<you>([\s\S]*?)<\/you>/.exec(m[1])?.[1] ?? ''
    const her = /<her>([\s\S]*?)<\/her>/.exec(m[1])?.[1] ?? ''
    out.push({ you: unesc(you).trim(), her: unesc(her).trim() })
  }
  return out
}
