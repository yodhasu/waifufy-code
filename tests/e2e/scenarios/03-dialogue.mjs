// R25–R30: the VN dialogue layer — tags never shown, the inline emotion timeline, pace, lip sync,
// collapsing of long output, and pages.
import { assert, dialogueState, focusInput, inOrder, MOCK, near, newGame, readAll, say, sleep, T, turnEnd } from '../lib.mjs'

/** The pause after a sentence's end, in seconds, with punctuation pauses on. */
const SENTENCE_PAUSE_S = 0.42
/** Longer than the longest punctuation pause, so a pause is not mistaken for a finished page. */
const PAGE_DONE_MS = 900
/** Punctuation pauses must add at least this share of their nominal length, whatever the timer jitter. */
const MIN_PAUSE_SHARE = 0.3
const SPEED_TOLERANCE = 0.3
/** With text speed 0, the whole page appears within this from its first letters. */
const INSTANT_SPAN_MS = 250
/** A click on a page that is typing shows the rest of it within this. */
const CLICK_COMPLETE_MS = 600
const CTRL_SKIP_MS = 5000
const AUTO_READ_MS = 15_000
const TYPING_START_MS = 20_000
const POLL_MS = 80
const MIN_TIMELINE_SPREAD_MS = 2000
const MIN_TALK_TOGGLES = 6
const MAX_LIST_ITEMS_SHOWN = 4
const MAX_PAGES = 20

/**
 * Where the typewriter must be when each emotion of the "emotions" reply fires (R26): every tag sits
 * between two known phrases of link/src/mock.ts.
 */
const AT_TAG = {
  smile: (t) => !t.includes('prod prompt'),
  think: (t) => t.includes('stale') && !t.includes('still points'),
  worried: (t) => !t.includes('explains'),
  serious: (t) => t.includes('wrong answer') && !t.includes('simulation'),
  happy: (t) => !t.includes('small fix'),
  shy: (t) => t.includes('take long') && !t.includes('leave it'),
}

/** Lets each page finish typing, then advances with Enter on the empty input (the CLI-habit way), until `done(text)`. */
async function readByEnter(app, done, timeout = 90_000) {
  const deadline = Date.now() + timeout
  let last = ''
  let since = Date.now()
  while (Date.now() < deadline) {
    const s = await dialogueState(app)
    if (s.text !== last) (last = s.text), (since = Date.now())
    const settled = s.talking !== '1' && Date.now() - since > PAGE_DONE_MS
    if (settled && done(s.text) && !s.more) return
    if (settled && s.more) {
      await focusInput(app)
      await app.key('Enter')
      since = Date.now()
    }
    await sleep(POLL_MS)
  }
  throw new Error(`the reply never finished (last page: "${last.slice(0, 80)}")`)
}

/** Her lines only: snapshots whose nameplate shows the waifu's name. */
async function herLines(app, from) {
  const name = (await app.settings()).waifu.name
  return (await app.dialogueLog(from)).filter((d) => d.name.includes(name) && d.text.length > 0)
}

/** Characters per second over one page: from its first typed letters to its full text. */
function typingRate(lines) {
  const final = lines.at(-1)
  const first = lines.find((d) => final.text.startsWith(d.text))
  const end = lines.find((d) => d.text === final.text)
  const typed = final.text.length - first.text.length
  return { cps: typed / ((end.at - first.at) / 1000), seconds: (end.at - first.at) / 1000, typed, text: final.text }
}

