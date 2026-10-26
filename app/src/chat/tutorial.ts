import type { MenuHost } from './menu'

// The phone's first chat: four cards on what a touch screen does here, shown once (remembered in this phone's
// storage). Next walks through them; Skip, Got it or back ends it.

const KEY = 'wc-phone-tutorial'

const CARDS: { icon: string; title: string; text: string }[] = [
  { icon: '☝', title: 'Tap the text box', text: 'Tap once to finish her line, again for the next page.' },
  { icon: '↑', title: 'Swipe up on it', text: 'The backlog: everything she said, and every tool she used.' },
  { icon: '↓', title: 'Swipe down to hide it', text: 'Just her, full screen. Tap anywhere to bring the text back.' },
  { icon: '⋯', title: '⋯ has the rest', text: 'Status, quests, mode, costume and settings. Back leaves the chat: she keeps working on your computer.' },
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
    q('.tut-icon').textContent = c.icon
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
