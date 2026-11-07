// Settings → Mods (WC-20): every mod with its status and an enable switch, its declared settings as native controls,
// its own settings page in a sandboxed slot, install from a folder and remove. The built-in UI plugins
// (app/src/plugins) keep their switches in a "Built-in" group until they become mods. The list is the link's `mods`
// message; a row is redrawn only when what it shows changed, so a field being typed in is never replaced under the cursor.

import type { ModInfo, ServerMsg } from '../../../link/src/protocol.ts'
import type { Ctx } from '../contracts'
import { pluginEnabled, setPluginFlag, UI_PLUGINS } from '../plugins'
import { esc } from '../ui'
import { secretDelete, secretGet, secretSet } from './secrets'
import { mountModPanel } from './slot'
import './mods.css'

/** How long after a settings change a refusal (an app_error) is taken as that change's. */
const REFUSAL_MS = 2000
/** An install or removal waits this long for the link's answer. */
const ANSWER_MS = 20_000

type Step = 'perms' | 'remove'

/** The markup of the tab; settings.ts puts it in the Mods pane and calls `mountModsTab` on it. */
export const MODS_PANE = `<div class="set-cols">
  <section class="set-card wide" data-test="mods-builtin"><h4>Built-in</h4>
    ${UI_PLUGINS.map(
      (p) => `<label class="set-toggle"><input type="checkbox" data-test="set-plugins.${p.id}" data-builtin="${p.id}"><i></i>
        <span><b>${esc(p.name)}</b><small>${esc(p.description)}</small></span></label>`,
    ).join('')}
  </section>
  <section class="set-card wide" data-test="mods-list"><h4>Mods</h4>
    <div class="mod-rows" data-mod-rows></div>
    <p class="set-empty" data-mod-empty hidden>No mods yet. Install one from a folder, or drop it in <code>plugins/</code>.</p>
    <div class="set-actions" data-mod-actions><button class="btn" type="button" data-test="mod-install" data-mod-act="install">Install from folder…</button></div>
    <p class="set-note">A mod is a folder with a <code>mod.json</code>. It runs in its own sandbox and can only do what its permissions say. Removing one keeps its saved data unless you tick the box.</p>
  </section>
</div>`