export default {
  name: 'Dialogue: tags, timeline, pace, lip sync, collapse, pages',
  tests: [
    {
      r: ['R26', 'R25', 'R28'],
      name: 'emotions fire as the typewriter reaches each tag; no tag text ever shows; mouth moves',
      timeout: 120_000,
      async run({ app, project }) {
        await newGame(app, project)
        await app.updateSettings({ motion: { textCps: 40, punctuationPauses: true, lipSync: true } })
        const m = await say(app, 'show me your emotions')
        await turnEnd(app, m)
        await readByEnter(app, (t) => t.includes('leave it to me'))

        const emotions = (await app.attrLog(m, 'data-emotion')).filter((a, k, all) => k === 0 || a.value !== all[k - 1].value)
        const order = emotions.map((a) => a.value)
        assert(inOrder(order, MOCK.emotionsOrder), `data-emotion order ${order} contains ${MOCK.emotionsOrder}`)
        const lines = await app.dialogueLog(m)
        for (const want of MOCK.emotionsOrder) {
          const hit = emotions.find((a) => a.value === want)
          const before = lines.filter((d) => d.at <= hit.at + 30).at(-1)?.text ?? ''
          assert(AT_TAG[want](before), `[${want}] fired at the wrong place; dialogue was "${before.slice(-60)}"`)
        }
        const spread = emotions.at(-1).at - emotions.find((a) => a.value === MOCK.emotionsOrder[0]).at
        assert(spread > MIN_TIMELINE_SPREAD_MS, `emotions spread over the typing (${Math.round(spread)} ms), not all on arrival`)

        assert(!lines.some((d) => d.text.includes('[')), `a "[" reached dialogue-text: ${lines.find((d) => d.text.includes('['))?.text}`)
        assert((await app.eval(() => window.__e2e.leaks.length)) === 0, 'the recorder saw an emotion tag in dialogue-text')
        assert(lines.some((d) => /<(b|strong)\b[^>]*>booking<\/(b|strong)>/.test(d.html)), 'bold is rendered')
        assert(lines.some((d) => /<code\b[^>]*>staging<\/code>/.test(d.html)), 'inline code is rendered')
        assert(!lines.some((d) => d.text.includes('**') || d.text.includes('`')), 'no raw markdown marks shown')

        const talk = await app.attrLog(m, 'data-talking')
        assert(talk.some((a) => a.value === '1') && talk.some((a) => a.value === '0'), 'data-talking goes 1 and 0')
        assert(talk.length >= MIN_TALK_TOGGLES, `the mouth closes at pauses (${talk.length} toggles)`)
        assert((await app.chara('data-talking')) === '0', 'mouth closed when done')
      },
    },
    {
      r: 'R27',
      name: 'typewriter speed matches the text speed; punctuation pauses add time; 0 is instant',
      timeout: 120_000,
      async run({ app, project }) {
        await newGame(app, project)
        await app.updateSettings({ motion: { textCps: 14, punctuationPauses: false } })
        let m = await say(app, 'hello there')
        await turnEnd(app, m)
        await readAll(app, { settleMs: PAGE_DONE_MS })
        const plain = typingRate(await herLines(app, m))
        near(plain.cps, 14, 14 * SPEED_TOLERANCE, `chars per second over "${plain.text}"`)

        await app.updateSettings({ motion: { punctuationPauses: true } })
        m = await say(app, 'hello there')
        await turnEnd(app, m)
        await readAll(app, { settleMs: PAGE_DONE_MS })
        const paused = typingRate(await herLines(app, m))
        const marks = (paused.text.match(/[.!?…]/g) ?? []).length
        assert(marks > 0, 'the reply has sentence punctuation')
        const added = paused.seconds - plain.seconds
        assert(added > MIN_PAUSE_SHARE * marks * SENTENCE_PAUSE_S, `pauses add time: ${plain.seconds.toFixed(2)}s → ${paused.seconds.toFixed(2)}s`)

        await app.updateSettings({ motion: { textCps: 0 } })
        m = await say(app, 'hello again')
        await turnEnd(app, m)
        await readAll(app)
        const instant = await herLines(app, m)
        const span = instant.at(-1).at - instant[0].at
        assert(span < INSTANT_SPAN_MS, `instant text appears at once (${Math.round(span)} ms from first to full)`)
      },
    },
    {
      r: 'R27',
      name: 'clicking finishes the page; holding Ctrl skips',
      timeout: 90_000,
      async run({ app, project }) {
        await newGame(app, project)
        await app.updateSettings({ motion: { textCps: 14, punctuationPauses: true } })
        const m = await say(app, 'show me your emotions')
        const name = (await app.settings()).waifu.name
        // My own line shows at once; wait for hers to be mid-typing.
        await app.waitFor(
          (n) =>
            document.querySelector('[data-test="dialogue-name"]').textContent.includes(n) &&
            document.querySelector('[data-test="dialogue-text"]').textContent.length > 8 &&
            document.getElementById('chara').dataset.talking === '1',
          { args: [name], timeout: TYPING_START_MS, label: 'her page 1 typing' },
        )
        await app.click(T('dialogue'))
        await app.waitFor(() => document.querySelector('[data-test="dialogue-text"]').textContent.includes('opening hours'), {
          timeout: CLICK_COMPLETE_MS,
          label: 'the click completes page 1 at once',
        })
        await turnEnd(app, m)
        await app.keyDown('Control')
        try {
          await app.waitFor(() => document.querySelector('[data-test="dialogue-text"]').textContent.includes('leave it to me'), {
            timeout: CTRL_SKIP_MS,
            label: 'Ctrl skips to the last page',
          })
        } finally {
          await app.keyUp('Control')
        }
      },
    },
    {
      r: 'R25',
      name: 'links show as their text and a short list as bullets, not collapsed; LOG keeps the URL',
      async run({ app, project }) {
        await newGame(app, project)
        await app.updateSettings({ motion: { textCps: 0, autoDelayMs: 50 } })
        const m = await say(app, 'show me some markdown')
        await turnEnd(app, m)
        await readAll(app)
        const lines = await herLines(app, m)
        const shown = lines.map((d) => d.text).join('\n')
        assert(shown.includes(MOCK.link.text), `the link text is shown: "${shown}"`)
        assert(!shown.includes('](') && !shown.includes(MOCK.link.href), 'no raw link markup or URL in the dialogue')
        for (const item of MOCK.shortList) assert(shown.includes(item), `list item ${item} is shown`)
        assert(!lines.some((d) => d.text.trim().endsWith('…')), 'a 3-item list is not collapsed')
        assert(!lines.some((d) => /^\s*- /m.test(d.text)), 'items show as bullets, not "- "')
        assert(lines.some((d) => /<(b|strong)\b[^>]*>template<\/(b|strong)>/.test(d.html)), 'bold is rendered')
        await app.key('Ctrl+L')
        await app.waitVisible(T('log'))
        const log = (await app.texts(`${T('log')} ${T('log-entry', { who: 'char' })}`)).join('\n')
        assert(log.includes(MOCK.link.href), 'LOG shows where the link goes')
        await app.key('Escape')
        await app.waitHidden(T('log'))
      },
    },
    {
      r: ['R29', 'R23'],
      name: 'long output collapses to a short page with "…"; LOG keeps the full text',
      timeout: 90_000,
      async run({ app, project }) {
        await newGame(app, project)
        await app.updateSettings({ motion: { textCps: 0, autoDelayMs: 50 } })
        const m = await say(app, 'give me a long answer')
        await turnEnd(app, m)
        // Page through by hand, checking the hint on every collapsed page.
        let collapsedPages = 0
        let hinted = 0
        for (let k = 0; k < MAX_PAGES; k++) {
          await sleep(PAGE_DONE_MS)
          const s = await dialogueState(app)
          if (s.text.trim().endsWith('…')) {
            collapsedPages++
            if ((await app.stageText()).includes('full text in LOG')) hinted++
          }
          if (!s.more) break
          await app.click(T('dialogue'))
        }
        assert(collapsedPages > 0, 'a collapsed page ends with "…"')
        assert(hinted === collapsedPages, `"(full text in LOG)" on every collapsed page (${hinted}/${collapsedPages})`)
        const lines = await app.dialogueLog(m)
        const shown = lines.map((d) => d.text)
        for (const [what, needle] of [
          ['the 10th list item', 'step10.ts'],
          ['the code block body', 'ctx.agent.run'],
          ['the table', '09:00–21:00'],
          ['the end of the 320+ char paragraph', 'admin panel'],
          // One sentence longer than a page: collapsing it by sentences alone would still show all of it.
          ['the end of the single 320+ char sentence', MOCK.longSentenceTail],
        ]) {
          assert(!shown.some((t) => t.includes(needle)), `${what} is collapsed in the dialogue`)
        }
        const bullets = Math.max(...shown.map((t) => (t.match(/step\d+\.ts/g) ?? []).length))
        assert(bullets <= MAX_LIST_ITEMS_SHOWN + 1, `at most a few list items on the page (${bullets})`)

        await app.key('Ctrl+L')
        await app.waitVisible(T('log'))
        const log = (await app.texts(`${T('log')} ${T('log-entry', { who: 'char' })}`)).join('\n')
        for (const needle of ['step10.ts', 'ctx.agent.run', '09:00–21:00', 'admin panel', MOCK.longSentenceTail]) {
          assert(log.includes(needle), `LOG has "${needle}"`)
        }
        await app.key('Escape')
        await app.waitHidden(T('log'))
      },
    },
    {
      r: 'R30',
      name: 'one paragraph per page, ▼ with a count, Enter advances, AUTO advances by itself',
      timeout: 90_000,
      async run({ app, project }) {
        await newGame(app, project)
        await app.updateSettings({ motion: { textCps: 0, autoDelayMs: 300 } })
        let m = await say(app, 'show me your emotions')
        await turnEnd(app, m)
        const pageText = () => app.text(T('dialogue-text'))
        await app.waitFor(() => document.querySelector('[data-test="dialogue-text"]').textContent.includes('opening hours'), { label: 'page 1' })
        const p1 = await pageText()
        assert(!p1.includes('wrong answer'), 'page 1 holds only the first paragraph')
        await app.waitVisible(T('dialogue-advance'))
        assert(/\d/.test(await app.text(T('dialogue-advance'))), '▼ shows how many pages are left')
        await focusInput(app)
        await app.key('Enter')
        await app.waitFor(() => document.querySelector('[data-test="dialogue-text"]').textContent.includes('wrong answer'), { label: 'page 2 after Enter' })
        await app.key('Enter')
        await app.waitFor(() => document.querySelector('[data-test="dialogue-text"]').textContent.includes('leave it to me'), { label: 'page 3 after Enter' })
        await app.waitHidden(T('dialogue-advance'))

        m = await say(app, 'show me your emotions')
        await turnEnd(app, m)
        await app.click(T('qm-auto'))
        try {
          await app.waitFor(() => document.querySelector('[data-test="dialogue-text"]').textContent.includes('leave it to me'), {
            timeout: AUTO_READ_MS,
            label: 'AUTO reaches the last page without input',
          })
        } finally {
          await app.click(T('qm-auto'))
        }
      },
    },
  ],
}
