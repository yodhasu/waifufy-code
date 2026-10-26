// Slack in the page: the link's sign-in state and unread inbox, kept current from its pushes, and the requests
// the inbox viewer makes. The token never comes here; the link signs every call (link/src/slack.ts).

import type { ServerMsg, SlackConv, SlackInbox, SlackMessage, SlackStatus } from '../../link/src/protocol.ts'
import type { Link } from './contracts'

const HISTORY_TIMEOUT_MS = 30_000
/** The first listing resolves every DM partner's name under Slack's rate limits, so it can take a while. */
const CONVS_TIMEOUT_MS = 120_000
const SEND_TIMEOUT_MS = 20_000

export type SlackHistory = { channel: string; name: string; messages: SlackMessage[]; lastRead?: string }

export type Slack = {
  status(): SlackStatus
  inbox(): SlackInbox
  /** Conversations with unread messages, for badges. */
  unreadCount(): number
  /** Calls `fn` whenever the status or the inbox changes; returns the unsubscribe. */
  onChange(fn: () => void): () => void
  /** Opens Slack's sign-in in the browser for the workspace app `clientId`. */
  signIn(clientId: string): void
  cancelSignIn(): void
  signOut(): void
  /** Asks the link to rescan every conversation now. */
  refresh(): void
  conversations(): Promise<SlackConv[]>
  history(channel: string, thread?: string): Promise<SlackHistory>
  markRead(channel: string, ts: string): void
  send(channel: string, text: string, thread?: string): Promise<void>
}

let seq = 0
const EMPTY: SlackInbox = { convs: [], scanned: 0, total: 0, updatedAt: 0 }

export function createSlack(link: Link, initial: SlackStatus | undefined): Slack {
  let status: SlackStatus = initial ?? { signedIn: false, signingIn: false }
  let inbox = EMPTY
  const subs = new Set<() => void>()
  const changed = () => subs.forEach((fn) => fn())

  link.on((m: ServerMsg) => {
    if (m.t === 'slack_status') {
      status = m.status
      if (!status.signedIn) inbox = EMPTY
      changed()
    } else if (m.t === 'slack_inbox') {
      inbox = m.inbox
      changed()
    }
  })
  // After a reconnect (the link restarted), ask again: pushes sent while down are gone.
  link.onStatus((s) => s === 'up' && link.send({ t: 'slack_inbox' }))
  link.send({ t: 'slack_inbox' })

  async function ask<T extends ServerMsg>(send: (id: string) => Parameters<Link['send']>[0], match: (m: ServerMsg, id: string) => m is T, timeoutMs: number) {
    const id = `slack-${++seq}`
    const reply = link.next((m): m is T => match(m, id), timeoutMs)
    link.send(send(id))
    return reply
  }

  return {
    status: () => status,
    inbox: () => inbox,
    unreadCount: () => inbox.convs.length,
    onChange(fn) {
      subs.add(fn)
      return () => void subs.delete(fn)
    },
    signIn: (clientId) => link.send({ t: 'slack_signin', clientId }),
    cancelSignIn: () => link.send({ t: 'slack_signin_cancel' }),
    signOut: () => link.send({ t: 'slack_signout' }),
    refresh: () => link.send({ t: 'slack_inbox', refresh: true }),
    async conversations() {
      const reply = link.next((m): m is Extract<ServerMsg, { t: 'slack_convs' }> => m.t === 'slack_convs', CONVS_TIMEOUT_MS)
      link.send({ t: 'slack_convs' })
      const r = await reply
      if (r.error) throw new Error(r.error)
      return r.convs
    },
    async history(channel, thread) {
      type Reply = Extract<ServerMsg, { t: 'slack_history' }>
      const r = await ask<Reply>(
        (id) => ({ t: 'slack_history', id, channel, ...(thread ? { thread } : {}) }),
        (m, id): m is Reply => m.t === 'slack_history' && m.id === id,
        HISTORY_TIMEOUT_MS,
      )
      if (r.error || !r.messages) throw new Error(r.error ?? 'Slack sent no messages.')
      return { channel: r.channel, name: r.name ?? r.channel, messages: r.messages, ...(r.lastRead ? { lastRead: r.lastRead } : {}) }
    },
    markRead: (channel, ts) => link.send({ t: 'slack_mark', channel, ts }),
    async send(channel, text, thread) {
      type Reply = Extract<ServerMsg, { t: 'slack_sent' }>
      const r = await ask<Reply>(
        (id) => ({ t: 'slack_send', id, channel, text, ...(thread ? { thread } : {}) }),
        (m, id): m is Reply => m.t === 'slack_sent' && m.id === id,
        SEND_TIMEOUT_MS,
      )
      if (!r.ok) throw new Error(r.error ?? 'Slack didn\'t take the message.')
    },
  }
}
