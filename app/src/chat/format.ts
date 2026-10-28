// Live formatting for the composer: the Markdown you type shows as it will read. A highlight layer behind the
// textarea draws code fences, inline `code` and **bold** in the same font metrics (colour and background only), and
// Enter knows about code blocks: ``` + Enter closes the block for you, and Enter inside one is a new line.

const FENCE = /^\s*```/
const OPENER = /^\s*```[\w+#.-]*\s*$/
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)/g

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** True if the text has a code fence anywhere: the box switches to monospace so both layers keep one metric. */
export const hasFence = (text: string) => text.split('\n').some((l) => FENCE.test(l))

/** The highlight layer's HTML for `text`: one span per marked run, the rest escaped as is. */
export function highlight(text: string): string {
  let inFence = false
  const out = text.split('\n').map((line) => {
    if (FENCE.test(line)) {
      inFence = !inFence
      return `<span class="hl-fence">${escHtml(line)}</span>`
    }
    if (inFence) return line ? `<span class="hl-code">${escHtml(line)}</span>` : ''
    let html = ''
    let at = 0
    for (const m of line.matchAll(INLINE)) {
      html += escHtml(line.slice(at, m.index))
      html += `<span class="${m[1] ? 'hl-icode' : 'hl-bold'}">${escHtml(m[0])}</span>`
      at = m.index! + m[0].length
    }
    return html + escHtml(line.slice(at))
  })
  // A trailing newline needs something after it, or the layer is one line shorter than the textarea.
  return out.join('\n') + (text.endsWith('\n') ? ' ' : '')
}

export type EnterPlan =
  /** Not in a code block: Enter sends. */
  | { kind: 'send' }
  /** Inside a code block: Enter is a new line. */
  | { kind: 'newline' }
  /** On an opening fence with no closing one: insert `text` and put the caret `caret` chars into it. */
  | { kind: 'close'; text: string; caret: number }

/** What a plain Enter at `caret` should do in `text`. */
export function planEnter(text: string, caret: number): EnterPlan {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1
  const nl = text.indexOf('\n', caret)
  const lineEnd = nl < 0 ? text.length : nl
  const line = text.slice(lineStart, lineEnd)
  const before = text.slice(0, lineStart).split('\n').slice(0, -1)
  const fencesBefore = before.filter((l) => FENCE.test(l)).length
  const inside = fencesBefore % 2 === 1
  if (FENCE.test(line)) {
    // A closing fence: the block is done, Enter sends.
    if (inside) return { kind: 'send' }
    if (!OPENER.test(line) || caret !== lineEnd) return { kind: 'newline' }
    const after = text.slice(lineEnd + 1).split('\n')
    const closed = text.length > lineEnd && after.some((l) => FENCE.test(l))
    return closed ? { kind: 'newline' } : { kind: 'close', text: '\n\n```', caret: 1 }
  }
  return inside ? { kind: 'newline' } : { kind: 'send' }
}
