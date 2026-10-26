import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import * as slack from './slack.ts'

// Her Slack tools: an in-process MCP server over link/src/slack.ts, signed in as the person. Reading and marking
// as read run without asking; every send asks the person first (`confirm`), whatever the permission mode,
// because it speaks for them. Tool output is plain text for her to read, never stored.

export const SLACK_SERVER = 'waifufy-slack'
const tools = ['unreads', 'read', 'mark_read', 'send', 'search'] as const
/** For `allowedTools`: none of these goes through the CLI's own permission prompt (sends ask in `send`). */
export const SLACK_TOOL_NAMES = tools.map((t) => `mcp__${SLACK_SERVER}__${t}`)

const SEARCH_MAX = 50
const READ_MAX = 40

/** The person's answer to a send: `ok`, or why not (their note when they said what to change). */
export type SendVerdict = { ok: boolean; message?: string }
export type ConfirmSend = (o: { to: string; text: string; thread?: string }) => Promise<SendVerdict>

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) })

/** Runs a tool body, turning Slack's errors into a readable tool error instead of a crash. */
async function run(body: () => Promise<string>) {
  try {
    return text(await body())
  } catch (e) {
    return text(e instanceof Error ? e.message : String(e), true)
  }
}

const quote = (s: string) => s.split('\n').map((l) => `  ${l}`).join('\n')

export function slackServer(confirm: ConfirmSend) {
  return createSdkMcpServer({
    name: SLACK_SERVER,
    version: '1.0.0',
    instructions:
      'The user\'s own Slack, signed in as them. Messages you send appear as written by the user, not by you: write them '
      + 'in the user\'s voice, plainly, with no persona, emotion tags or Japanese lines. The user approves every send. '
      + 'Conversations are named like #channel, by a person\'s name for a DM, or by ID. Timestamps (ts) identify messages and threads.',
    tools: [
      tool(
        'unreads',
        'The user\'s unread Slack conversations: how many unread each has, whether one mentions them, and the newest message. '
        + 'Counts come from a scan that walks every conversation in turn, so it may be a minute behind.',
        {},
        () => run(async () => {
          const s = slack.status()
          if (!s.signedIn) throw new Error('Slack isn\'t connected. The user can sign in from Settings → Slack.')
          const i = slack.inbox()
          const done = i.total && i.scanned >= i.total ? '' : ` (still scanning: ${i.scanned}/${i.total} conversations so far)`
          if (!i.convs.length) return `Nothing unread in ${s.team}${done}.`
          const lines = i.convs.map((c) => {
            const n = `${c.unread}${c.more ? '+' : ''} unread${c.mention ? ', mentions you' : ''}`
            const last = c.preview ? `\n  newest (ts ${c.preview.ts}) ${c.preview.user}: ${c.preview.text}` : ''
            return `- ${c.name} [${c.id}]: ${n}${last}`
          })
          return `Unread in ${s.team}${done}:\n${lines.join('\n')}`
        }),
        { annotations: { readOnlyHint: true }, alwaysLoad: true },
      ),
      tool(
        'read',
        'Reads a conversation\'s latest messages, oldest first, or a whole thread when thread_ts is given. Does not mark anything read.',
        {
          channel: z.string().describe('#channel, a person\'s name (their DM), or a conversation ID'),
          thread_ts: z.string().optional().describe('The ts of a thread\'s parent message, to read that thread'),
          limit: z.number().int().min(1).max(READ_MAX).optional().describe(`How many of the latest messages (default ${READ_MAX})`),
        },
        (a) => run(async () => {
          const h = await slack.history(a.channel, a.thread_ts)
          const list = a.limit ? h.messages.slice(-a.limit) : h.messages
          if (!list.length) return `${h.conv.name}: no messages.`
          const read = h.lastRead
          const lines = list.map((m) => {
            const isNew = read && !m.mine && slack.tsCompare(m.ts, read) > 0 ? ' (unread)' : ''
            const extra = [m.replies ? `${m.replies} replies` : '', m.files?.length ? `files: ${m.files.join(', ')}` : ''].filter(Boolean).join('; ')
            return `[ts ${m.ts}] ${m.mine ? 'You' : m.user}${isNew}${extra ? ` (${extra})` : ''}:\n${quote(m.text || '(no text)')}`
          })
          return `${a.thread_ts ? `Thread ${a.thread_ts} in ` : ''}${h.conv.name} [${h.conv.id}]:\n${lines.join('\n')}`
        }),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'mark_read',
        'Marks a conversation read for the user, up to a message (ts) or up to its newest message.',
        {
          channel: z.string().describe('#channel, a person\'s name (their DM), or a conversation ID'),
          ts: z.string().optional().describe('Read up to and including this message; default: the newest'),
        },
        (a) => run(async () => {
          const c = await slack.markRead(a.channel, a.ts)
          return `Marked ${c.name} read${a.ts ? ` up to ${a.ts}` : ''}.`
        }),
        { annotations: { idempotentHint: true } },
      ),
      tool(
        'send',
        'Sends a Slack message as the user, to a conversation or into a thread. The user sees the exact text and must approve it '
        + 'first; if they decline, do not retry the same message unless they ask.',
        {
          channel: z.string().describe('#channel, a person\'s name (their DM), or a conversation ID'),
          text: z.string().min(1).describe('The message, in Slack mrkdwn. Written as the user, in their voice.'),
          thread_ts: z.string().optional().describe('Reply in this thread (the parent message\'s ts)'),
        },
        (a) => run(async () => {
          const c = await slack.resolve(a.channel)
          const verdict = await confirm({ to: c.name, text: a.text, ...(a.thread_ts ? { thread: a.thread_ts } : {}) })
          if (!verdict.ok) return verdict.message ?? 'The user declined; nothing was sent.'
          const r = await slack.send(c.id, a.text, a.thread_ts)
          return `Sent to ${r.conv.name}${a.thread_ts ? ` (thread ${a.thread_ts})` : ''} as ts ${r.ts}.`
        }),
        { annotations: { destructiveHint: false, openWorldHint: true } },
      ),
      tool(
        'search',
        'Searches the user\'s Slack messages. Supports Slack modifiers like in:#channel, from:@name, before:/after:YYYY-MM-DD, has:link.',
        {
          query: z.string().min(1),
          count: z.number().int().min(1).max(SEARCH_MAX).optional().describe('Results, newest first (default 20)'),
        },
        (a) => run(async () => {
          const hits = await slack.search(a.query, a.count)
          if (!hits.length) return `No messages match "${a.query}".`
          return hits.map((h) => `[${h.channel} · ts ${h.ts}] ${h.user}:\n${quote(h.text)}`).join('\n')
        }),
        { annotations: { readOnlyHint: true } },
      ),
    ],
  })
}
