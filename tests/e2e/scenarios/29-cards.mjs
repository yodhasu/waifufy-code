// Waifu cards: one card per character (persona, model, voice, love meter), swapped between sessions. The love
// meter belongs to the card, so it carries from one New Game to the next and each card has its own.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq, fastText, newGame, readAll, say, T, toTitle, turnEnd, waitScreen } from '../lib.mjs'

const ROWS = T('card-row')
const points = (app) => app.eval(() => Number(document.querySelector('[data-test="hearts"]').dataset.points))
const active = (app) => app.eval(() => window.__wc.store.get().card)
const cardFile = (app, id) => {
  const f = join(app.dataDir, 'cards', `${id}.json`)
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : undefined
}

async function openCards(app) {
  await app.go('settings', { tab: 'cards' })
  await waitScreen(app, 'settings')
  await app.waitVisible(ROWS)
}

const rowCount = (app) => app.eval(() => document.querySelectorAll('[data-test="card-row"]').length)

async function praise(app) {
  const m = await say(app, 'good job on that')
  await turnEnd(app, m)
  await readAll(app)
  await app.waitEvent('affection', { delta: 1 }, m)
}

export default {
  name: 'Waifu cards: swap characters, each with her own love meter',
  tests: [
    {
      name: 'the first launch makes a card from the settings; a new card becomes active and edits land on it',
      timeout: 60_000,
      async run({ app }) {
        eq(await active(app), 'rem', 'the first card takes her name')
        await openCards(app)
        eq(await rowCount(app), 1, 'one card')
        await app.click(T('card-new'))
        await app.waitFor(() => document.querySelectorAll('[data-test="card-row"]').length === 2, { label: 'a second card' })
        const id = await active(app)
        eq(id === 'rem', false, 'the new card is active')
        await app.eval(() => window.__wc.store.update((s) => void (s.waifu.name = 'Reine')))
        const deadline = Date.now() + 5000
        while (cardFile(app, id)?.waifu.name !== 'Reine' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
        eq(cardFile(app, id)?.waifu.name, 'Reine', 'the edit is on the new card')
        eq(cardFile(app, 'rem')?.waifu.name, 'Rem', 'the first card is untouched')
      },
    },
    {
      name: 'the love meter carries across New Games on its card, and the other card has its own',
      timeout: 150_000,
      async run({ app, project }) {
        const other = await active(app)
        await openCards(app)
        await app.click(`${T('card-row', { wcard: 'rem' })} ${T('card-switch')}`)
        await app.waitFor(() => window.__wc.store.get().card === 'rem', { label: 'switched back to Rem' })
        eq(await app.eval(() => window.__wc.store.get().waifu.name), 'Rem', 'her own persona came back')

        await newGame(app, project)
        await fastText(app)
        eq(await points(app), 0, 'a fresh card starts at 0')
        await praise(app)
        await app.waitFor(() => document.querySelector('[data-test="hearts"]').dataset.points === '1', { label: '1 point' })
        eq(cardFile(app, 'rem').love.points, 1, 'the card holds the point')
        await toTitle(app)

        await newGame(app, project)
        eq(await points(app), 1, 'a new game on the same card keeps her love meter')
        await toTitle(app)

        await openCards(app)
        await app.click(`${T('card-row', { wcard: other })} ${T('card-switch')}`)
        await app.waitFor((id) => window.__wc.store.get().card === id, { args: [other], label: 'switched to the other card' })
        await newGame(app, project)
        eq(await points(app), 0, 'the other card has its own meter')
        await toTitle(app)
      },
    },
  ],
}
