// R50 /mcp: the CLI's "Manage MCP servers" panel on the mock's servers (link/src/mock.ts mockMcpServers).
import { assert, eq, fastText, focusInput, newGame, T } from '../lib.mjs'

const row = (id) => `[data-test="mcp"] [data-test="menu-row"][data-id="${id}"]`
const title = (app) => app.eval(() => document.querySelector('[data-test="mcp"] header h2')?.textContent ?? '')

async function slash(app, text) {
  await focusInput(app)
  await app.type(text)
  // A trailing space closes the picker, so Enter sends the line as typed (arguments included).
  await app.type(' ')
  await app.key('Enter')
}

async function openMcp(app) {
  await slash(app, '/mcp')
  await app.waitVisible(T('mcp'))
  await app.waitFor(() => document.querySelector('[data-test="mcp"] header h2')?.textContent === 'Manage MCP servers', { label: '/mcp loaded' })
}

export default {
  name: '/mcp panel',
  tests: [
    {
      r: 'R50',
      name: 'servers are grouped by scope with the CLI glyphs and meta; a server opens its detail, tools and tool detail',
      async run({ app, project }) {
        await newGame(app, project)
        await fastText(app)
        await openMcp(app)
        const groups = await app.eval(() => [...document.querySelectorAll('[data-test="mcp"] .mgroup h3')].map((h) => h.firstChild.textContent.trim()))
        eq(groups, ['Project MCPs', 'User MCPs', 'claude.ai', 'Built-in MCPs'], 'group order')
        assert((await app.text(row('graft'))).includes('no tools · connected'), 'connected with no tools')
        assert((await app.text(row('linear'))).includes('needs authentication'), 'needs auth')
        assert((await app.text(row('claude.ai Slack'))).includes('2 tools'), 'tool count')
        await app.click(row('claude.ai Slack'))
        await app.waitFor(() => document.querySelector('[data-test="mcp"] header h2')?.textContent === 'claude.ai Slack MCP Server', { label: 'detail' })
        assert((await app.text(T('mcp'))).includes('Status:'), 'the detail block')
        await app.click(row('tools'))
        await app.waitFor(() => /^Tools for /.test(document.querySelector('[data-test="mcp"] header h2')?.textContent ?? ''), { label: 'tools' })
        await app.click(row('slack_send_message'))
        await app.waitFor(() => /^slack_send_message/.test(document.querySelector('[data-test="mcp"] header h2')?.textContent ?? ''), { label: 'tool detail' })
        assert((await app.text(T('mcp'))).includes('mcp__claude_ai_Slack__slack_send_message'), 'the full tool name')
        // Esc walks back one screen at a time, then closes.
        await app.key('Escape')
        assert(/^Tools for /.test(await title(app)), 'back to the tools')
        await app.key('Escape')
        await app.key('Escape')
        eq(await title(app), 'Manage MCP servers', 'back to the list')
        await app.key('Escape')
        await app.waitHidden(T('mcp'))
      },
    },
    {
      r: 'R50',
      name: 'Disable and Enable toggle a server through the SDK; Reconnect fixes a failed one',
      async run({ app, project }) {
        await newGame(app, project)
        await fastText(app)
        await openMcp(app)
        await app.click(row('graft'))
        await app.waitVisible(row('disable'))
        let m = await app.mark()
        await app.click(row('disable'))
        await app.waitSent('ctl', { op: 'toggleMcpServer' }, m)
        await app.waitVisible(row('enable'))
        assert((await app.text(T('mcp'))).includes('disabled'), 'the status says disabled')
        await app.click(row('enable'))
        await app.waitVisible(row('disable'))
        await app.key('Escape')
        await app.click(row('pencil'))
        await app.waitVisible(row('reconnect'))
        m = await app.mark()
        await app.click(row('reconnect'))
        await app.waitSent('ctl', { op: 'reconnectMcpServer' }, m)
        // pencil has no tools, so the CLI calls it "connected · no tools".
        await app.waitFor(() => /Status:s*⚠ connected · no tools/.test(document.querySelector('[data-test="mcp"]')?.textContent ?? ''), { label: 'pencil connected' })
      },
    },
    {
      r: 'R50',
      name: '/mcp disable all and /mcp reconnect run without the panel',
      async run({ app, project }) {
        await newGame(app, project)
        await fastText(app)
        let m = await app.mark()
        await slash(app, '/mcp disable all')
        await app.waitSent('ctl', { op: 'toggleMcpServer' }, m)
        await app.waitFor(() => /Disabled \d+ MCP servers/.test(document.body.innerText), { label: 'the CLI result toast' })
        assert(!(await app.count(T('mcp'))), 'no panel opened')
        m = await app.mark()
        await slash(app, '/mcp enable all')
        await app.waitSent('ctl', { op: 'toggleMcpServer' }, m)
        await app.waitFor(() => /Enabled \d+ MCP servers/.test(document.body.innerText), { label: 'enabled toast' })
      },
    },
  ],
}
