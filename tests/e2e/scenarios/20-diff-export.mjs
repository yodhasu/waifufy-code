// R63 /diff (uncommitted changes from git, and this session's edits), /export (to a file) and /copy [N].
// The project is a real git repo: setup commits the test files, then changes one and adds an untracked one.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, eq, fastText, focusInput, newGame, readAll, say, T, turnEnd } from '../lib.mjs'

const row = (id) => `[data-test="diff"] [data-test="menu-row"][data-id="${id}"]`
const title = (app, test) => app.eval((t) => document.querySelector(`[data-test="${t}"] header h2`)?.textContent ?? '', test)
const toast = (app, text) => app.waitFor((t) => document.getElementById('toast')?.textContent.includes(t), { args: [text], label: `toast “${text}”` })
const viewing = (app) => app.eval(() => document.querySelector('[data-test="diff-view"]')?.dataset.path ?? '')

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args], { cwd, stdio: 'pipe' })

/** Commits the project as it is, then edits the loader and adds an untracked note. */
function seedRepo(project) {
  git(project, 'add', '-A')
  git(project, 'commit', '-q', '-m', 'init')
  writeFileSync(join(project, 'src', 'prompts', 'loader.ts'), "const TEMPLATE = 'booking-v13'\nexport const prompt = () => TEMPLATE\n")
  writeFileSync(join(project, 'TODO.md'), '# Todo\n\n- ship v14\n')
}

/** Types a command line (arguments included) and sends it as typed. */
async function slash(app, text) {
  await focusInput(app)
  await app.type(text)
  await app.type(' ')
  await app.key('Enter')
}

async function closePanel(app, name) {
  for (let i = 0; i < 6 && (await app.visible(T(name))); i++) await app.key('Escape')
  await app.waitHidden(T(name))
}

