import { esc } from '../../ui'
import { control } from '../control'
import { openMenu, type MenuResult, type MenuScreen } from '../menu'
import type { CommandHost } from './index'

// /export [filename] and /copy [N], as the CLI 2.1.309 has them (docs/research/cli-session.md): /export offers
// "Copy to clipboard" or "Save to file" (or writes straight to the named file), with the conversation rendered as
// the CLI's transcript text; /copy copies her Nth-latest reply, with a picker when it has code blocks.

/** /copy looks back this many replies, as the CLI does. */
const COPY_LOOKBACK = 20
/** A code block row's label is cut here. */
const BLOCK_LABEL = 120
/** Lines of a tool's output kept in the export, under its call. */
const TOOL_OUTPUT_LINES = 12

export function exportCommand(host: CommandHost, args: string, typed: string) {
  if (typed === 'copy') return void copyCommand(host, args.trim())
  const name = args.trim()
  if (name) return void save(host, name)
  exportMenu(host)
}

// ---------------------------------------------------------------- /export

/** The CLI's default file name: `YYYY-MM-DD-HHMMSS-<first prompt slug>.txt`, or `conversation-<stamp>.txt`. */
export function defaultFilename(firstPrompt: string, now = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  let t = firstPrompt.trim()
  if (t.length > 50) t = `${t.slice(0, 49)}…`
  const slug = t.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return slug ? `${stamp}-${slug}.txt` : `conversation-${stamp}.txt`
}

const indent = (text: string, first: string, rest = '  ') => text.split('\n').map((l, i) => (i ? rest : first) + l).join('\n')

/** Who a backlog line is from: her, the user, a tool call, a `!` command, or a system line. */
function kind(host: CommandHost, who: string) {
  if (who === host.charName()) return 'char'
  if (who === 'tool' || who === 'shell' || who === 'system' || who === 'error') return who
  return 'user'
}

/** The conversation as the CLI's export text: `> ` prompts, `⏺ ` replies and tool calls, `⎿` results. */
export function exportText(host: CommandHost) {
  const parts: string[] = []
  for (const e of host.transcript()) {
    const text = e.text.trim()
    switch (kind(host, e.who)) {
      case 'user':
        parts.push(indent(text, '> '))
        break
      case 'char':
        parts.push(indent(text, '⏺ '))
        break
      case 'tool': {
        // "Label detail\n\nInput:\n…\n\nOutput:\n…" from the chat's backlog: the call line, then its result.
        const call = text.split('\n')[0]
        const out = text.split('\n\nOutput:\n')[1]?.trim() ?? ''
        const lines = out ? out.split('\n') : []
        const shown = lines.slice(0, TOOL_OUTPUT_LINES).join('\n') + (lines.length > TOOL_OUTPUT_LINES ? `\n… +${lines.length - TOOL_OUTPUT_LINES} lines` : '')
        parts.push(`⏺ ${call}${shown ? `\n${indent(shown, '  ⎿  ', '     ')}` : ''}`)
        break
      }
      case 'shell': {
        const [cmd, ...out] = text.split('\n')
        parts.push(`! ${cmd.replace(/^\$ /, '')}${out.length ? `\n${indent(out.join('\n'), '  ⎿  ', '     ')}` : ''}`)
        break
      }
      default:
        parts.push(indent(text, '  ⎿  ', '     '))
    }
  }
  return `${parts.join('\n\n')}\n`
}

const firstPrompt = (host: CommandHost) => host.transcript().find((e) => kind(host, e.who) === 'user')?.text ?? ''

/** Writes the export to `name` (".txt" added without an extension) and shows the CLI's result line. */
async function save(host: CommandHost, name: string) {
  const path = /\.[^\\/.]+$/.test(name) ? name : `${name}.txt`
  try {
    const full = await control<string>(host.link, 'createText', path, exportText(host))
    host.toast(`Conversation exported to: ${full}`)
    return true
  } catch (e) {
    host.toast(`Failed to export conversation: ${e instanceof Error ? e.message : 'Unknown error'}`)
    return false
  }
}

