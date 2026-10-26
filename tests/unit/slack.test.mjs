// Unit check of the Slack service in the link against its mock workspace: sign-in, the unread scan, reading,
// marking read, sending, search, Slack markup as plain text, and her tool server. Run: node tests/unit/slack.test.mjs
// (no app, no Slack, no Claude).
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'wc-slack-'))
process.env.WC_DATA_DIR = dir
process.env.WC_MOCK = '1'

const slack = await import('../../link/src/slack.ts')
const { SLACK_MANIFEST, SLACK_REDIRECT_URL } = await import('../../link/src/slack-app.ts')
const { SLACK_TOOL_NAMES } = await import('../../link/src/slack-tools.ts')

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`PASS  ${name}`)
  } catch (e) {
    failures++
    console.log(`FAIL  ${name}\n      ${e.stack ?? e.message}`)
  }
}
const eq = (a, b, msg) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
}
const ok = (v, msg) => {
  if (!v) throw new Error(msg)
}
/** Waits for the inbox scan to cover every conversation. */
async function scanned() {
  for (let i = 0; i < 100; i++) {
    const i2 = slack.inbox()
    if (i2.total && i2.scanned >= i2.total && i2.updatedAt) return i2
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`the scan never finished: ${JSON.stringify(slack.inbox())}`)
}

await test('timestamps compare as numbers, not as text', () => {
  eq(slack.tsCompare('1700000000.000200', '1700000000.000100'), 1, 'later fraction')
  eq(slack.tsCompare('999999999.900000', '1000000000.000000'), -1, 'shorter integer part')
  eq(slack.tsCompare('1700000000.5', '1700000000.400000'), 1, 'short fraction')
  eq(slack.tsCompare(undefined, '1'), -1, 'missing sorts first')
})

await test('Slack markup becomes plain text', async () => {
  const names = { U1: 'Alice' }
  const t = await slack.plainText('hi <@U1> see <#C123|general> and <https://x.dev|the docs> or <https://y.dev> &lt;3 <!here>', async (id) => names[id])
  eq(t, 'hi @Alice see #general and the docs (https://x.dev) or https://y.dev <3 @here', 'text')
})

await test('the manifest asks for user scopes only, PKCE, and the callback the link listens on', () => {
  ok(SLACK_MANIFEST.includes(`- ${SLACK_REDIRECT_URL}`), 'redirect url listed')
  ok(SLACK_MANIFEST.includes('pkce_enabled: true'), 'pkce')
  ok(!/\bbot:/.test(SLACK_MANIFEST), 'no bot scopes')
  ok(SLACK_MANIFEST.includes('- chat:write') && SLACK_MANIFEST.includes('- im:history'), 'scopes')
})

await test('signed out: status says so, calls refuse with a readable reason', async () => {
  eq(slack.status().signedIn, false, 'signed in')
  let err
  await slack.history('#general').catch((e) => (err = e))
  ok(err?.message.includes('Settings → Slack'), `error: ${err?.message}`)
})

await test('a client ID Slack refuses: the error shows and nothing is stored', async () => {
  await slack.signIn('mock-fail', () => {})
  const s = slack.status()
  eq([s.signedIn, s.signingIn], [false, false], 'state')
  ok(s.error?.includes('client ID'), `error: ${s.error}`)
  ok(!existsSync(join(dir, 'slack.json')), 'no file')
})

await test('sign-in stores the token in its own private file and reports who is signed in', async () => {
  const seen = []
  const off = slack.onStatus((s) => seen.push(s.signingIn))
  await slack.signIn('123.456', () => {})
  off()
  const s = slack.status()
  eq([s.signedIn, s.team, s.user, s.error], [true, 'Mock Team', 'You', undefined], 'status')
  eq(seen.slice(0, 1), [true], 'signing in reported first')
  const file = JSON.parse(readFileSync(join(dir, 'slack.json'), 'utf8'))
  eq([file.token, file.clientId, file.userId], ['xoxp-mock', '123.456', 'U0ME'], 'stored')
  if (process.platform !== 'win32') eq(statSync(join(dir, 'slack.json')).mode & 0o777, 0o600, 'mode')
  ok(!JSON.stringify(file).includes('deploy'), 'no message text on disk')
})

await test('the scan finds unread conversations, DMs first, with mentions and previews', async () => {
  const i = await scanned()
  eq(i.total, 4, 'conversations')
  const byName = Object.fromEntries(i.convs.map((c) => [c.name, c]))
  eq(i.convs[0].name, 'Alice', 'a DM comes first')
  eq(byName.Alice.unread, 2, 'DM unread')
  eq(byName['#general'].unread, 3, 'channel unread')
  eq(byName['#general'].mention, true, 'mention')
  ok(!byName['#random'], '#random is read')
  ok(!byName['alice, bob, you'], 'the group DM was read up to its only message')
  eq(byName['#general'].preview.text, 'Shipped the fix', 'preview')
  eq(byName.Alice.preview.text, 'Ping me when it\'s live status page (https://example.com/status)', 'link in preview')
})

await test('reading a conversation: oldest first, names resolved, the read cursor, mine flagged', async () => {
  const h = await slack.history('#general')
  eq(h.messages.map((m) => m.text), ['Standup in 5', 'Lunch?', '@You can you review #42?', 'Shipped the fix'], 'texts')
  eq(h.messages[1].replies, 2, 'reply count')
  ok(h.lastRead, 'last read')
  const dm = await slack.history('alice')
  eq([dm.conv.id, dm.messages[0].mine], ['D0ALICE', true], 'a DM by name')
  const thread = await slack.history('#general', h.messages[1].ts)
  eq(thread.messages.map((m) => m.user), ['Alice', 'Bob', 'Alice'], 'thread')
})

await test('an unknown conversation name says how to name one', async () => {
  let err
  await slack.resolve('#nope').catch((e) => (err = e))
  ok(err?.message.includes('#channel'), `error: ${err?.message}`)
})

await test('marking read clears the badge for that conversation', async () => {
  const before = slack.inbox().convs.length
  await slack.markRead('#general')
  ok(!slack.inbox().convs.some((c) => c.name === '#general'), 'general gone')
  eq(slack.inbox().convs.length, before - 1, 'count')
})

await test('sending posts as the person and reads the conversation', async () => {
  const r = await slack.send('Alice', 'It\'s live!')
  ok(r.ts, 'ts')
  const h = await slack.history('Alice')
  eq([h.messages.at(-1).text, h.messages.at(-1).mine], ['It\'s live!', true], 'posted')
  ok(!slack.inbox().convs.some((c) => c.name === 'Alice'), 'answering read the DM')
  let err
  await slack.send('Alice', '   ').catch((e) => (err = e))
  eq(err?.code, 'no_text', 'empty refused')
})

await test('search resolves channels and people', async () => {
  const hits = await slack.search('review')
  eq(hits.map((h) => [h.channel, h.user, h.text]), [['#general', 'Bob', '@You can you review #42?']], 'hits')
})

await test('her tools skip the CLI prompt by name; send is among them because it asks by itself', () => {
  eq(SLACK_TOOL_NAMES, ['unreads', 'read', 'mark_read', 'send', 'search'].map((t) => `mcp__waifufy-slack__${t}`), 'names')
})

await test('signing out forgets the token and the inbox', async () => {
  await slack.signOut()
  eq(slack.status().signedIn, false, 'signed out')
  eq(slack.inbox().convs.length, 0, 'inbox cleared')
  ok(!existsSync(join(dir, 'slack.json')), 'file removed')
})

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
