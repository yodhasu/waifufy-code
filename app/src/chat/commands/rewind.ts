import type { RewindPoint } from '../../../../link/src/protocol.ts'
import { esc } from '../../ui'
import { control } from '../control'
import { openMenu, type MenuResult, type MenuRow, type MenuScreen } from '../menu'
import type { CommandHost } from './index'

// /rewind (aliases /checkpoint, /undo) and Esc Esc, as the CLI 2.1.309 draws its message selector
// (docs/research/cli-session.md "Rewind / checkpoints"): the prompts newest first with each one's code changes,
// then a confirm screen whose options restore the code (rewindFiles), the conversation (a restart of the save cut
// before that prompt, with the prompt back in the composer), or both. The CLI's two "Summarize" options use partial
// compaction, which has no SDK surface, so they are left out with a footer note.

/** The SDK's RewindFilesResult. */
type FileStats = { canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number; skippedLinks?: number }

/** How many of the newest prompts get their code stats on the list (each is one dry-run control). */
const STATS_ROWS = 20
/** A dry run that takes longer than this leaves its row without stats rather than holding the menu. */
const STATS_WAIT_MS = 4000

const WARNING = '⚠ Rewinding does not affect files edited manually or via bash.'
const NO_SUMMARIZE = '"Summarize from here" and "Summarize up to here" need claude in a terminal.'

const base = (path: string) => path.split(/[\\/]/).pop() || path
const counts = (s: FileStats) => `+${s.insertions ?? 0} −${s.deletions ?? 0}`
const codeChanged = (s: FileStats | undefined) => !!s?.canRewind && !!s.filesChanged?.length
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

function dryRun(host: CommandHost, uuid: string) {
  return control<FileStats>(host.link, 'rewindFiles', uuid, { dryRun: true })
}

/** The list row's dim second line: "<file> +a −r", "N files changed +a −r", "No code changes", "⚠ No code restore". */
function statsLine(s: FileStats | undefined) {
  if (!s) return undefined
  if (!s.canRewind) return '⚠ No code restore'
  const files = s.filesChanged ?? []
  if (!files.length) return 'No code changes'
  return files.length === 1 ? `${base(files[0])} ${counts(s)}` : `${files.length} files changed ${counts(s)}`
}

/** The confirm screen's code line for an option that restores code. */
function codeLine(s: FileStats | undefined) {
  if (!codeChanged(s)) return 'The code has not changed (nothing will be restored).'
  const files = s!.filesChanged!.map(base)
  const rest = files.length === 2 ? ` and ${files[1]}` : files.length > 2 ? ` and ${files.length - 1} other files` : ''
  return `The code will be restored ${counts(s!)} in ${files[0]}${rest}.`
}

export function rewindCommand(host: CommandHost, _args: string, _typed: string) {
  openMenu(host, 'rewind', listScreen(host), 'Rewind')
}

async function listScreen(host: CommandHost): Promise<MenuScreen> {
  const points = await control<RewindPoint[]>(host.link, 'rewindPoints')
  const timeout = new Promise<undefined>((r) => setTimeout(() => r(undefined), STATS_WAIT_MS))
  const stats = await Promise.all(
    points.map((p, i) => (i < STATS_ROWS ? Promise.race([dryRun(host, p.uuid).catch(() => undefined), timeout]) : undefined)),
  )
  const anyHistory = stats.some((s) => s?.canRewind)
  const rows: MenuRow[] = points.map((p, i) => ({ id: p.uuid, label: oneLine(p.text), hint: statsLine(stats[i]) }))
  return {
    title: 'Rewind',
    subtitle: anyHistory
      ? 'Restore the code and/or conversation to the point before…'
      : 'Restore and fork the conversation to the point before…',
    groups: points.length ? [{ rows: [{ id: 'current', label: '(current)', disabled: true }, ...rows] }] : [],
    empty: 'Nothing to rewind to yet.',
    search: points.length > 8,
    pick: async (row) => {
      const i = points.findIndex((p) => p.uuid === row.id)
      if (i < 0) return
      // Always fresh for the picked prompt: the list's stats may have timed out or gone stale.
      const s = await dryRun(host, points[i].uuid).catch(() => stats[i])
      return confirmScreen(host, points[i], s)
    },
    reload: () => listScreen(host),
  }
}

function confirmScreen(host: CommandHost, point: RewindPoint, s: FileStats | undefined): MenuScreen {
  const code = codeChanged(s)
  const forked = 'The conversation will be forked.'
  const unchanged = 'The conversation will be unchanged.'
  const rows: MenuRow[] = [
    ...(code ? [{ id: 'both', label: 'Restore code and conversation', hint: `${forked} ${codeLine(s)}` }] : []),
    { id: 'conversation', label: 'Restore conversation', hint: `${forked} ${code ? 'The code will be unchanged.' : codeLine(s)}` },
    ...(code ? [{ id: 'code', label: 'Restore code', hint: `${unchanged} ${codeLine(s)}` }] : []),
    { id: 'nevermind', label: 'Never mind', hint: `${unchanged} The code will be unchanged.` },
  ]
  return {
    title: 'Rewind',
    body: `<p>Confirm you want to restore ${code ? '' : 'the conversation '}to the point before you sent this message:</p>`
      + `<blockquote class="rw-quote" data-test="rewind-quote">${esc(point.text)}</blockquote>`,
    groups: [{ rows }],
    notes: [WARNING, NO_SUMMARIZE],
    pick: (row) => restore(host, point, row.id),
  }
}

async function restore(host: CommandHost, point: RewindPoint, how: string): Promise<MenuResult> {
  if (how === 'nevermind') return 'close'
  const withCode = how === 'both' || how === 'code'
  const withConversation = how === 'both' || how === 'conversation'
  if (withConversation && !host.sessionId()) {
    host.toast('Failed to restore the conversation: there is no saved conversation yet.')
    return 'close'
  }
  // Code first: the conversation restore restarts the session that holds the file history.
  if (withCode) {
    const failed = how === 'both' ? 'Failed to restore the conversation and code:' : 'Failed to restore the code:'
    let r: FileStats
    try {
      r = await control<FileStats>(host.link, 'rewindFiles', point.uuid)
    } catch (e) {
      host.toast(`${failed} ${e instanceof Error ? e.message : String(e)}`)
      return 'close'
    }
    if (!r.canRewind) {
      host.toast(`${failed} ${r.error ?? 'nothing to restore'}`)
      return 'close'
    }
    if (r.skippedLinks) {
      host.toast(`Restored the code, but skipped ${r.skippedLinks} file${r.skippedLinks === 1 ? '' : 's'}. Skipped files were left untouched — run with --debug for the paths.`)
    }
  }
  if (withConversation) {
    if (point.before) host.rewind({ resumeAt: point.before, dropsTurn: point.uuid, draft: point.text })
    else {
      // The first prompt: nothing comes before it, so the conversation restarts fresh with the prompt as the draft.
      host.run('/clear')
      host.setDraft(point.text)
    }
  }
  return 'close'
}
