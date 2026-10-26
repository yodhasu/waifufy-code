// A phone can't open the computer's folder dialog, so New Game (and Settings' default folder) pick from the folders
// the computer already knows: its saves, the last folder, the default one, or a path typed in. The link checks
// the folder exists, and the trust dialog runs as usual.

import type { ServerMsg } from '../../link/src/protocol.ts'
import type { Link, Store } from './contracts'
import { esc } from './ui'
import './remote-folder.css'

const SAVES_WAIT_MS = 8000

/** Folders worth offering, most recent first, without repeats. */
async function knownFolders(link: Link, store: Store) {
  const s = store.get()
  const reply = link.next((m): m is Extract<ServerMsg, { t: 'saves' }> => m.t === 'saves', SAVES_WAIT_MS).catch(() => undefined)
  link.send({ t: 'saves' })
  const saves = (await reply)?.list ?? []
  const fromSaves = [...saves].sort((a, b) => b.lastModified - a.lastModified).map((x) => x.cwd)
  return [...new Set([s.claude.defaultDir, s.lastDir, ...fromSaves].filter(Boolean))]
}

/** Resolves with the chosen folder on the computer, or '' when cancelled. */
export function pickRemoteFolder(link: Link, store: Store, title: string, defaultPath = ''): Promise<string> {
  const stage = document.getElementById('stage')!
  const el = document.createElement('div')
  el.className = 'overlay show rfolder'
  el.dataset.test = 'remote-folder'
  el.innerHTML = `<div class="box panel">
      <h3>${esc(title)}</h3>
      <p class="rfolder-note">A folder on your computer</p>
      <div class="rfolder-list" data-test="remote-folder-list"><p class="rfolder-note">Loading…</p></div>
      <input class="field" type="text" spellcheck="false" placeholder="Or type a path, like C:\\Users\\you\\project" value="${esc(defaultPath)}" data-test="remote-folder-path">
      <div class="row"><button class="btn" type="button" data-act="cancel">Cancel</button><button class="btn primary" type="button" data-act="ok" data-test="remote-folder-ok">Open</button></div>
    </div>`
  stage.append(el)
  const input = el.querySelector<HTMLInputElement>('input')!
  void knownFolders(link, store).then((dirs) => {
    el.querySelector('.rfolder-list')!.innerHTML = dirs.length
      ? dirs.map((d) => `<button class="btn rfolder-dir" type="button" data-dir="${esc(d)}">${esc(d)}</button>`).join('')
      : '<p class="rfolder-note">No folders yet: type one below.</p>'
  })
  return new Promise((resolve) => {
    const done = (dir: string) => {
      el.remove()
      resolve(dir.trim())
    }
    el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement
      const dir = t.closest<HTMLElement>('[data-dir]')?.dataset.dir
      if (dir) return done(dir)
      const act = t.closest<HTMLElement>('[data-act]')?.dataset.act
      if (act === 'cancel' || t === el) return done('')
      if (act === 'ok' && input.value.trim()) done(input.value)
    })
    input.addEventListener('keydown', (e) => e.key === 'Enter' && input.value.trim() && done(input.value))
  })
}