/** Wires the Mods pane inside `host`. `show` asks the link for a fresh list when the tab opens. */
export function mountModsTab(host: HTMLElement, ctx: Ctx): { show(): void } {
  const rowsEl = host.querySelector<HTMLElement>('[data-mod-rows]')!
  const emptyEl = host.querySelector<HTMLElement>('[data-mod-empty]')!
  let mods: ModInfo[] = []
  /** Rows by mod id, with what they were drawn from and their settings page's teardown. */
  const rows = new Map<string, { el: HTMLElement; sig: string; url?: string; off?: () => void }>()
  /** A row's open confirm step: the permission list before a first enable, or the remove confirmation. */
  const step = new Map<string, Step>()
  let changedAt = 0

  const q = <T extends HTMLElement>(root: ParentNode, sel: string) => root.querySelector<T>(sel)!
  /** A mod the user has switched on or off before already saw its permissions (`plugins.<id>` exists). */
  const approved = (id: string) => ctx.store.get().plugins?.[id] !== undefined

  function control(m: ModInfo, f: ModInfo['settings'][number]): string {
    const at = `data-test="set-mods.${m.id}.${f.key}" data-mod-field="${esc(f.key)}" data-mod="${m.id}"`
    switch (f.type) {
      case 'boolean':
        return `<label class="set-toggle"><input type="checkbox" ${at}><i></i><span><b>${esc(f.label)}</b></span></label>`
      case 'select':
        return `<div class="set-row"><div class="set-label">${esc(f.label)}</div><div class="set-control"><select class="field" ${at}>${(f.options ?? [])
          .map((o) => `<option value="${esc(o)}">${esc(o)}</option>`)
          .join('')}</select></div></div>`
      default: {
        const kind = f.type === 'number' ? 'number' : f.type === 'secret' ? 'password' : 'text'
        return `<div class="set-row"><div class="set-label">${esc(f.label)}</div><div class="set-control"><input class="field" type="${kind}" ${f.type === 'number' ? 'step="any"' : ''} autocomplete="off" spellcheck="false" ${at}></div></div>`
      }
    }
  }

  function rowHtml(m: ModInfo): string {
    const usable = m.status !== 'invalid' && m.status !== 'incompatible'
    const s = step.get(m.id)
    const perms =
      s === 'perms'
        ? `<div class="mod-perms" data-test="mod-perms"><p><b>${esc(m.name)}</b> asks for:</p>
            <ul>${m.permissions.length ? m.permissions.map((p) => `<li data-test="mod-perm"><code>${esc(p)}</code></li>`).join('') : '<li>No special permissions.</li>'}</ul>
            <div class="set-actions"><button class="btn" type="button" data-test="mod-perms-ok" data-mod-act="enable">Enable</button>
              <button class="btn" type="button" data-mod-act="cancel">Cancel</button></div></div>`
        : ''
    const remove =
      s === 'remove'
        ? `<div class="mod-perms" data-test="mod-remove-confirm"><p>Remove <b>${esc(m.name)}</b>?</p>
            <label class="set-check"><input type="checkbox" data-test="mod-delete-data"> Also delete its data</label>
            <div class="set-actions"><button class="btn" type="button" data-test="mod-remove-ok" data-mod-act="remove-ok">Remove</button>
              <button class="btn" type="button" data-mod-act="cancel">Cancel</button></div></div>`
        : ''
    return `<div class="mod-row" data-test="mod-row" data-id="${m.id}">
      <label class="set-toggle"><input type="checkbox" data-test="set-mods.${m.id}" data-mod-toggle="${m.id}" ${usable ? '' : 'disabled'}><i></i>
        <span><b>${esc(m.name)}</b> <em class="mod-pill" data-test="mod-status" data-status="${m.status}">${m.status}</em>
          <small>${esc([m.version && `v${m.version}`, m.description].filter(Boolean).join(' · '))}</small>
          ${m.reason ? `<small class="mod-reason" data-test="mod-reason">${esc(m.reason)}</small>` : ''}</span></label>
      ${perms}
      ${m.enabled ? m.settings.map((f) => control(m, f)).join('') : ''}
      ${m.enabled && m.settingsPageUrl ? '<div class="mod-page" data-mod-page></div>' : ''}
      ${m.source === 'installed' ? `<div class="set-actions"><button class="btn" type="button" data-test="mod-remove" data-mod-act="remove">Remove</button></div>${remove}` : ''}
    </div>`
  }

  /** Paints values into a row's controls, leaving the one being typed in alone. */
  function paint(el: HTMLElement, m: ModInfo) {
    q<HTMLInputElement>(el, '[data-mod-toggle]').checked = m.enabled
    for (const c of el.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-mod-field]')) {
      if (c === document.activeElement) continue
      const f = m.settings.find((x) => x.key === c.dataset.modField)!
      if (f.type === 'secret') {
        void secretGet(m.id, f.key).then((v) => void ((c as HTMLInputElement).placeholder = v ? 'Saved. Type to replace.' : ''), () => {})
      } else if (c instanceof HTMLInputElement && c.type === 'checkbox') c.checked = m.values[f.key] === true
      else c.value = String(m.values[f.key] ?? '')
    }
  }

  function render() {
    emptyEl.hidden = mods.length > 0
    for (const [id, r] of [...rows]) {
      if (mods.some((m) => m.id === id)) continue
      r.off?.()
      r.el.remove()
      rows.delete(id)
      step.delete(id)
    }
    mods.forEach((m, i) => {
      // The panel token in the URLs changes nothing the row shows, so it stays out of the signature.
      const sig = JSON.stringify([m.name, m.version, m.description, m.status, m.reason, m.enabled, m.permissions, m.settings, m.source, !!m.settingsPageUrl, step.get(m.id)])
      let r = rows.get(m.id)
      // A new settings-page URL (the token changes when the link restarts) remounts the page; it is only compared.
      if (!r || r.sig !== sig || r.url !== m.settingsPageUrl) {
        r?.off?.()
        const el = document.createElement('div')
        el.innerHTML = rowHtml(m)
        const fresh = el.firstElementChild as HTMLElement
        r?.el.replaceWith(fresh)
        r = { el: fresh, sig, url: m.settingsPageUrl }
        rows.set(m.id, r)
        const page = fresh.querySelector<HTMLElement>('[data-mod-page]')
        if (page && m.settingsPageUrl) {
          // The same sandbox and bridge as a chat panel, with the settings page as its entry.
          r.off = mountModPanel(page, { ...m, panel: { slot: 'settings', url: m.settingsPageUrl } }, ctx.link)
        }
      }
      if (rowsEl.children[i] !== r.el) rowsEl.insertBefore(r.el, rowsEl.children[i] ?? null)
      paint(r.el, m)
    })
  }

  function paintBuiltin() {
    for (const el of host.querySelectorAll<HTMLInputElement>('[data-builtin]')) el.checked = pluginEnabled(ctx.store.get(), el.dataset.builtin!)
  }

  const modOf = (id: string | undefined) => mods.find((m) => m.id === id)

  function setStep(id: string, s: Step | undefined) {
    if (s) step.set(id, s)
    else step.delete(id)
    render()
  }

  function enable(id: string, on: boolean) {
    step.delete(id)
    ctx.link.send({ t: 'mod-enable', id, enabled: on })
  }

  /** Commits one declared field: a secret goes to the credential store first, then every kind to the link. */
  async function commit(c: HTMLInputElement | HTMLSelectElement) {
    const m = modOf(c.dataset.mod)
    const f = m?.settings.find((x) => x.key === c.dataset.modField)
    if (!m || !f) return
    let value: unknown
    if (c instanceof HTMLInputElement && c.type === 'checkbox') value = c.checked
    else if (f.type === 'number') {
      value = c.value.trim() === '' ? NaN : Number(c.value)
      if (!Number.isFinite(value as number)) return paint(rows.get(m.id)!.el, m) // not a number: back to what is stored
    } else value = c.value
    if (f.type === 'secret') {
      try {
        if (value === '') await secretDelete(m.id, f.key)
        else await secretSet(m.id, f.key, value as string)
      } catch (e) {
        return ctx.toast(`Couldn't save ${f.label} in the system keychain: ${e instanceof Error ? e.message : e}`, 6000)
      }
      c.value = ''
    }
    changedAt = Date.now()
    ctx.link.send({ t: 'mod-settings', id: m.id, values: { [f.key]: value } })
  }

  /** Waits for the link's answer to an install or removal. */
  function answer<T extends ServerMsg['t']>(t: T, id?: string) {
    return ctx.link.next((m): m is Extract<ServerMsg, { t: T }> => m.t === t && (id === undefined || (m as { id?: string }).id === id), ANSWER_MS)
  }

  async function install(replace = false, dir = '') {
    dir ||= await ctx.pickFolder('Where is the mod folder?')
    if (!dir) return
    ctx.link.send({ t: 'mod-install', path: dir, replace })
    const r = await answer('mod-install').catch(() => undefined)
    if (!r) return ctx.toast("The link didn't answer the install.", 5000)
    if (r.ok) return ctx.toast(`Installed ${r.id}. Switch it on when you're ready.`, 5000)
    if (r.needsReplace && (await ctx.confirm('Replace this mod?', `${r.reason}. Replace it with the version in that folder? Its saved data stays.`, 'Replace', 'Keep'))) return install(true, dir)
    if (!r.needsReplace) ctx.toast(`Couldn't install it: ${r.reason}`, 6000)
  }

  async function remove(m: ModInfo, deleteData: boolean) {
    step.delete(m.id)
    if (deleteData) for (const f of m.settings) if (f.type === 'secret') await secretDelete(m.id, f.key).catch(() => {})
    ctx.link.send({ t: 'mod-remove', id: m.id, deleteData })
    const r = await answer('mod-remove', m.id).catch(() => undefined)
    if (r && !r.ok) ctx.toast(`Couldn't remove ${m.name}: ${r.reason}`, 6000)
  }

  host.addEventListener('change', (e) => {
    const t = e.target
    if (!(t instanceof HTMLInputElement || t instanceof HTMLSelectElement)) return
    if (t.dataset.builtin) {
      const on = (t as HTMLInputElement).checked
      // Only a real change is written, so toggling back and forth does not queue settings saves for nothing.
      if (on !== pluginEnabled(ctx.store.get(), t.dataset.builtin)) ctx.store.update((s) => setPluginFlag(s, t.dataset.builtin!, on))
    } else if (t.dataset.modToggle) {
      const id = t.dataset.modToggle
      const on = (t as HTMLInputElement).checked
      if (on && !approved(id)) {
        ;(t as HTMLInputElement).checked = false
        setStep(id, 'perms')
      } else enable(id, on)
    } else if (t.dataset.modField) void commit(t)
  })

  host.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-mod-act]')
    if (!b) return
    const id = b.closest<HTMLElement>('[data-id]')?.dataset.id
    const m = modOf(id)
    switch (b.dataset.modAct) {
      case 'install':
        return void install()
      case 'enable':
        return void (id && enable(id, true))
      case 'cancel':
        return void (id && setStep(id, undefined))
      case 'remove':
        return void (id && setStep(id, 'remove'))
      case 'remove-ok':
        return void (m && remove(m, q<HTMLInputElement>(b.closest<HTMLElement>('.mod-row')!, '[data-test="mod-delete-data"]').checked))
    }
  })

  ctx.link.on((m) => {
    if (m.t === 'mods') {
      mods = m.mods
      render()
    } else if (m.t === 'app_error' && Date.now() - changedAt < REFUSAL_MS) {
      // A refused value (the link says which and why); the field goes back to what is stored.
      changedAt = 0
      ctx.toast(m.message, 6000)
      render()
      for (const mod of mods) paint(rows.get(mod.id)!.el, mod)
    }
  })
  ctx.store.subscribe(paintBuiltin)
  paintBuiltin()
  // Phones have no mods (they are managed on the desktop): only the built-in switches show.
  if (ctx.link.remote) host.querySelector<HTMLElement>('[data-test="mods-list"]')!.hidden = true

  return {
    show() {
      paintBuiltin()
      if (!ctx.link.remote) ctx.link.send({ t: 'mods' })
    },
  }
}
