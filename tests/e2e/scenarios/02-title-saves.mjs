// R1–R9: the title menu and the VN-style Save/Load page.
import {
  assert,
  eq,
  folderName,
  makeProject,
  newGame,
  playSession,
  savesList,
  say,
  selectedHook,
  skip,
  sleep,
  T,
  toTitle,
  waitScreen,
} from '../lib.mjs'

const SLOTS_PER_PAGE = 8
const EXTRA_SAVES = SLOTS_PER_PAGE
const MAX_MENU_PRESSES = 8
const EXIT_MS = 10_000
/** Lets the menu's selection highlight follow a key press. */
const KEY_SETTLE_MS = 120
/** Lets the chat save the session's meta after its turn before leaving. */
const SAVE_SETTLE_MS = 500
const EXIT_POLL_MS = 200
const RENAMED = 'Renamed by E2E'

const filledSlots = (app) =>
  app.eval(() =>
    [...document.querySelectorAll('[data-test="save-slot"]')].filter((el) => el.dataset.id && window.__e2e.isVisible(el)).map((el) => el.dataset.id),
  )

/** Runs a slot action whether its button sits inside the slot (shown on hover) or in a bar for the selected slot. */
async function slotAction(app, id, action) {
  const slot = T('save-slot', { id })
  const inner = `${slot} ${T(`save-${action}`)}`
  if (await app.exists(inner)) {
    const c = await app.center(slot)
    await app.mouse.move(c.x, c.y)
    await app.waitVisible(inner)
    return app.click(inner)
  }
  await app.click(slot)
  await app.waitVisible(T(`save-${action}`))
  await app.click(T(`save-${action}`))
}

/** Earlier tests leave saves behind; a test run on its own (`run.mjs R7`) plays one first. */
async function ensureSaves(ctx, n = 1) {
  const have = (await savesList(ctx.app)).length
  for (let k = have; k < n; k++) await playSession(ctx.app, k === 0 ? ctx.project : makeProject(`quest-extra-${k}`))
}

async function openSaves(app) {
  await toTitle(app)
  await app.click(T('title-load'))
  await waitScreen(app, 'saves')
  await app.waitVisible(T('save-slot'))
}

