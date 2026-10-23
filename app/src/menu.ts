import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import type { SessionSummary } from '../../link/src/protocol.ts'
import type { Link } from './link'
import type { Rem } from './rem'
import { $, esc, relTime, toast } from './ui'

export function createMenu(link: Link, rem: Rem, hooks: { onStart(cwd: string, resume?: string, title?: string): void }) {
  let sessions: SessionSummary[] = []
  let shown = false

  link.on((m) => {
    if (m.t !== 'sessions') return
    sessions = m.list
    render()
  })

  function render() {
    const resume = $<HTMLButtonElement>('mResume')
    resume.disabled = sessions.length === 0
    const latest = sessions[0]
    $('mResumeHint').textContent = latest
      ? `${latest.title} · ${relTime(latest.lastModified)}${sessions.length > 1 ? ` · ${sessions.length - 1} more` : ''}`
      : 'No sessions yet'
    $('mList').innerHTML = sessions
      .map(
        (s, i) =>
          `<button class="sess" data-i="${i}"><b>${esc(s.title)}</b><time>${relTime(s.lastModified)}</time><span>${esc(s.cwdShort)}${s.branch && s.branch !== 'HEAD' ? ` · ⎇ ${esc(s.branch)}` : ''}</span></button>`,
      )
      .join('')
  }

  function showList(isOpen: boolean) {
    $('menuItems').hidden = isOpen
    $('mSessions').hidden = !isOpen
    const first = isOpen ? $('mList').querySelector<HTMLElement>('.sess') : $('menuItems').querySelector<HTMLElement>('button:not(:disabled)')
    first?.focus()
  }

  function start(cwd: string, resume?: string, title?: string) {
    shown = false
    hooks.onStart(cwd, resume, title)
  }

  $('mResume').onclick = () => showList(true)
  $('mBack').onclick = () => showList(false)
  $('mList').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.sess')
    if (!b) return
    const s = sessions[Number(b.dataset.i)]
    start(s.cwd, s.id, s.title)
  })
  $('mNew').onclick = async () => {
    const dir = await open({ directory: true, title: 'Where should Rem work?' })
    if (typeof dir === 'string') start(dir)
  }
  $('mSettings').onclick = () => toast('Settings are coming soon')
  $('mExit').onclick = () => void invoke('quit')

  // Arrow keys move between the visible buttons; Esc goes back from the session list.
  addEventListener('keydown', (e) => {
    if (!shown) return
    if (e.key === 'Escape' && !$('mSessions').hidden) return showList(false)
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const scope = $('mSessions').hidden ? $('menuItems') : $('mList')
    const buttons = [...scope.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    if (!buttons.length) return
    e.preventDefault()
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    buttons[(at + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus()
  })

  return {
    show() {
      shown = true
      $('stage').classList.add('menu-mode')
      $('menuFoot').textContent = '↑↓ choose · Enter select · Esc back'
      showList(false)
      rem.emote('smile')
      link.send({ t: 'sessions' })
    },
  }
}
