// Choice menus the agent opens: permission prompts, AskUserQuestion, plan approval (R20, R21) and MCP
// elicitation forms. One is shown at a time; the rest wait in a FIFO queue, so a prompt from a background
// helper never replaces (and strands) the one on screen.

import { elicitContent } from '../../../link/src/elicit.ts'
import type { Diff, ElicitField, ElicitValue, Question, SessionEvent } from '../../../link/src/protocol.ts'
import type { Ctx, Gesture } from '../contracts'
import { esc } from '../ui'
import { relPath } from './panels'

type AskMsg = Extract<SessionEvent, { t: 'ask_permission' } | { t: 'ask_question' } | { t: 'ask_plan' } | { t: 'ask_elicit' }>
type Entry = { m: AskMsg; step: number; answers: Record<string, string>; picked: Set<string>; greeted: boolean }

/**
 * Keys are ignored for this long after a menu opens (and after each key in that window), so typing meant for
 * the input never answers it.
 */
const ARM_MS = 350
/** Unchanged lines kept around each change in a diff. */
const DIFF_CONTEXT = 3
/** Cells in the line-diff table before falling back to "all removed, all added". */
const MAX_DIFF_CELLS = 640_000
/** Diff rows rendered; the rest are summarized. */
const MAX_DIFF_ROWS = 400
const MAX_DETAIL_CHARS = 4000
const DECLINE_QUESTION = 'The user dismissed the question without answering. Continue without it, or ask in plain text if you must.'

export type Asks = {
  push(m: AskMsg): void
  cancel(id: string): void
  clear(): void
  isOpen(): boolean
  /** Esc: No on a permission, Keep planning on a plan, dismiss a question. */
  escape(): void
  /** Keys while the menu is the top layer (1–9, ↑↓, Enter). Returns true when handled. */
  key(e: KeyboardEvent): boolean
  /** Takes the focus as the menu would on opening (after you stop typing). */
  focus(): void
}

type Line = { op: ' ' | '-' | '+'; s: string }