export default {
  name: 'Title screen and Save/Load',
  tests: [
    {
      r: 'R1',
      name: 'Continue is hidden when there are no saves',
      async run({ app }) {
        await waitScreen(app, 'title')
        await app.waitVisible(T('title-new'))
        // The menu items slide in one after another.
        for (const h of ['title-load', 'title-settings', 'title-exit']) await app.waitVisible(T(h))
        assert(!(await app.visible(T('title-continue'))), 'title-continue hidden without saves')
      },
    },
    {
      r: ['R48', 'R24'],
      name: 'title-login shows only while logged out',
      async run({ app }) {
        await app.inject({ t: 'auth', auth: { loggedIn: false, error: 'Not logged in' } })
        await app.waitVisible(T('title-login'))
        await app.inject({ t: 'auth', auth: { loggedIn: true, email: 'mock@waifufy.test', subscription: 'max' } })
        await app.waitHidden(T('title-login'))
      },
    },
    {
      r: 'R3',
      name: 'New Game starts a session in the chosen folder',
      async run({ app, project }) {
        assert(await app.visible(T('title-new')), 'title-new visible')
        // The OS folder picker can't be driven; New Game hands the folder to the chat screen like this.
        const start = await newGame(app, project)
        eq(start.resume, undefined, 'a new game does not resume')
        const started = await app.waitEvent('started', { cwd: project }, 0)
        assert(started.cwdShort.endsWith(folderName(project)), `cwdShort ${started.cwdShort}`)
        const m = await say(app, 'hello there')
        await app.waitEvent('turn_end', {}, m, 30_000)
        await sleep(SAVE_SETTLE_MS)
        await toTitle(app)
      },
    },
    {
      r: 'R1',
      name: 'Continue resumes the most recent session',
      async run(ctx) {
        const { app } = ctx
        await ensureSaves(ctx)
        await toTitle(app)
        await app.waitVisible(T('title-continue'), 15_000)
        const list = await savesList(app)
        assert(list.length >= 1, 'the sidecar has a save')
        const recent = [...list].sort((a, b) => b.lastModified - a.lastModified)[0]
        const m = await app.mark()
        await app.click(T('title-continue'))
        await waitScreen(app, 'chat')
        await app.waitSent('start', { resume: recent.id }, m)
        await app.waitEvent('ready', {}, m, 20_000)
        await toTitle(app)
      },
    },
    {
      r: 'R5',
      name: 'keyboard: arrows choose, Enter selects, Esc goes back',
      async run({ app }) {
        await toTitle(app)
        const items = '[data-test^="title-"]'
        const seen = new Set()
        for (let k = 0; k < MAX_MENU_PRESSES && (await selectedHook(app, items)) !== 'title-settings'; k++) {
          await app.key('ArrowDown')
          await sleep(KEY_SETTLE_MS)
          seen.add(await selectedHook(app, items))
        }
        assert(seen.size >= 2, `ArrowDown moves the selection (saw ${[...seen]})`)
        eq(await selectedHook(app, items), 'title-settings', 'reached Settings with ArrowDown')
        await app.key('ArrowUp')
        await sleep(KEY_SETTLE_MS)
        assert((await selectedHook(app, items)) !== 'title-settings', 'ArrowUp moves back')
        await app.key('ArrowDown')
        await sleep(KEY_SETTLE_MS)
        await app.key('Enter')
        await waitScreen(app, 'settings')
        await app.key('Escape')
        await waitScreen(app, 'title')
      },
    },
    {
      r: 'R4',
      name: 'Settings opens the settings page and Return comes back',
      async run({ app }) {
        await toTitle(app)
        await app.click(T('title-settings'))
        await waitScreen(app, 'settings')
        await app.click(T('settings-return'))
        await waitScreen(app, 'title')
      },
    },
    {
      r: ['R2', 'R6'],
      name: 'Load opens the Save/Load page: 8 slots per page, numbered page tabs',
      timeout: 300_000,
      async run({ app, log }) {
        for (let k = 1; k <= EXTRA_SAVES; k++) await playSession(app, makeProject(`quest-${k}`), `save number ${k}`)
        log(`created ${EXTRA_SAVES} more saves`)
        await openSaves(app)
        eq(await app.count(T('save-slot')), SLOTS_PER_PAGE, 'slots on page 1')
        const pages = await app.attrs(T('save-page'), 'data-page')
        assert(pages.length >= 2, `at least 2 page tabs for ${EXTRA_SAVES + 1} saves, got ${pages}`)
        const page1 = await filledSlots(app)
        await app.click(T('save-page', { page: pages[1] }))
        await app.waitFor((ids) => {
          const now = [...document.querySelectorAll('[data-test="save-slot"]')].filter((el) => el.dataset.id).map((el) => el.dataset.id)
          return now.length > 0 && now.every((id) => !ids.includes(id))
        }, { args: [page1], label: 'page 2 shows other saves' })
        await app.waitFor((n) => document.querySelectorAll('[data-test="save-slot"]').length === n, {
          args: [SLOTS_PER_PAGE],
          label: 'page 2 has 8 slots (NO DATA fills the rest)',
        })
        await app.click(T('save-page', { page: pages[0] }))
      },
    },
    {
      r: 'R7',
      name: 'a slot shows thumbnail, title, folder and branch, date and time, play time, turns, affection',
      async run(ctx) {
        const { app } = ctx
        await ensureSaves(ctx)
        await openSaves(app)
        const list = await savesList(app)
        const [id] = await filledSlots(app)
        const save = list.find((s) => s.id === id)
        assert(save, 'the first slot is a known save')
        const slot = await app.eval((sel) => {
          const el = document.querySelector(sel)
          const img = el.querySelector('img')
          const bg = [...el.querySelectorAll('*')].some((n) => getComputedStyle(n).backgroundImage.includes('url('))
          // Affection is drawn as hearts, filled and empty, or carries its number in a title.
          const hearts = (el.innerText.match(/[♥♡❤]/g) ?? []).length
          const affection = [...el.querySelectorAll('[title]')].some((n) => /affection/i.test(n.title))
          return { text: el.innerText, img: img?.src ?? '', bg, hearts, affection }
        }, T('save-slot', { id }))
        assert(slot.text.includes(save.title) || slot.text.includes(save.title.slice(0, 20)), `title "${save.title}" in "${slot.text}"`)
        assert(slot.text.includes(folderName(save.cwd)), `folder ${folderName(save.cwd)} shown`)
        if (save.branch) assert(slot.text.includes(save.branch), `branch ${save.branch} shown`)
        assert(/\d{1,2}:\d{2}/.test(slot.text), 'a time of day')
        assert(/\d{4}|\d{1,2}[/.-]\d{1,2}|today|yesterday|ago/i.test(slot.text), 'a date')
        assert(save.turns >= 1, `the save counts the turn played in it (turns=${save.turns})`)
        const turns = new RegExp(String.raw`\b${save.turns}\s*turns?\b`, 'i')
        assert(turns.test(slot.text), `"${save.turns} turn(s)" in "${slot.text}"`)
        assert(slot.hearts > 0 || slot.affection, 'affection is shown (hearts)')
        assert(/\d+:\d{2}:\d{2}|\d+\s*[hms]\b/.test(slot.text), 'play time')
        assert(slot.img.includes('/thumbs/') || slot.bg, 'a thumbnail captured when the session was left')
      },
    },
    {
      r: 'R8',
      name: 'rename a save',
      async run(ctx) {
        const { app } = ctx
        await ensureSaves(ctx)
        await openSaves(app)
        const [id] = await filledSlots(app)
        const m = await app.mark()
        await slotAction(app, id, 'rename')
        await app.waitVisible(T('save-rename-input'))
        await app.click(T('save-rename-input'))
        await app.key('Ctrl+A')
        await app.type(RENAMED)
        await app.key('Enter')
        await app.waitSent('save_rename', { id, title: RENAMED }, m)
        await app.waitFor((sel, t) => document.querySelector(sel)?.innerText.includes(t), { args: [T('save-slot', { id }), RENAMED], label: 'renamed slot' })
      },
    },
    {
      r: 'R8',
      name: 'delete asks first; Cancel keeps it, Yes removes it from the list',
      async run(ctx) {
        const { app } = ctx
        await ensureSaves(ctx, 2)
        await openSaves(app)
        const ids = await filledSlots(app)
        const id = ids.at(-1)
        await slotAction(app, id, 'delete')
        await app.waitVisible('#confirm')
        await app.click('#confirmNo')
        await app.waitHidden('#confirm')
        assert((await filledSlots(app)).includes(id), 'Cancel keeps the save')
        const m = await app.mark()
        await slotAction(app, id, 'delete')
        await app.waitVisible('#confirm')
        await app.click('#confirmYes')
        await app.waitSent('save_delete', { id }, m)
        await app.waitFor((sid) => !document.querySelector(`[data-test="save-slot"][data-id="${sid}"]`), { args: [id], label: 'slot gone' })
        assert(!(await savesList(app)).some((s) => s.id === id), 'the sidecar dropped it')
      },
    },
    {
      r: ['R8', 'R1'],
      name: 'load resumes that save',
      async run(ctx) {
        const { app } = ctx
        await ensureSaves(ctx, 2)
        await openSaves(app)
        const [, id] = await filledSlots(app)
        const m = await app.mark()
        await slotAction(app, id, 'load')
        await waitScreen(app, 'chat')
        await app.waitSent('start', { resume: id }, m)
        await app.waitEvent('ready', {}, m, 20_000)
      },
    },
    {
      r: 'R9',
      name: 'Return and Title buttons, and the hint bar',
      async run({ app }) {
        await openSaves(app)
        assert(await app.visible(T('saves-return')), 'saves-return')
        assert(await app.visible(T('saves-title')), 'saves-title')
        assert((await app.stageText()).includes('Load a save and continue from there.'), 'hint bar')
        await app.click(T('saves-title'))
        await waitScreen(app, 'title')
        await app.click(T('title-load'))
        await waitScreen(app, 'saves')
        await app.click(T('saves-return'))
        await waitScreen(app, 'title')
        await app.click(T('title-load'))
        await waitScreen(app, 'saves')
        await app.key('Escape')
        await waitScreen(app, 'title')
      },
    },
    {
      r: 'R4',
      name: 'Exit asks first while a turn is running',
      async run({ app, project }) {
        await newGame(app, project)
        const m = await say(app, 'ask permission to edit')
        await app.waitEvent('ask_permission', {}, m, 20_000)
        await app.go('title')
        await waitScreen(app, 'title')
        await app.click(T('title-exit'))
        await app.waitVisible('#confirm')
        await app.click('#confirmNo')
        await app.waitHidden('#confirm')
        assert(app.alive(), 'the app is still running after Cancel')
        await waitScreen(app, 'title')
      },
    },
    {
      r: 'R4',
      name: 'Exit quits when idle',
      async run({ app, project }) {
        if (app.target !== 'app') skip('quitting needs the Tauri shell')
        // A fresh session replaces the one still waiting for permission.
        await newGame(app, project)
        await toTitle(app)
        await app.click(T('title-exit'))
        const deadline = Date.now() + EXIT_MS
        while (Date.now() < deadline && app.alive()) {
          if (await app.visible('#confirm').catch(() => false)) throw new Error('Exit asked for confirmation with no turn running')
          await sleep(EXIT_POLL_MS)
        }
        assert(!app.alive(), 'the app process exited')
      },
    },
  ],
}
