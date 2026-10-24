import { esc } from '../../ui'
import { lineDiff } from '../asks'
import { control } from '../control'
import { openMenu, type MenuResult, type MenuRow, type MenuScreen } from '../menu'
import type { CommandHost } from './index'

// /diff as a review pane (docs/research/cli-session.md /diff, ux-research.md P0-4): two sources in the CLI's
// tab strip, "Uncommitted changes" (git diff HEAD plus untracked files) and "This session" (every Edit, Write and
// MultiEdit she made). The file list gives +N −M per file; the selected file's colored diff sits above it, with a
// comment box. Comments are collected per file and sent together as one message with Ctrl+Enter.

type GitDiff = { repo: false } | { repo: true; branch: string; patch: string; truncated?: boolean; untracked: string[] }

/** One diff line: ' ' context, '+' added, '-' removed, '@' a hunk header or fold. */
type DLine = { op: ' ' | '+' | '-' | '@'; s: string }

type FileView = {
  id: string
  path: string
  added: number
  removed: number
  /** "untracked", "Binary file", "new file", "deleted", "Write", "denied"… */
  tag?: string
  /** The diff, or a loader (untracked files are read when first selected). */
  lines?: DLine[]
  load?(): Promise<DLine[]>
  /** Unchanged lines to fold around changes (a git patch is already trimmed to its hunks). */
  fold?: boolean
}

type Tab = 'git' | 'session'

const TABS = [{ id: 'git', label: 'Uncommitted changes' }, { id: 'session', label: 'This session' }]
const NOT_REPO = "The diff panel shows git changes — the current directory isn't in a git repository"
/** Unchanged lines kept around each change in a session edit. */
const CONTEXT = 3
/** Diff rows drawn for one file; the rest are summarized. */
const MAX_ROWS = 1500
/** Untracked files read when the list opens, for their +N count. */
const MAX_UNTRACKED_READS = 40

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const splitLines = (s: string) => (s === '' ? [] : s.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'))
const count = (lines: DLine[]) => ({ added: lines.filter((l) => l.op === '+').length, removed: lines.filter((l) => l.op === '-').length })

/** Splits `git diff` output into one view per file, counting + and − inside the hunks only. */
export function parsePatch(patch: string): FileView[] {
  const files: FileView[] = []
  let cur: FileView | undefined
  let inHunk = false
  for (const line of patch.replace(/\r\n/g, '\n').split('\n')) {
    const head = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line)
    if (head) {
      cur = { id: `g:${files.length}`, path: head[2], added: 0, removed: 0, lines: [] }
      files.push(cur)
      inHunk = false
      continue
    }
    if (!cur) continue
    if (line.startsWith('@@')) {
      inHunk = true
      cur.lines!.push({ op: '@', s: line })
    } else if (!inHunk) {
      if (line.startsWith('new file mode')) cur.tag = 'new file'
      else if (line.startsWith('deleted file mode')) cur.tag = 'deleted'
      else if (line.startsWith('Binary files') || line === 'GIT binary patch') cur.tag = 'Binary file'
    } else if (line.startsWith('+')) cur.lines!.push({ op: '+', s: line.slice(1) }), cur.added++
    else if (line.startsWith('-')) cur.lines!.push({ op: '-', s: line.slice(1) }), cur.removed++
    else if (line.startsWith('\\')) cur.lines!.push({ op: '@', s: line.slice(2) })
    else if (line !== '' || cur.lines!.length) cur.lines!.push({ op: ' ', s: line.slice(1) })
  }
  // A patch's last line is empty: drop the trailing blank context the split made.
  for (const f of files) while (f.lines!.at(-1)?.op === ' ' && f.lines!.at(-1)!.s === '') f.lines!.pop()
  return files
}

const added = (text: string): DLine[] => splitLines(text).map((s) => ({ op: '+', s }))
const diffOf = (before: string, after: string): DLine[] =>
  lineDiff(splitLines(before), splitLines(after)).map((l) => ({ op: l.op, s: l.s }))

/** The project-relative path of a tool's file_path, with forward slashes as git prints them. */
function rel(path: string, cwd: string) {
  const p = path.replace(/\\/g, '/')
  const base = cwd.replace(/\\/g, '/').replace(/\/$/, '')
  return p.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? p.slice(base.length + 1) : p
}