/** Line diff of `a` → `b` (LCS after trimming the common head and tail). */
export function lineDiff(a: string[], b: string[]): Line[] {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const A = a.slice(pre, a.length - suf)
  const B = b.slice(pre, b.length - suf)
  const same = (s: string): Line => ({ op: ' ', s })
  const out: Line[] = a.slice(0, pre).map(same)
  if (A.length * B.length > MAX_DIFF_CELLS) {
    out.push(...A.map((s): Line => ({ op: '-', s })), ...B.map((s): Line => ({ op: '+', s })))
  } else {
    const w = B.length + 1
    const lcs = new Uint32Array((A.length + 1) * w)
    for (let i = A.length - 1; i >= 0; i--) {
      for (let j = B.length - 1; j >= 0; j--) {
        lcs[i * w + j] = A[i] === B[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < A.length || j < B.length) {
      if (i < A.length && j < B.length && A[i] === B[j]) out.push(same(A[i++])), j++
      // Ties go to the removal, so a changed line reads − then +, as in the CLI and every diff tool.
      else if (i < A.length && (j === B.length || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) out.push({ op: '-', s: A[i++] })
      else out.push({ op: '+', s: B[j++] })
    }
  }
  out.push(...a.slice(a.length - suf).map(same))
  return out
}

const lines = (s: string) => (s === '' ? [] : s.replace(/\r\n/g, '\n').split('\n'))

function renderDiff(d: Diff, cwd = '') {
  const ops = lineDiff(lines(d.before), lines(d.after))
  const added = ops.filter((l) => l.op === '+').length
  const removed = ops.filter((l) => l.op === '-').length
  // Keep DIFF_CONTEXT unchanged lines around each change; fold the rest.
  const keep = ops.map((l, i) => l.op !== ' ' || ops.slice(Math.max(0, i - DIFF_CONTEXT), i + DIFF_CONTEXT + 1).some((x) => x.op !== ' '))
  let html = ''
  let rows = 0
  let folded = 0
  for (let i = 0; i < ops.length; i++) {
    if (!keep[i]) {
      folded++
      continue
    }
    if (folded) html += `<div class="dl fold">⋯ ${folded} unchanged line${folded > 1 ? 's' : ''}</div>`
    folded = 0
    if (++rows > MAX_DIFF_ROWS) {
      html += `<div class="dl fold">⋯ ${ops.length - i} more lines</div>`
      break
    }
    const l = ops[i]
    html += `<div class="dl ${l.op === '+' ? 'add' : l.op === '-' ? 'del' : ''}"><i>${l.op}</i><span>${esc(l.s) || ' '}</span></div>`
  }
  if (folded) html += `<div class="dl fold">⋯ ${folded} unchanged line${folded > 1 ? 's' : ''}</div>`
  return `<div class="diff" data-test="ask-diff"><div class="diff-file"><span title="${esc(d.path)}">${esc(relPath(d.path, cwd))}</span>`
    + `<small><b class="add">+${added}</b> <b class="del">−${removed}</b></small></div><div class="diff-body">${html}</div></div>`
}

/** Permission prompts that open on No and take no one-key approval. */
const cautious = (e: Entry) => e.m.t === 'ask_permission' && (e.m.defaultToNo || e.m.danger)

const clip = (s: string) => (s.length > MAX_DETAIL_CHARS ? `${s.slice(0, MAX_DETAIL_CHARS)}\n…` : s)

export function createAsks(
  root: HTMLElement,
  deps: {
    ctx: Ctx
    name(): string
    log(line: string): void
    gesture(g: Gesture): void
    markdown(src: string): string
    onChange(open: boolean): void
    /** True while you are typing in the composer: the menu then waits for you instead of taking the focus. */
    typing?(): boolean
    /** The project folder: a diff names its file inside it. */
    cwd?(): string
  },
): Asks {
  root.className = 'overlay chat-ask'
  root.tabIndex = -1
  const queue: Entry[] = []
  let openedAt = 0
  let armTimer: number | undefined

  const head = () => queue[0]
  const choices = () => [...root.querySelectorAll<HTMLButtonElement>('.choice')]
  const other = () => root.querySelector<HTMLInputElement>('.other')
  const send: Ctx['link']['send'] = (m) => deps.ctx.link.send(m)

  const choice = (v: string, label: string, sub = '', cls = '') =>
    `<button type="button" class="choice ${cls}" data-test="ask-option" data-v="${esc(v)}">`
      + `<b class="n"></b><span>${esc(label)}</span><small>${esc(sub)}</small></button>`

  const caption = (text: string) => `<small>${esc(text)}<span class="more"></span></small>`
  const updateMore = () => {
    const more = root.querySelector('.more')
    if (more) more.textContent = queue.length > 1 ? ` · ${queue.length - 1} more waiting` : ''
  }

  function done() {
    queue.shift()
    show()
  }

  function show() {
    const e = head()
    if (!e) {
      root.classList.remove('show')
      root.innerHTML = ''
      // The hook marks an open menu only.
      delete root.dataset.test
      delete root.dataset.kind
      delete root.dataset.armed
      return deps.onChange(false)
    }
    root.dataset.test = 'ask'
    root.dataset.kind = { ask_permission: 'permission', ask_question: 'question', ask_plan: 'plan', ask_elicit: 'elicit' }[e.m.t]
    if (e.m.t === 'ask_permission') permission(e.m)
    else if (e.m.t === 'ask_question') question(e, e.m)
    else if (e.m.t === 'ask_elicit') elicit(e.m)
    else plan(e.m)
    choices().forEach((b, i) => (b.querySelector('.n')!.textContent = i < 9 ? String(i + 1) : ''))
    updateMore()
    root.classList.add('show')
    openedAt = performance.now()
    // data-armed: the menu takes clicks and keys now (a hook for the E2E driver, which waits for it).
    delete root.dataset.armed
    clearTimeout(armTimer)
    armTimer = window.setTimeout(() => root.dataset.test && (root.dataset.armed = '1'), ARM_MS)
    // Nothing is focused unless the safe answer is No, so a stray Enter never approves. Mid-sentence it takes no
    // focus at all: the keys stay yours, and Tab or a click moves to the menu.
    if (!deps.typing?.()) (cautious(e) ? root.querySelector<HTMLElement>('.choice[data-v="deny"]') : root)?.focus()
    if (!e.greeted) {
      e.greeted = true
      deps.gesture(e.m.t === 'ask_permission' && e.m.danger ? 'danger' : 'confirm')
    }
    deps.onChange(true)
  }

  /**
   * Clicks wait out the same arming window as keys: a click meant to turn a dialogue page must not land on
   * "don't ask again" or No in a menu that just opened under the pointer.
   */
  const armed = () => performance.now() - openedAt >= ARM_MS

  function onOther(submit: (text: string) => void) {
    const input = other()!
    input.addEventListener('keydown', (ev) => {
      if (ev.isComposing || ev.keyCode === 229) return
      if (ev.key !== 'Enter' || !input.value.trim()) return
      ev.preventDefault()
      submit(input.value.trim())
    })
  }

  function permission(m: Extract<AskMsg, { t: 'ask_permission' }>) {
    const name = deps.name()
    const body = m.diffs.length
      ? m.diffs.map((d) => renderDiff(d, deps.cwd?.() ?? '')).join('')
      : m.input ? `<pre class="cmd">${esc(clip(m.input))}</pre>`
      : m.detail ? `<pre class="cmd${m.danger ? ' danger' : ''}">${esc(clip(m.detail))}</pre>` : ''
    const lead = m.danger ? `${name} is worried · this cannot be undone` : `${name} asks for permission`
    // The CLI's own rows when the link worded them (one per "don't ask again" scope), else the generic three.
    // data-v is the decision, data-option the row: two "always" rows differ only in what they save.
    const rows = m.choices?.length
      ? m.choices.map((c) => choice(c.decision, c.label, '', c.decision === 'deny' ? 'deny' : '').replace('data-v=', `data-option="${esc(c.id)}"${c.mode ? ' data-mode="1"' : ''} data-v=`)).join('')
      : choice('allow', 'Yes', 'Allow once')
        + (m.canAlways ? choice('always', "Yes, and don't ask again", m.always ? `Saves: ${m.always}` : 'Saves a permission rule') : '')
        + choice('deny', 'No', `${name} stops and waits for you`, 'deny')
    root.innerHTML = `<div class="ask${m.danger ? ' danger' : ''}">
      <div class="t">${caption(lead)}${esc(m.title || m.tool)}</div>
      ${m.reason ? `<div class="reason">${esc(m.reason)}</div>` : ''}
      ${body}
      ${m.question ? `<div class="q" data-test="ask-question">${esc(m.question)}</div>` : ''}
      <div class="choices">
        ${rows}
        <input class="other field" data-test="ask-other" placeholder="…or tell ${esc(name)} what to do differently (Enter)">
      </div>
    </div>`
    const answer = (decision: 'allow' | 'always' | 'deny' | 'feedback', message?: string, option?: string) => {
      send({ t: 'permission', id: m.id, decision, ...(message ? { message } : {}), ...(option ? { option } : {}) })
      const label = option ? m.choices?.find((c) => c.id === option)?.label : undefined
      const verb = label ?? { allow: 'Allowed', always: 'Always allowed', deny: 'Denied', feedback: 'Denied with a note' }[decision]
      deps.log(`▸ ${verb}: ${m.title || m.tool}${message ? ` · “${message}”` : ''}`)
      done()
    }
    root.querySelector('.choices')!.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>('.choice')
      if (b && armed()) answer(b.dataset.v as 'allow' | 'always' | 'deny' | 'feedback', undefined, b.dataset.option)
    })
    onOther((text) => answer('feedback', text))
  }

  /** Shift+Tab on a permission prompt: the CLI's "accept and switch mode", the row that switches the session's mode. */
  function modeRow() {
    return root.querySelector<HTMLElement>('.choice[data-mode="1"]')
  }

  function question(e: Entry, m: Extract<AskMsg, { t: 'ask_question' }>) {
    const q: Question = m.questions[e.step]
    const count = m.questions.length > 1 ? ` · ${e.step + 1} of ${m.questions.length}` : ''
    const previews = q.options.some((o) => o.preview)
    root.innerHTML = `<div class="ask${previews ? ' with-preview' : ''}">
      <div class="t">${caption(`${deps.name()} asks${count}${q.header ? ` · ${q.header}` : ''}`)}</div>
      <div class="q">${esc(q.question)}</div>
      <div class="cols">
        <div class="choices">
          ${q.options.map((o) => choice(o.label, o.label, o.description, e.picked.has(o.label) ? 'picked' : '')).join('')}
          ${q.multiSelect ? choice('__confirm', 'Confirm', 'Send the picked options', 'confirm') : ''}
          <input class="other field" data-test="ask-other" placeholder="Something else… (Enter)">
        </div>
        ${previews ? '<pre class="preview"></pre>' : ''}
      </div>
    </div>`
    const finish = (answer: string) => {
      e.answers[q.question] = answer
      e.picked.clear()
      if (++e.step < m.questions.length) return show()
      send({ t: 'answer', id: m.id, answers: e.answers })
      deps.log(`▸ ${Object.entries(e.answers).map(([k, v]) => `${k} → ${v}`).join(' · ')}`)
      done()
    }
    const box = root.querySelector('.choices')!
    box.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>('.choice')
      if (!b || !armed()) return
      const v = b.dataset.v!
      if (!q.multiSelect) return finish(v)
      if (v === '__confirm') {
        if (e.picked.size) finish(q.options.filter((o) => e.picked.has(o.label)).map((o) => o.label).join(', '))
        return
      }
      if (e.picked.has(v)) e.picked.delete(v)
      else e.picked.add(v)
      b.classList.toggle('picked', e.picked.has(v))
    })
    if (previews) {
      const pane = root.querySelector<HTMLElement>('.preview')!
      const preview = (label?: string) => {
        const o = q.options.find((x) => x.label === label) ?? q.options.find((x) => x.preview)
        pane.textContent = o?.preview ?? ''
      }
      preview()
      for (const ev of ['mouseover', 'focusin']) {
        box.addEventListener(ev, (x) => {
          const b = (x.target as HTMLElement).closest<HTMLElement>('.choice')
          if (b) preview(b.dataset.v)
        })
      }
    }
    // In a multi-select, the typed answer joins the options already ticked.
    onOther((text) => finish(q.multiSelect ? [...q.options.filter((o) => e.picked.has(o.label)).map((o) => o.label), text].join(', ') : text))
  }

  function plan(m: Extract<AskMsg, { t: 'ask_plan' }>) {
    const name = deps.name()
    root.innerHTML = `<div class="ask">
      <div class="t">${caption(`${name} has a plan`)}Shall we begin?</div>
      <div class="plan">${m.plan ? deps.markdown(m.plan) : '<i>The plan is in the LOG.</i>'}</div>
      ${m.planFile ? `<div class="reason mono">${esc(m.planFile)}</div>` : ''}
      <div class="choices">
        ${choice('auto', 'Yes, and auto-accept edits', `${name} edits without asking`)}
        ${choice('manual', 'Yes, and approve edits manually', 'You confirm each edit')}
        ${choice('keep', 'No, keep planning', `${name} revises the plan`, 'deny')}
        <input class="other field" data-test="ask-other" placeholder="…or tell ${esc(name)} what to change (Enter)">
      </div>
    </div>`
    const answer = (decision: 'auto' | 'manual' | 'keep', message?: string) => {
      send({ t: 'plan', id: m.id, decision, message })
      const verb = { auto: 'Plan approved · auto-accept edits', manual: 'Plan approved · manual edits', keep: 'Keep planning' }[decision]
      deps.log(`▸ ${verb}${message ? ` · “${message}”` : ''}`)
      done()
    }
    root.querySelector('.choices')!.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>('.choice')
      if (b && armed()) answer(b.dataset.v as 'auto' | 'manual' | 'keep')
    })
    onOther((text) => answer('keep', text))
  }

  /** An MCP server's form (from its JSON schema) or its URL step, with the CLI's Accept / Decline and Esc to cancel. */
  function elicit(m: Extract<AskMsg, { t: 'ask_elicit' }>) {
    const lead = `MCP server “${m.server}” ${m.mode === 'url' ? 'wants to open a URL' : 'requests your input'}`
    const form = m.fields.map(fieldHtml).join('')
    const buttons = m.mode === 'url'
      ? choice('open', 'Open URL', m.url ?? '') + choice('accept', 'Continue without waiting', 'The server finishes on its own')
        + choice('cancel', 'Cancel', '', 'deny')
      : choice('accept', 'Accept', 'Send these answers') + choice('decline', 'Decline', `Tell ${m.server} no`, 'deny')
    root.innerHTML = `<div class="ask elicit">
      <div class="t">${caption(lead)}${esc(m.title || m.message)}</div>
      ${m.title ? `<div class="reason">${esc(m.message)}</div>` : ''}
      ${form ? `<form class="eform" data-test="elicit-form" novalidate>${form}</form>` : ''}
      <div class="eerr" data-test="elicit-error" hidden></div>
      <div class="choices">${buttons}</div>
    </div>`
    const err = root.querySelector<HTMLElement>('.eerr')!
    const reply = (action: 'accept' | 'decline' | 'cancel', content?: Record<string, ElicitValue>) => {
      send({ t: 'elicit', id: m.id, action, ...(content ? { content } : {}) })
      deps.log(`▸ ${{ accept: 'Sent', decline: 'Declined', cancel: 'Cancelled' }[action]}: ${m.server} · ${m.title || m.message}`)
      done()
    }
    root.querySelector('.choices')!.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>('.choice')
      if (!b || !armed()) return
      const v = b.dataset.v as 'open' | 'accept' | 'decline' | 'cancel'
      if (v === 'open') return void (m.url && send({ t: 'open', target: m.url }))
      if (v !== 'accept' || m.mode === 'url') return reply(v)
      // The link checks the same rules; checking here keeps the form open with the reason instead.
      try {
        reply('accept', elicitContent(m.fields, readForm(m.fields)))
      } catch (x) {
        err.textContent = (x as Error).message
        err.hidden = false
      }
    })
    // A choice or multi field is a row of chips: exactly one on, or any number on.
    root.querySelector('.eform')?.addEventListener('click', (ev) => {
      const chip = (ev.target as HTMLElement).closest<HTMLElement>('.echip')
      if (!chip) return
      const row = chip.closest<HTMLElement>('.efield')!
      if (row.dataset.kind === 'choice') for (const c of row.querySelectorAll('.echip')) c.classList.toggle('on', c === chip)
      else chip.classList.toggle('on')
    })
  }

  function fieldHtml(f: ElicitField) {
    const label = `<span class="elabel">${esc(f.title)}${f.required ? ' <i>*</i>' : ''}</span>`
    const hint = f.description ? `<small>${esc(f.description)}</small>` : ''
    let input: string
    if (f.kind === 'boolean') {
      input = `<input type="checkbox" class="echeck" name="${esc(f.name)}"${f.default === true ? ' checked' : ''}>`
    } else if (f.kind === 'choice' || f.kind === 'multi') {
      const on = (v: string) => (Array.isArray(f.default) ? f.default.includes(v) : f.default === v)
      input = `<span class="echips">${(f.options ?? [])
        .map((o) => `<button type="button" class="echip${on(o.value) ? ' on' : ''}" data-v="${esc(o.value)}">${esc(o.label)}</button>`)
        .join('')}</span>`
    } else {
      const formats: Record<string, string> = { email: 'email', uri: 'url', date: 'date', 'date-time': 'datetime-local' }
      const type = f.kind === 'text' ? formats[f.format ?? ''] ?? 'text' : 'number'
      const def = f.default === undefined ? '' : ` value="${esc(String(f.default))}"`
      input = `<input class="field" type="${type}" name="${esc(f.name)}"${def}${f.kind === 'integer' ? ' step="1"' : ''} spellcheck="false">`
    }
    return `<div class="efield" data-test="elicit-field" data-name="${esc(f.name)}" data-kind="${f.kind}">${label}${input}${hint}</div>`
  }

  function readForm(fields: ElicitField[]) {
    const out: Record<string, unknown> = {}
    for (const f of fields) {
      const row = root.querySelector<HTMLElement>(`.efield[data-name="${CSS.escape(f.name)}"]`)
      if (!row) continue
      if (f.kind === 'boolean') out[f.name] = row.querySelector<HTMLInputElement>('input')!.checked
      else if (f.kind === 'choice') out[f.name] = row.querySelector<HTMLElement>('.echip.on')?.dataset.v ?? ''
      else if (f.kind === 'multi') out[f.name] = [...row.querySelectorAll<HTMLElement>('.echip.on')].map((c) => c.dataset.v!)
      else out[f.name] = row.querySelector<HTMLInputElement>('input')!.value.trim()
    }
    return out
  }

  return {
    push(m) {
      queue.push({ m, step: 0, answers: {}, picked: new Set(), greeted: false })
      // A later prompt only updates the "N more waiting" caption; the one on screen stays (and stays armed).
      if (queue.length === 1) show()
      else updateMore()
    },
    cancel(id) {
      const i = queue.findIndex((e) => e.m.id === id)
      if (i < 0) return
      queue.splice(i, 1)
      if (i === 0) show()
    },
    clear() {
      queue.length = 0
      show()
    },
    isOpen: () => queue.length > 0,
    focus() {
      const e = head()
      if (!e || root.contains(document.activeElement)) return
      ;(cautious(e) ? root.querySelector<HTMLElement>('.choice[data-v="deny"]') : root)?.focus()
    },
    escape() {
      const e = head()
      if (!e) return
      const input = other()
      if (input && document.activeElement === input && input.value) return void (input.value = '')
      if (e.m.t === 'ask_permission') {
        send({ t: 'permission', id: e.m.id, decision: 'deny' })
        deps.log(`▸ Denied: ${e.m.title || e.m.tool}`)
      } else if (e.m.t === 'ask_plan') {
        send({ t: 'plan', id: e.m.id, decision: 'keep' })
        deps.log('▸ Keep planning')
      } else if (e.m.t === 'ask_elicit') {
        send({ t: 'elicit', id: e.m.id, action: 'cancel' })
        deps.log(`▸ Cancelled: ${e.m.server}`)
      } else {
        send({ t: 'permission', id: e.m.id, decision: 'feedback', message: DECLINE_QUESTION })
        deps.log('▸ Question dismissed')
      }
      done()
    },
    key(e) {
      if (!head() || e.isComposing || e.keyCode === 229) return false
      // Typing somewhere else (you clicked back into the composer) is not an answer.
      const focus = document.activeElement
      if (focus && focus !== document.body && !root.contains(focus)) return false
      // Keys typed into an elicitation form belong to its fields; they never pick an answer.
      if ((document.activeElement as HTMLElement | null)?.closest('.eform')) return false
      const input = other()
      const inInput = document.activeElement === input
      if (inInput && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return false
      // Keys typed while the menu arms (you were mid-sentence when it popped up) are swallowed and keep it
      // unarmed, so "fix 2 bugs" never picks option 2.
      if (performance.now() - openedAt < ARM_MS || e.repeat) {
        openedAt = performance.now()
        return true
      }
      const list: HTMLElement[] = [...choices(), ...(input ? [input] : [])]
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const at = list.indexOf(document.activeElement as HTMLElement)
        const step = e.key === 'ArrowDown' ? 1 : -1
        const next = at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length
        list[next]?.focus()
        return true
      }
      if (inInput) return false
      if (e.key === 'Tab' && e.shiftKey && head()?.m.t === 'ask_permission') {
        modeRow()?.click()
        return true
      }
      if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const b = choices()[Number(e.key) - 1]
        // A risky prompt has no one-key approve (the CLI's defaultToNo): approving takes a click, or ↑↓ and Enter.
        if (b && !(cautious(head()) && b.dataset.v !== 'deny')) b.click()
        return true
      }
      if (e.key === 'Enter' || e.key === ' ') {
        const focused = document.activeElement as HTMLElement | null
        if (focused?.classList.contains('choice')) focused.click()
        return true
      }
      return false
    },
  }
}