export default {
  name: '/diff, /export and /copy',
  async setup({ app, project }) {
    seedRepo(project)
    await newGame(app, project)
    await fastText(app)
  },
  tests: [
    {
      r: 'R63',
      name: '/diff lists the changed and untracked files with +N −M, shows the colored diff, ]/[ walk the files, comments are sent as one message',
      timeout: 60_000,
      async run({ app }) {
        await slash(app, '/diff')
        await app.waitVisible(T('diff'))
        await app.waitFor(() => document.querySelector('[data-test="diff"] header h2')?.textContent === 'Uncommitted changes (git diff HEAD)', { label: '/diff loaded' })
        const tabs = await app.eval(() => [...document.querySelectorAll('[data-test="diff"] [data-test="menu-tab"]')].map((b) => b.textContent))
        eq(tabs, ['Uncommitted changes', 'This session'], 'the two sources')
        const panel = await app.text(T('diff'))
        assert(panel.includes('2 files changed +4 −1'), `the summary line: ${panel}`)
        const loader = await app.text(row('g:0'))
        assert(loader.includes('src/prompts/loader.ts') && loader.includes('+1 −1'), `the changed file row: ${loader}`)
        const todo = await app.text(row('u:0'))
        assert(todo.includes('TODO.md') && todo.includes('untracked') && todo.includes('+3 −0'), `the untracked row: ${todo}`)

        // The first file's diff is open: the removed and added lines in red and green.
        eq(await viewing(app), 'src/prompts/loader.ts', 'the first file is shown')
        const lines = await app.eval(() => ({
          del: [...document.querySelectorAll('[data-test="diff-view"] .dl.del span')].map((s) => s.textContent),
          add: [...document.querySelectorAll('[data-test="diff-view"] .dl.add span')].map((s) => s.textContent),
        }))
        eq(lines.del, ["const TEMPLATE = 'booking-v12'"], 'the removed line')
        eq(lines.add, ["const TEMPLATE = 'booking-v13'"], 'the added line')

        // ] and [ jump between files; picking a row shows it too.
        await app.key(']')
        await app.waitFor(() => document.querySelector('[data-test="diff-view"]')?.dataset.path === 'TODO.md', { label: '] shows the next file' })
        assert((await app.text(T('diff-view'))).includes('- ship v14'), 'the untracked file is all added lines')
        await app.key('[')
        await app.waitFor(() => document.querySelector('[data-test="diff-view"]')?.dataset.path === 'src/prompts/loader.ts', { label: '[ goes back' })

        // A comment on each file, then Ctrl+Enter sends them together.
        await app.click(T('diff-comment'))
        await app.type('Use v14, not v13')
        await app.click(row('u:0'))
        await app.waitFor(() => document.querySelector('[data-test="diff-view"]')?.dataset.path === 'TODO.md', { label: 'picked TODO.md' })
        await app.click(T('diff-comment'))
        await app.type('Add a due date')
        const m = await app.mark()
        await app.key('Ctrl+Enter')
        const sent = await app.waitSent('say', {}, m)
        assert(sent.text.includes('src/prompts/loader.ts:\nUse v14, not v13'), `the loader comment: ${sent.text}`)
        assert(sent.text.includes('TODO.md:\nAdd a due date'), `the todo comment: ${sent.text}`)
        await app.waitHidden(T('diff'))
        await turnEnd(app, m)
        await readAll(app, { timeout: 20_000 })
      },
    },
    {
      r: 'R63',
      name: '/diff "This session" lists the edit she made after an allowed permission prompt, with its diff',
      timeout: 60_000,
      async run({ app }) {
        const m = await say(app, 'ask permission to edit')
        await app.waitEvent('ask_permission', {}, m, 20_000)
        await app.waitFor(() => document.querySelector('[data-test="ask"]')?.dataset.armed === '1', { label: 'menu armed' })
        await app.click(T('ask-option', { v: 'allow' }))
        await turnEnd(app, m)
        await readAll(app, { timeout: 20_000 })

        await slash(app, '/diff')
        await app.waitVisible(T('diff'))
        await app.waitFor(() => document.querySelector('[data-test="diff"] [data-test="menu-row"]'), { label: '/diff rows' })
        await app.click('[data-test="diff"] [data-test="menu-tab"][data-tab="session"]')
        await app.waitFor(() => document.querySelector('[data-test="diff"] header h2')?.textContent === 'This session', { label: 'session tab' })
        const r = await app.text('[data-test="diff"] [data-test="menu-row"][data-id^="s:"]')
        assert(r.includes('src/prompts/loader.ts') && r.includes('Edit') && r.includes('+1 −1'), `the edit row: ${r}`)
        const view = await app.text(T('diff-view'))
        assert(view.includes("const TEMPLATE = 'booking-v12'") && view.includes("const TEMPLATE = 'booking-v14'"), `the edit's diff: ${view}`)
        // ←/→ switch the source back.
        await app.key('ArrowLeft')
        await app.waitFor(() => document.querySelector('[data-test="diff"] header h2')?.textContent === 'Uncommitted changes (git diff HEAD)', { label: 'back to git' })
        await closePanel(app, 'diff')
        await toast(app, 'Diff dialog dismissed')
      },
    },
    {
      r: 'R63',
      name: '/export saves the conversation as the CLI\'s text to a file in the project',
      async run({ app, project }) {
        await slash(app, '/export')
        await app.waitVisible(T('export'))
        eq(await title(app, 'export'), 'Export conversation', 'title')
        const panel = await app.text(T('export'))
        assert(panel.includes('Select export method') && panel.includes('Copy to clipboard') && panel.includes('Save to file'), `the methods: ${panel}`)
        await app.click('[data-test="export"] [data-test="menu-row"][data-id="file"]')
        await app.waitVisible(T('export-filename'))
        const def = await app.eval(() => document.querySelector('[data-test="export-filename"]').value)
        assert(/^\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9-]+\.txt$/.test(def), `the CLI's default name: ${def}`)
        await app.eval(() => {
          const box = document.querySelector('[data-test="export-filename"]')
          box.value = 'e2e-export.md'
          box.focus()
        })
        await app.key('Enter')
        await toast(app, 'Conversation exported to: ')
        await app.waitHidden(T('export'))
        const file = join(project, 'e2e-export.md')
        assert(existsSync(file), `${file} exists`)
        const text = readFileSync(file, 'utf8')
        assert(text.includes('> ask permission to edit'), `the prompt line: ${text.slice(0, 400)}`)
        assert(text.includes('⏺ '), 'her replies and tool calls')

        // A name on the command line writes straight away, adding .txt.
        await slash(app, '/export e2e-direct')
        await toast(app, 'Conversation exported to: ')
        assert(existsSync(join(project, 'e2e-direct.txt')), 'e2e-direct.txt exists')
      },
    },
    {
      r: 'R63',
      name: '/copy copies her latest reply; /copy N out of range says how many there are',
      async run({ app }) {
        await slash(app, '/copy')
        await toast(app, 'Copied to clipboard (')
        await slash(app, '/copy 99')
        await app.waitFor(() => /^Only \d+ assistant messages? available to copy$/.test(document.getElementById('toast')?.textContent ?? ''), { label: 'out-of-range message' })
        await slash(app, '/copy x')
        await toast(app, 'Usage: /copy [N] where N is 1 (latest), 2, 3, … Got: x')
      },
    },
  ],
}
