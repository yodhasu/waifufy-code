import { ICONS } from '../icons'
import type { MenuHost } from './menu'

// The phone's first chat: four cards on what a touch screen does here, shown once (remembered in this phone's
// storage). Next walks through them; Skip, Got it or back ends it.

const KEY = 'wc-phone-tutorial'

const tap = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11V5.5a1.5 1.5 0 013 0V10m0-1.5a1.5 1.5 0 013 0V11m0-1a1.5 1.5 0 013 0v4.5a6 6 0 01-6 6h-.5a6 6 0 01-5-2.7L5 14.3a1.5 1.5 0 012.5-1.6L9 14"/></svg>'
const swipe = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4"/></svg>'

const CARDS: { icon: string; title: string; text: string }[] = [
  { icon: tap, title: 'Tap the text box', text: 'Tap once to finish her line, again for the next page.' },
  { icon: ICONS.reply, title: 'Reply to talk', text: 'The big Reply button opens the keyboard. Sending closes it again. While she works it turns into Stop.' },
  { icon: swipe, title: 'Swipe on the text box', text: 'Up for the backlog of everything she said. Down to see just her; tap to bring the text back.' },
  { icon: ICONS.more, title: 'The top bar', text: 'The cross leaves the chat (she keeps working on your computer), the speaker is her voice, the dots have the rest. Turn the phone sideways for the theater view.' },
]

const seen = () => {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return true
  }
}

const remember = () => {
  try {
    localStorage.setItem(KEY, '1')
  } catch {
    // Private storage off: the tutorial may show again, nothing worse.
  }
}

/** Shows the tutorial unless this phone has seen it. */
export function phoneTutorial(host: Pick<MenuHost, 'modal'>) {
  if (seen()) return
  let at = 0
  const m = host.modal({
    test: 'tutorial',
    title: 'How to play',
    cls: 'tutorial',
    body: `<div class="tut-card"><div class="tut-icon"></div><h3></h3><p></p></div>
      <div class="tut-dots"></div>
      <div class="tut-row"><button class="btn" type="button" data-act="skip" data-test="tutorial-skip">Skip</button>
      <button class="btn primary" type="button" data-act="next" data-test="tutorial-next"></button></div>`,
    onClose: remember,
  })
  const q = <T extends HTMLElement>(sel: string) => m.el.querySelector<T>(sel)!
  const draw = () => {
    const c = CARDS[at]!
    q('.tut-icon').innerHTML = c.icon
    q('.tut-card h3').textContent = c.title
    q('.tut-card p').textContent = c.text
    q('.tut-dots').innerHTML = CARDS.map((_, k) => `<i class="${k === at ? 'on' : ''}"></i>`).join('')
    q('[data-act="next"]').textContent = at === CARDS.length - 1 ? 'Got it' : 'Next'
  }
  m.el.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act
    if (act === 'skip' || (act === 'next' && at === CARDS.length - 1)) return m.close()
    if (act === 'next') (at++, draw())
  })
  draw()
}