function exportMenu(host: CommandHost) {
  let done = false
  const first: MenuScreen = {
    title: 'Export conversation',
    subtitle: 'Select export method',
    groups: [{
      rows: [
        { id: 'clipboard', label: 'Copy to clipboard', hint: 'Copy the conversation to your system clipboard' },
        { id: 'file', label: 'Save to file', hint: 'Save the conversation to a file in the current directory' },
      ],
    }],
    notes: ['Esc to cancel'],
    async pick(row): Promise<MenuResult> {
      if (row.id === 'file') return fileScreen()
      done = true
      if (await copied(host, exportText(host))) host.toast('Conversation copied to clipboard')
      return 'close'
    },
  }

  /** "Enter filename:" with the CLI's default name; Enter saves, Esc goes back. */
  function fileScreen(): MenuScreen {
    const draft = defaultFilename(firstPrompt(host))
    setTimeout(() => {
      const box = document.querySelector<HTMLInputElement>('[data-test="export-filename"]')
      box?.focus()
      box?.setSelectionRange(box.value.length, box.value.length)
    })
    return {
      title: 'Export conversation',
      subtitle: 'Select export method',
      body: '<p>Enter filename:</p>'
        + `<input class="field pinput" data-test="export-filename" spellcheck="false" value="${esc(draft)}">`,
      groups: [],
      empty: ' ',
      notes: ['Enter to save · Esc to go back'],
      key(e): MenuResult | boolean | Promise<MenuResult> {
        const box = e.target as HTMLInputElement
        if (box?.dataset?.test !== 'export-filename') return false
        if (e.key !== 'Enter') return e.key === 'ArrowUp' || e.key === 'ArrowDown'
        const name = box.value.trim()
        if (!name) return true
        return save(host, name).then((ok): MenuResult => {
          if (!ok) return
          done = true
          return 'close'
        })
      },
    }
  }

  const menu = openMenu(host, 'export', first, 'Export conversation')
  void menu.closed.then(() => !done && host.toast('Export cancelled'))
}

// ---------------------------------------------------------------- /copy

type Block = { label: string; meta: string; text: string }

/** Fenced code blocks in a reply, as the CLI's picker lists them (first line, "lang, N lines"). */
function codeBlocks(text: string): Block[] {
  const out: Block[] = []
  for (const m of text.matchAll(/^ {0,3}(```+|~~~+)([^\n`]*)\n([\s\S]*?)\n {0,3}\1[ \t]*$/gm)) {
    const body = m[3]
    const lines = body.split('\n')
    const line = lines.find((l) => l.trim() !== '')
    const label = line === undefined ? '(code block)' : line.length > BLOCK_LABEL ? `${line.slice(0, BLOCK_LABEL)}…` : line
    const lang = m[2].trim().split(/\s+/)[0]
    out.push({ label, meta: `${lang ? `${lang}, ` : ''}${lines.length} line${lines.length === 1 ? '' : 's'}`, text: body })
  }
  return out
}

const stats = (t: string) => {
  const lines = t.split('\n').length
  return { chars: t.length, lines }
}

/** True when the copy worked; a failure has already shown its toast. */
const copied = (host: CommandHost, text: string) => host.copy(text)

async function copyOut(host: CommandHost, text: string) {
  if (!(await copied(host, text))) return
  const s = stats(text)
  host.toast(`Copied to clipboard (${s.chars} characters, ${s.lines} lines)`)
}

/** `/copy [N]`: her Nth-latest reply (1 is the latest), straight to the clipboard or through the block picker. */
async function copyCommand(host: CommandHost, arg: string) {
  const replies = host.replies().slice(0, COPY_LOOKBACK)
  if (!replies.length) return host.toast('No assistant message to copy')
  let at = 0
  if (arg) {
    const n = Number(arg)
    if (!Number.isInteger(n) || n < 1) return host.toast(`Usage: /copy [N] where N is 1 (latest), 2, 3, … Got: ${arg}`)
    if (n > replies.length) return host.toast(`Only ${replies.length} assistant ${replies.length === 1 ? 'message' : 'messages'} available to copy`)
    at = n - 1
  }
  const text = replies[at]
  const blocks = codeBlocks(text)
  if (!blocks.length) return copyOut(host, text)
  let done = false
  const full = stats(text)
  const menu = openMenu(host, 'copy', {
    title: 'Select content to copy:',
    groups: [{
      rows: [
        { id: 'full', label: 'Full response', meta: `${full.chars} chars, ${full.lines} lines` },
        ...blocks.map((b, i) => ({ id: `b:${i}`, label: b.label, meta: b.meta })),
      ],
    }],
    notes: ['Enter to copy · Esc to cancel'],
    async pick(row): Promise<MenuResult> {
      done = true
      await copyOut(host, row.id === 'full' ? text : blocks[Number(row.id.slice(2))].text)
      return 'close'
    },
  }, 'Select content to copy:')
  void menu.closed.then(() => !done && host.toast('Copy cancelled'))
}