/** One row per Edit, Write or MultiEdit this session, from the tool inputs (oldest first, as the CLI's turns). */
function sessionFiles(host: CommandHost): FileView[] {
  const out: FileView[] = []
  for (const t of host.toolRecords()) {
    if (!['Edit', 'Write', 'MultiEdit'].includes(t.name)) continue
    let input: { file_path?: string; old_string?: string; new_string?: string; content?: string; edits?: { old_string?: string; new_string?: string }[] }
    try {
      input = JSON.parse(t.input)
    } catch {
      continue
    }
    if (!input.file_path) continue
    let lines: DLine[]
    if (t.name === 'Write') lines = added(input.content ?? '')
    else if (t.name === 'Edit') lines = diffOf(input.old_string ?? '', input.new_string ?? '')
    else {
      lines = []
      for (const [i, e] of (input.edits ?? []).entries()) {
        if (i) lines.push({ op: '@', s: `edit ${i + 1}` })
        lines.push(...diffOf(e.old_string ?? '', e.new_string ?? ''))
      }
    }
    const c = count(lines)
    const tag = t.state === 'err' ? 'not applied' : t.state === 'run' ? 'waiting' : t.state === 'stopped' ? 'stopped' : t.name
    out.push({ id: `s:${t.id}`, path: rel(input.file_path, host.cwd()), ...c, tag, lines, fold: true })
  }
  return out
}

/** The CLI's untracked-file view: the whole file as added lines (or a Binary file tag). */
function untrackedFile(host: CommandHost, path: string, i: number): FileView {
  const f: FileView = { id: `u:${i}`, path, added: 0, removed: 0, tag: 'untracked' }
  f.load = async () => {
    const text = await control<string | undefined>(host.link, 'readText', path)
    if (text === undefined) return [{ op: '@', s: 'The file is gone' }]
    if (text.includes('\0')) {
      f.tag = 'untracked · Binary file'
      return []
    }
    const lines = added(text)
    f.added = lines.length
    return lines
  }
  return f
}

/** Draws a file's diff with the permission prompt's look (asks.ts renderDiff), folding long unchanged runs. */
function diffHtml(f: FileView) {
  const lines = f.lines ?? []
  const keep = lines.map((l, i) => !f.fold || l.op !== ' ' || lines.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((x) => x.op === '+' || x.op === '-'))
  let html = ''
  let folded = 0
  let rows = 0
  const fold = () => {
    if (folded) html += `<div class="dl fold">⋯ ${plural(folded, 'unchanged line')}</div>`
    folded = 0
  }
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) {
      folded++
      continue
    }
    fold()
    if (++rows > MAX_ROWS) {
      html += `<div class="dl fold">⋯ ${lines.length - i} more lines</div>`
      break
    }
    const l = lines[i]
    if (l.op === '@') html += `<div class="dl fold hunk">${esc(l.s)}</div>`
    else html += `<div class="dl ${l.op === '+' ? 'add' : l.op === '-' ? 'del' : ''}"><i>${l.op}</i><span>${esc(l.s) || ' '}</span></div>`
  }
  fold()
  if (!lines.length) html = `<div class="dl fold">${esc(f.tag?.includes('Binary') ? 'Binary file' : f.load ? 'Loading…' : 'No line changes')}</div>`
  return `<div class="diff" data-test="diff-view" data-path="${esc(f.path)}"><div class="diff-file"><span>${esc(f.path)}</span>`
    + `<small><b class="add">+${f.added}</b> <b class="del">−${f.removed}</b></small></div><div class="diff-body">${html}</div></div>`
}

