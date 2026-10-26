import type { SlackConv, SlackMessage } from '../../../../link/src/protocol.ts'
import type { SlackHistory } from '../../slack'
import { esc } from '../../ui'
import { openMenu, type MenuGroup, type MenuResult, type MenuRow, type MenuScreen } from '../menu'
import type { CommandHost } from './index'

// /slack and the quick menu's SLACK button: the unread inbox, every conversation, a conversation or thread as rows
// (oldest first, opening on the first unread one), replying, and marking read. Opening a conversation doesn't mark
// it read: that stays the person's choice, as does every message she sends for them (link/src/slack-tools.ts).

const KIND_ICON: Record<SlackConv['kind'], string> = { dm: '✉', group: '✉', channel: '#', private: '🔒' }

const isDirect = (c: SlackConv) => c.kind === 'dm' || c.kind === 'group'
const unreadMeta = (c: SlackConv) => (c.unread ? `${c.unread}${c.more ? '+' : ''} unread` : '')

/** A Slack ts as a local time: "14:05" today, "Mon 26 Oct 14:05" before. */
function when(ts: string) {
  const d = new Date(Number(ts.split('.')[0]) * 1000)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`
}

/** Compares Slack timestamps as numbers (link/src/slack.ts tsCompare, which can't be imported here). */
const after = (a: string, b: string) => {
  const [ai = '', af = ''] = a.split('.')
  const [bi = '', bf = ''] = b.split('.')
  return ai.length !== bi.length ? ai.length > bi.length : ai !== bi ? ai > bi : af.padEnd(6, '0') > bf.padEnd(6, '0')
}

function convRow(c: SlackConv): MenuRow {
  return {
    id: `c:${c.id}`,
    label: c.name,
    icon: c.unread ? '●' : KIND_ICON[c.kind],
    tone: c.mention ? 'accent' : c.unread ? 'ok' : 'muted',
    meta: unreadMeta(c),
    ...(c.preview ? { hint: `${c.preview.user}: ${c.preview.text}` } : {}),
  }
}

export function slackCommand(host: CommandHost) {
  const slack = host.ctx.slack
  const open = (target: string) => host.link.send({ t: 'open', target })

  function setup(): MenuScreen {
    const s = slack.status()
    const body = s.signingIn
      ? '<p>Waiting for you to approve the sign-in in your browser…</p>'
      : `<p>Slack isn't connected yet.${s.error ? ` <b>${esc(s.error)}</b>` : ''}</p><p>Set it up in <b>Settings → Slack</b>: create the workspace's app from the manifest there, paste its client ID, and sign in.</p>`
    return {
      title: 'Slack',
      body,
      groups: [{ rows: [s.signingIn ? { id: 'cancel', label: 'Cancel the sign-in', icon: '✗' } : { id: 'settings', label: 'Open Slack settings', icon: '⚙' }] }],
      reload: async () => screenNow(),
      pick(r) {
        if (r.id === 'cancel') return void slack.cancelSignIn()
        host.ctx.router.go('settings', { tab: 'slack' })
        return 'close'
      },
    }
  }

  function inboxScreen(): MenuScreen {
    const s = slack.status()
    const i = slack.inbox()
    const direct = i.convs.filter(isDirect)
    const channels = i.convs.filter((c) => !isDirect(c))
    const scanning = i.total > 0 && i.scanned < i.total
    const groups: MenuGroup[] = [
      { title: 'Direct messages', rows: direct.map(convRow) },
      { title: 'Channels', rows: channels.map(convRow) },
      {
        title: 'More',
        rows: [
          { id: 'all', label: 'Every conversation…', icon: '☰', hint: 'Read one with nothing unread' },
          { id: 'refresh', label: 'Check again now', icon: '⟳' },
          ...(s.url ? [{ id: 'web', label: 'Open Slack in the browser', icon: '↗', meta: s.url.replace(/^https?:\/\//, '').replace(/\/$/, '') }] : []),
        ],
      },
    ]
    return {
      title: 'Slack',
      subtitle: `${s.team ?? 'Slack'} · ${s.user ?? ''}${i.convs.length ? '' : ' · nothing unread'}`,
      groups,
      search: true,
      notes: [
        scanning
          ? `Checking conversations: ${i.scanned} of ${i.total}. Slack has no unread count for channels, so each one is read in turn.`
          : i.updatedAt
            ? `Checked ${i.total} conversations at ${new Date(i.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}; again every minute.`
            : 'Starting to check your conversations…',
      ],
      reload: async () => screenNow(),
      pick(r) {
        if (r.id === 'all') return allScreen()
        if (r.id === 'refresh') return void (slack.refresh(), host.toast('Checking every conversation again…'))
        if (r.id === 'web') return void open(s.url!)
        return conversationScreen(r.id.slice(2))
      },
    }
  }

  const screenNow = () => (slack.status().signedIn ? inboxScreen() : setup())

  async function allScreen(): Promise<MenuScreen> {
    const convs = await slack.conversations()
    return {
      title: 'Every conversation',
      subtitle: `${convs.length} you're in`,
      groups: [
        { title: 'Direct messages', rows: convs.filter(isDirect).map(convRow) },
        { title: 'Channels', rows: convs.filter((c) => !isDirect(c)).map(convRow) },
      ],
      search: true,
      pick: (r) => conversationScreen(r.id.slice(2)),
    }
  }

  function messageRow(m: SlackMessage, unread: boolean, thread: boolean): MenuRow {
    const files = m.files?.length ? `\n📎 ${m.files.join(', ')}` : ''
    return {
      id: `m:${m.ts}`,
      label: m.mine ? `${m.user} (you)` : m.user,
      icon: unread ? '●' : '',
      tone: unread ? 'accent' : 'muted',
      meta: `${!thread && m.replies ? `💬 ${m.replies} · ` : ''}${when(m.ts)}`,
      hint: (m.text || (files ? '' : '(no text)')) + files,
    }
  }

  /** Conversations (or threads) to fetch again on their next reload: something was sent there. */
  const stale = new Set<string>()

  async function conversationScreen(channel: string, thread?: string): Promise<MenuScreen> {
    let h = await slack.history(channel, thread)
    const key = `${h.channel}|${thread ?? ''}`
    // The inbox pushes as the scan goes, and every push reloads the open screens: rebuild from what's here,
    // and only fetch again after a send.
    const reload = async () => (stale.delete(key) ? conversationScreen(h.channel, thread) : build())
    const build = (): MenuScreen => conversationView(h, thread, key, reload, (lastRead) => (h = { ...h, lastRead }))
    return build()
  }

  function conversationView(h: SlackHistory, thread: string | undefined, key: string, reload: () => Promise<MenuScreen>, setRead: (ts: string) => void): MenuScreen {
    const unread = (m: SlackMessage) => !thread && !!h.lastRead && !m.mine && after(m.ts, h.lastRead)
    const firstUnread = h.messages.find(unread)
    const newest = h.messages.at(-1)
    const rows = h.messages.map((m) => messageRow(m, unread(m), !!thread))
    return {
      title: thread ? `Thread in ${h.name}` : h.name,
      subtitle: thread ? `${h.messages.length - 1} replies` : firstUnread ? `${h.messages.filter(unread).length} unread` : `Latest ${h.messages.length} messages`,
      groups: [
        { rows, ...(rows.length ? {} : { note: 'No messages yet.' }) },
        {
          title: 'Actions',
          rows: [
            { id: 'reply', label: thread ? 'Reply in the thread…' : 'Write a message…', icon: '✎' },
            ...(thread ? [] : [{ id: 'read', label: 'Mark as read', icon: '✓', disabled: !firstUnread, hint: firstUnread ? '' : 'Nothing unread here' }]),
            { id: 'slack', label: 'Open in Slack', icon: '↗' },
          ],
        },
      ],
      search: true,
      focus: firstUnread ? `m:${firstUnread.ts}` : newest ? `m:${newest.ts}` : undefined,
      notes: thread ? [] : ['Enter on a message with replies opens its thread.'],
      reload,
      pick(r): MenuResult | Promise<MenuResult> {
        if (r.id === 'reply') return void compose(h, key, thread)
        if (r.id === 'read') {
          if (!newest) return
          slack.markRead(h.channel, newest.ts)
          setRead(newest.ts)
          host.toast(`Marked ${h.name} read`)
          return 'refresh'
        }
        if (r.id === 'slack') return void open(`https://slack.com/app_redirect?channel=${h.channel}`)
        const m = h.messages.find((x) => `m:${x.ts}` === r.id)
        if (!thread && m?.replies) return conversationScreen(h.channel, m.ts)
      },
    }
  }

  /** A small writing box over the conversation; Ctrl+Enter or Send posts it as the person. */
  function compose(h: SlackHistory, key: string, thread?: string) {
    const box = host.modal({
      test: 'slack-compose',
      title: thread ? `Reply in the thread · ${h.name}` : `Message ${h.name}`,
      cls: 'slack-compose',
      body: `<textarea class="field" data-test="slack-compose-text" rows="6" spellcheck="true" placeholder="Sent as you, in Slack's formatting (*bold*, _italic_, \`code\`)"></textarea>
        <div class="set-actions"><span class="mnote">Ctrl+Enter to send</span><button class="btn primary" type="button" data-test="slack-compose-send">Send</button></div>`,
      key(e) {
        if (e.key === 'Enter' && e.ctrlKey) return void sendIt(), true
        return false
      },
    })
    const ta = box.el.querySelector<HTMLTextAreaElement>('textarea')!
    const btn = box.el.querySelector<HTMLButtonElement>('[data-test="slack-compose-send"]')!
    btn.onclick = () => void sendIt()
    ta.focus()
    async function sendIt() {
      const text = ta.value.trim()
      if (!text || btn.disabled) return
      btn.disabled = true
      try {
        await slack.send(h.channel, text, thread)
        box.close()
        host.toast(`Sent to ${h.name}`)
        stale.add(key)
        // A reply in a thread also changes the parent's reply count in the conversation below it.
        if (thread) stale.add(`${h.channel}|`)
        void menu.refresh()
      } catch (e) {
        host.toast(e instanceof Error ? e.message : String(e))
        btn.disabled = false
      }
    }
  }

  const menu = openMenu(host, 'slack', screenNow(), 'Slack')
  // The inbox fills in as the link scans; open screens follow it.
  const off = slack.onChange(() => void menu.refresh())
  void menu.closed.then(off)
}