/** Opens /diff on "Uncommitted changes". */
export function diffCommand(host: CommandHost, _args: string, _typed: string) {
  /** Comments by file view id, with the path they are about. */
  const comments = new Map<string, { path: string; tab: Tab; text: string }>()
  const selected: Record<Tab, string | undefined> = { git: undefined, session: undefined }
  let git: { result: GitDiff; files: FileView[] } | undefined
  let sent = false

  async function loadGit() {
    const result = await control<GitDiff>(host.link, 'gitDiff')
    const files = result.repo ? [...parsePatch(result.patch), ...result.untracked.map((p, i) => untrackedFile(host, p, i))] : []
    // Read the first untracked files now so their rows show +N, as the CLI's list does.
    await Promise.all(files.filter((f) => f.load).slice(0, MAX_UNTRACKED_READS).map(ensure))
    git = { result, files }
  }

  async function ensure(f: FileView) {
    if (f.lines || !f.load) return
    try {
      f.lines = await f.load()
    } catch (e) {
      f.lines = [{ op: '@', s: e instanceof Error ? e.message : String(e) }]
    }
  }

  const el = () => document.querySelector<HTMLElement>('[data-test="diff"]')

  /** The selected file's comment, read from its box (the box is redrawn with every screen). */
  function keepComment() {
    const box = el()?.querySelector<HTMLInputElement>('[data-test="diff-comment"]')
    if (!box) return
    const id = box.dataset.id!
    const text = box.value.trim()
    if (text) comments.set(id, { path: box.dataset.path!, tab: box.dataset.tab as Tab, text })
    else comments.delete(id)
  }

  function send(): MenuResult {
    keepComment()
    if (!comments.size) {
      host.toast('No comments yet: write one in the box under a file’s diff')
      return
    }
    const parts = [...comments.values()].map((c) => `${c.path}${c.tab === 'session' ? ' (your edit this session)' : ''}:\n${c.text}`)
    sent = true
    host.run(`Review comments on the changes:\n\n${parts.join('\n\n')}`)
    return 'close'
  }

  async function screen(tab: Tab): Promise<MenuScreen> {
    if (tab === 'git' && !git) await loadGit()
    const files = tab === 'git' ? git!.files : sessionFiles(host)
    const sel = files.find((f) => f.id === selected[tab]) ?? files[0]
    selected[tab] = sel?.id
    if (sel) await ensure(sel)
    const notRepo = tab === 'git' && !git!.result.repo
    const totals = files.reduce((a, f) => ({ added: a.added + f.added, removed: a.removed + f.removed }), { added: 0, removed: 0 })
    const fileWord = files.length === 1 ? '1 file changed' : `${files.length} files changed`
    const c = sel ? comments.get(sel.id) : undefined
    const box = sel
      ? `<input class="field dcomment" data-test="diff-comment" data-id="${esc(sel.id)}" data-path="${esc(sel.path)}" data-tab="${tab}" spellcheck="true"`
        + ` placeholder="Comment on ${esc(sel.path)}… (Enter keeps it · Ctrl+Enter sends all)" value="${esc(c?.text ?? '')}">`
      : ''
    const truncated = tab === 'git' && git!.result.repo && git!.result.truncated ? ' (truncated)' : ''
    const rows: MenuRow[] = files.map((f) => ({
      id: f.id,
      label: f.path,
      icon: comments.has(f.id) ? '✎' : '',
      tone: 'accent',
      on: f.id === sel?.id,
      meta: `${f.tag ? `${f.tag} · ` : ''}+${f.added} −${f.removed}`,
    }))
    const nComments = comments.size
    return {
      title: tab === 'git' ? (git!.result.repo ? 'Uncommitted changes (git diff HEAD)' : 'Uncommitted changes') : 'This session',
      subtitle: notRepo || !files.length ? undefined : `${fileWord} +${totals.added} −${totals.removed}${truncated}`,
      body: notRepo ? undefined : sel ? diffHtml(sel) + box : undefined,
      tabs: TABS,
      tab,
      switchTab: (id) => (keepComment(), screen(id as Tab)),
      groups: [
        { rows },
        ...(files.length ? [{ rows: [{ id: 'send', label: 'Send comments', meta: nComments ? plural(nComments, 'comment') : 'none yet', hint: 'Sends every comment as one message (Ctrl+Enter)' }] }] : []),
      ],
      empty: notRepo ? NOT_REPO : 'No changes yet',
      notes: ['←/→ switch source · ]/[ next/previous file · Ctrl+Enter sends comments'],
      reload: () => screen(tab),
      pick(row): MenuResult {
        keepComment()
        if (row.id === 'send') return send()
        selected[tab] = row.id
        return 'refresh'
      },
      key(e): MenuResult | boolean {
        const inBox = (e.target as HTMLElement | null)?.dataset?.test === 'diff-comment'
        if (e.key === 'Enter' && e.ctrlKey && !e.repeat) return send()
        if (inBox) {
          if (e.key !== 'Enter') return false
          keepComment()
          host.toast(`Comment kept for ${sel?.path} · Ctrl+Enter sends all`)
          return 'refresh'
        }
        if ((e.key === ']' || e.key === '[') && !e.ctrlKey && !e.altKey && files.length) {
          const at = Math.max(0, files.findIndex((f) => f.id === sel?.id))
          const next = files[(at + (e.key === ']' ? 1 : -1) + files.length) % files.length]
          keepComment()
          selected[tab] = next.id
          // 'refresh' keeps the focused row: focus the new file first so the list follows it.
          el()?.querySelector<HTMLElement>(`[data-test="menu-row"][data-id="${CSS.escape(next.id)}"]`)?.focus()
          return 'refresh'
        }
        return false
      },
    }
  }

  const menu = openMenu(host, 'diff', screen('git'), 'Uncommitted changes')
  // Typing in a comment box keeps it as it goes, so switching files or tabs never loses it.
  menu.el.addEventListener('input', (e) => (e.target as HTMLElement).dataset?.test === 'diff-comment' && keepComment())
  void menu.closed.then(() => !sent && host.toast('Diff dialog dismissed'))
}
