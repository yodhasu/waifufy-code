import type { Command, Emotion, Question, ServerMsg, Stats, Todo } from '../../link/src/protocol.ts'
import type { Link } from './link'
import type { Rem } from './rem'
import { $, esc, fmtDur, fmtK, plainText, renderMarkdown, resetsIn, toast } from './ui'

/** One screen of dialogue. `face` is the emotion tag that came before it. */
type Page = { text: string; face?: Emotion }
type Entry = { who: 'rem' | 'user' | 'narr'; text: string }
type Tool = { name: string; detail: string; el: HTMLElement; done: boolean }

const TYPE_TICK_MS = 18
const CHARS_PER_TICK = 2
/** Longer paragraphs are split into several pages at sentence (or line) boundaries. */
const PAGE_CHARS = 300
const AUTO_BASE_MS = 1200
const AUTO_PER_CHAR_MS = 28
/** Page interval while Ctrl is held. */
const SKIP_MS = 70
const ACTIONS_SHOWN = 12
/** A finished turn this long gets her "success" reaction. */
const SUCCESS_MIN_SECONDS = 20
const MODES = [['default', 'Default'], ['acceptEdits', 'Accept edits'], ['plan', 'Plan']] as const

const ICONS: Record<string, string> = {
  Read: '📖', Write: '✒️', Edit: '✒️', NotebookEdit: '✒️', Bash: '⚔️', PowerShell: '⚔️', Grep: '🔍', Glob: '🔍',
  WebFetch: '🌐', WebSearch: '🌐', Skill: '✦', Agent: '👥', Task: '👥', TodoWrite: '📜',
}
const isHelper = (name: string) => name === 'Agent' || name === 'Task'

/** Context categories from getContextUsage(), grouped into the five colors of the memory bar. */
const CONTEXT_GROUPS: Record<string, string> = {
  system_prompt: 'system', system_tools: 'tools', skills: 'tools', custom_agents: 'tools',
  mcp_tools: 'mcp', mcp_instructions: 'mcp', memory_files: 'memory', messages: 'messages',
}

function oneLine(s: string, max = 90) {
  const line = s.split('\n')[0]
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** What the ribbon says she is doing. */
function doing(name: string, detail: string) {
  const d = detail ? ` <code>${esc(oneLine(detail))}</code>` : ''
  switch (name) {
    case 'Read': return `Rem is reading${d}…`
    case 'Write':
    case 'Edit':
    case 'NotebookEdit': return `Rem is writing${d}…`
    case 'Bash':
    case 'PowerShell': return `Rem is running${d}…`
    case 'Grep':
    case 'Glob': return `Rem is searching for${d}…`
    case 'WebFetch': return `Rem is visiting${d}…`
    case 'WebSearch': return `Rem is looking up${d}…`
    case 'Skill': return `Rem opens the${d} notebook…`
    case 'Agent':
    case 'Task': return `Rem sends a helper:${d}…`
    case 'TodoWrite': return 'Rem updates the quest log…'
    default: return `Rem uses <b>${esc(name)}</b>${d}…`
  }
}

/** Splits a paragraph into pages that fit the dialogue box: by line for lists, else by sentence. */
function splitLong(text: string): string[] {
  if (text.length <= PAGE_CHARS) return [text]
  const pieces = text.includes('\n') ? text.split(/(?<=\n)/) : (text.match(/[^.!?…]+[.!?…]+["'”’)\]]*\s*|[^.!?…]+$/g) ?? [text])
  const pages: string[] = []
  let page = ''
  for (const piece of pieces) {
    if (page && page.length + piece.length > PAGE_CHARS) (pages.push(page.trim()), (page = ''))
    page += piece
  }
  if (page.trim()) pages.push(page.trim())
  return pages
}

/** Where the first paragraph of `s` ends: after a blank line outside a code fence, or -1. */
function paragraphEnd(s: string) {
  let inFence = false
  let offset = 0
  const lines = s.split('\n')
  // The last line may still be streaming.
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].trimStart().startsWith('```')) inFence = !inFence
    offset += lines[i].length + 1
    if (!inFence && lines[i].trim() === '') return offset
  }
  return -1
}

export function createChat(link: Link, rem: Rem, hooks: { onMenu(): void }) {
  let active = false
  let userName = 'Yodha'
  let startedAt = 0
  let okTurns = 0
  let running = false
  let stats: Stats | undefined
  let commands: Command[] = []
  let models: { value: string; displayName: string }[] = []
  const backlog: Entry[] = []
  const tools = new Map<string, Tool>()

  // ---------- Dialogue pages ----------
  const queue: Page[] = []
  let buf = ''
  let bufFace: Emotion | undefined
  let showing = false
  let waiting = false
  let typing: number | undefined
  let typedHtml = ''
  let pageNo = 0
  let auto = false
  let skipping = false

  function log(who: Entry['who'], text: string) {
    backlog.push({ who, text })
    if ($('backlog').classList.contains('show')) renderBacklog()
  }

  function nameplate(who: 'rem' | 'user' | 'none') {
    $('name').textContent = who === 'rem' ? 'Rem' : who === 'user' ? userName : ''
    $('name').className = `nameplate${who === 'user' ? ' user' : who === 'none' ? ' hidden' : ''}`
  }

  function narrate(html: string, thinking = false) {
    clearInterval(typing)
    typing = undefined
    nameplate(thinking ? 'rem' : 'none')
    $('line').className = `narration${thinking ? ' thinking' : ''}`
    $('line').innerHTML = html
  }

  function updateAdvance() {
    const adv = $('adv')
    adv.classList.toggle('show', waiting)
    adv.classList.toggle('more', queue.length > 0)
    adv.dataset.more = queue.length ? `+${queue.length}` : ''
  }

  function showNext() {
    clearInterval(typing)
    typing = undefined
    const page = queue.shift()
    if (!page) {
      showing = false
      waiting = false
      updateAdvance()
      return
    }
    showing = true
    pageNo++
    if (page.face) rem.emote(page.face)
    nameplate('rem')
    $('line').className = ''
    const html = renderMarkdown(page.text)
    if (skipping || page.text.includes('```')) return finishTyping(html)
    const plain = plainText(page.text)
    typedHtml = html
    let n = 0
    $('line').textContent = ''
    typing = window.setInterval(() => {
      n += CHARS_PER_TICK
      $('line').textContent = plain.slice(0, n)
      if (n >= plain.length) finishTyping(html)
    }, TYPE_TICK_MS)
  }

  function finishTyping(html = typedHtml) {
    clearInterval(typing)
    typing = undefined
    $('line').innerHTML = html
    $('line').scrollTop = 0
    waiting = true
    updateAdvance()
    const page = pageNo
    const later = (ms: number) => setTimeout(() => page === pageNo && waiting && (auto || skipping) && advance(), ms)
    if (skipping) later(SKIP_MS)
    else if (auto) later(AUTO_BASE_MS + plainText(html).length * AUTO_PER_CHAR_MS)
  }

  function advance() {
    if (typing) return finishTyping()
    if (!waiting) return
    waiting = false
    showNext()
    if (!showing && running) narrate('Rem is working', true)
  }

  function pushParagraph(text: string) {
    text = text.trim()
    if (!text) return
    const face = bufFace
    bufFace = undefined
    const pages = text.includes('```') ? [text] : splitLong(text)
    pages.forEach((p, i) => queue.push({ text: p, face: i === 0 ? face : undefined }))
    log('rem', text)
    if (!showing) showNext()
    else updateAdvance()
  }

  function onText(delta: string) {
    buf += delta
    for (let cut = paragraphEnd(buf); cut >= 0; cut = paragraphEnd(buf)) {
      pushParagraph(buf.slice(0, cut))
      buf = buf.slice(cut)
    }
  }

  function onTextEnd() {
    pushParagraph(buf)
    buf = ''
  }

  // A new emotion starts a new page, the way a VN changes sprites between lines.
  function onFace(e: Emotion) {
    if (buf.trim()) pushParagraph(buf)
    buf = ''
    bufFace = e
  }

  // ---------- Ribbon, actions, quests, party ----------
  function updateRibbon() {
    const live = [...tools.values()].filter((t) => !t.done).at(-1)
    $('ribbon').classList.toggle('show', !!live)
    if (live) $('ribbon').innerHTML = doing(live.name, live.detail)
  }

  function onTool(m: Extract<ServerMsg, { t: 'tool' }>) {
    const el = document.createElement('div')
    el.className = `act run${m.sub ? ' sub' : ''}`
    el.innerHTML = `<div class="ai">${ICONS[m.name] ?? '✧'}</div><div><div class="an">${esc(m.name)}</div><div class="ad">${esc(oneLine(m.detail, 60))}</div></div><div class="as">●</div>`
    el.title = m.detail
    $('actions').prepend(el)
    while ($('actions').children.length > ACTIONS_SHOWN) $('actions').lastElementChild!.remove()
    tools.set(m.id, { name: m.name, detail: m.detail, el, done: false })
    if (isHelper(m.name)) {
      const chip = document.createElement('span')
      chip.className = 'running'
      chip.dataset.id = m.id
      chip.textContent = `👥 ${oneLine(m.detail, 40) || 'helper'}`
      $('party').append(chip)
    }
    if (!m.sub) log('narr', `${m.name} · ${oneLine(m.detail, 200)}`)
    updateRibbon()
  }

  function onToolDone(id: string, ok: boolean) {
    const t = tools.get(id)
    if (!t) return
    t.done = true
    t.el.className = `${t.el.className.replace(/\brun\b/, '')} ${ok ? 'ok' : 'err'}`
    t.el.querySelector('.as')!.textContent = ok ? '✔' : '✖'
    if (isHelper(t.name)) $('party').querySelector(`[data-id="${CSS.escape(id)}"]`)?.setAttribute('class', 'done')
    if (ok && (t.name === 'Bash' || t.name === 'PowerShell') && /\bgit\s+push\b/.test(t.detail)) rem.react('push')
    updateRibbon()
  }

  function renderTodos(items: Todo[]) {
    $('quests').innerHTML = items.length
      ? items.map((t) => `<li class="${t.status}">${esc(t.content)}</li>`).join('')
      : '<li class="empty">No quests yet</li>'
  }

  // ---------- Stats ----------
  function renderStats() {
    const s = stats
    if (!s) return
    if (s.context) {
      const { used, max, parts } = s.context
      $('ctxVal').textContent = `${fmtK(used)} / ${fmtK(max)} · ${Math.round((used / max) * 100)}%`
      const groups = new Map<string, number>()
      for (const p of parts) {
        const g = CONTEXT_GROUPS[p.id] ?? 'system'
        groups.set(g, (groups.get(g) ?? 0) + p.tokens)
      }
      $('ctxBar').innerHTML = ['system', 'tools', 'mcp', 'memory', 'messages']
        .map((g) => `<i style="width:${((groups.get(g) ?? 0) / max) * 100}%;background:var(--c-${g})" title="${g} ${fmtK(groups.get(g) ?? 0)}"></i>`)
        .join('')
    }
    const limit = (id: string, l?: { pct: number; resetsAt?: number }) => {
      $(`${id}Val`).textContent = l ? `${Math.round(l.pct)}%${l.resetsAt ? ` · ${resetsIn(l.resetsAt)}` : ''}` : '—'
      $(`${id}Bar`).style.width = `${Math.min(100, l?.pct ?? 0)}%`
    }
    limit('five', s.limits.fiveHour)
    limit('week', s.limits.weekly)
    $('cost').textContent = `$${s.costUsd.toFixed(2)}`
    $('turns').textContent = String(s.turns)
    $('api').textContent = fmtDur(s.apiMs)
    $('tin').textContent = fmtK(s.tokensIn)
    $('tout').textContent = fmtK(s.tokensOut)
    $('cache').textContent = fmtK(s.cacheRead)
    const read = s.cacheRead + s.cacheWrite + s.tokensIn
    $('hit').textContent = read ? `${Math.round((s.cacheRead / read) * 100)}%` : '—'
    $('model').textContent = models.find((m) => m.value === s.model)?.displayName ?? s.model ?? '—'
    const mode = MODES.find(([k]) => k === s.mode)
    $('mode').dataset.mode = s.mode ?? 'default'
    $('mode').textContent = `Mode · ${mode?.[1] ?? s.mode ?? 'Default'}`
  }

  function renderHearts(pop = false) {
    const n = Math.min(5, okTurns)
    $('hearts').innerHTML = Array.from({ length: 5 }, (_, k) => `<span class="${k < n ? 'on' : ''}${pop && k === n - 1 ? ' pop' : ''}">♥</span>`).join('')
  }

  setInterval(() => {
    const d = new Date()
    $('clock').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    if (active) $('elapsed').textContent = fmtDur(Date.now() - startedAt)
  }, 1000)

  // ---------- Choice menus ----------
  let askId: string | undefined

  function openAsk(id: string, html: string) {
    askId = id
    $('askBody').innerHTML = html
    $('ask').classList.add('show')
    $('askBody').querySelector<HTMLElement>('.choice')?.focus()
  }

  function closeAsk() {
    askId = undefined
    $('ask').classList.remove('show')
    $('msg').focus()
  }

  const choice = (value: string, label: string, sub = '', cls = '') =>
    `<button class="choice ${cls}" data-v="${esc(value)}"><span>${esc(label)}</span><small>${esc(sub)}</small></button>`

  function onPermission(m: Extract<ServerMsg, { t: 'ask_permission' }>) {
    rem.emote('worried')
    rem.react(m.danger ? 'danger' : 'confirm')
    openAsk(
      m.id,
      `<div class="t"><small>${m.danger ? 'REM IS WORRIED · THIS CANNOT BE UNDONE' : 'REM ASKS FOR PERMISSION'}</small>${esc(m.tool)}</div>
       ${m.detail ? `<pre class="cmd${m.danger ? ' danger' : ''}">${esc(m.detail)}</pre>` : ''}
       ${choice('allow', 'Yes, go ahead', 'Allow once')}
       ${m.canAlways ? choice('always', 'Always allow this', 'Saves a permission rule') : ''}
       ${choice('deny', 'Not this time, Rem', 'Deny', 'deny')}
       <input class="other" placeholder="…or tell Rem what to do instead (Enter)">`,
    )
    const answer = (decision: 'allow' | 'always' | 'deny', message?: string) => {
      link.send({ t: 'permission', id: m.id, decision, message })
      log('narr', `▸ ${decision === 'deny' ? 'Denied' : decision === 'always' ? 'Always allowed' : 'Allowed'}: ${m.tool} ${oneLine(m.detail, 120)}`)
      closeAsk()
    }
    $('askBody').onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('.choice')
      if (b) answer(b.dataset.v as 'allow' | 'always' | 'deny')
    }
    otherInput((text) => answer('deny', `The user declined and said: ${text}`))
  }

  function onQuestion(m: Extract<ServerMsg, { t: 'ask_question' }>) {
    rem.emote('think')
    rem.react('confirm')
    const answers: Record<string, string> = {}
    const ask = (i: number) => {
      const q: Question | undefined = m.questions[i]
      if (!q) {
        link.send({ t: 'answer', id: m.id, answers })
        log('narr', `▸ ${Object.entries(answers).map(([k, v]) => `${k} → ${v}`).join(' · ')}`)
        return closeAsk()
      }
      const done = (answer: string) => ((answers[q.question] = answer), ask(i + 1))
      openAsk(
        m.id,
        `<div class="t"><small>REM ASKS${m.questions.length > 1 ? ` · ${i + 1} OF ${m.questions.length}` : ''} · ${esc(q.header.toUpperCase())}</small></div>
         <div class="q">${esc(q.question)}</div>
         ${q.options.map((o) => choice(o.label, o.label, o.description)).join('')}
         ${q.multiSelect ? choice('__confirm', 'Confirm', 'Send the picked options') : ''}
         <input class="other" placeholder="Something else… (Enter)">`,
      )
      const picked = new Set<string>()
      $('askBody').onclick = (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('.choice')
        if (!b) return
        const v = b.dataset.v!
        if (!q.multiSelect) return done(v)
        if (v === '__confirm') return picked.size && done([...picked].join(', '))
        picked.has(v) ? picked.delete(v) : picked.add(v)
        b.classList.toggle('picked', picked.has(v))
      }
      otherInput(done)
    }
    ask(0)
  }

  function onPlan(m: Extract<ServerMsg, { t: 'ask_plan' }>) {
    rem.emote('nod')
    rem.react('confirm')
    openAsk(
      m.id,
      `<div class="t"><small>REM HAS A PLAN</small>May Rem begin?</div>
       <div class="plan">${m.plan ? renderMarkdown(m.plan) : '<i>The plan is in the backlog.</i>'}</div>
       ${choice('allow', 'Yes, begin', 'Approve the plan')}
       ${choice('deny', 'Keep planning', 'Rem revises it', 'deny')}
       <input class="other" placeholder="…or tell Rem what to change (Enter)">`,
    )
    const answer = (decision: 'allow' | 'deny', message?: string) => {
      link.send({ t: 'permission', id: m.id, decision, message: message ?? (decision === 'deny' ? 'Keep planning: the user wants changes before you start.' : undefined) })
      log('narr', decision === 'allow' ? '▸ Plan approved' : `▸ Keep planning${message ? `: ${message}` : ''}`)
      closeAsk()
    }
    $('askBody').onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('.choice')
      if (b) answer(b.dataset.v as 'allow' | 'deny')
    }
    otherInput((text) => answer('deny', `Keep planning. The user says: ${text}`))
  }

  function otherInput(onEnter: (text: string) => void) {
    const input = $('askBody').querySelector<HTMLInputElement>('input.other')
    input?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !input.value.trim()) return
      e.preventDefault()
      onEnter(input.value.trim())
    })
  }

  // ---------- Backlog and model picker ----------
  function renderBacklog() {
    $('log').innerHTML = backlog
      .map((e) => `<div class="e ${e.who === 'narr' ? 'narr' : e.who}"><div class="who">${e.who === 'rem' ? 'Rem' : e.who === 'user' ? esc(userName) : ''}</div><div>${e.who === 'narr' ? esc(e.text) : renderMarkdown(e.text)}</div></div>`)
      .join('')
    $('log').scrollTop = $('log').scrollHeight
  }

  function openBacklog() {
    renderBacklog()
    $('backlog').classList.add('show')
  }

  function openModels() {
    if (!models.length) return toast('Rem is still getting ready')
    $('modelList').innerHTML = models
      .map((m) => `<button class="cmd${m.value === stats?.model ? ' on' : ''}" data-v="${esc(m.value)}"><b>${esc(m.displayName)}</b><div>${esc(m.value)}</div></button>`)
      .join('')
    $('models').classList.add('show')
  }

  $('modelList').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.cmd')
    if (!b) return
    link.send({ t: 'model', model: b.dataset.v! })
    $('models').classList.remove('show')
    toast(`Rem will think with ${b.querySelector('b')!.textContent}`)
  })

  function cycleMode() {
    const i = MODES.findIndex(([k]) => k === (stats?.mode ?? 'default'))
    const [mode, label] = MODES[(i + 1) % MODES.length]
    link.send({ t: 'mode', mode })
    toast(`Permission mode · ${label}`)
  }

  // ---------- Slash command picker ----------
  type Item = { name: string; description: string; hint: string; builtin: boolean }
  let slashItems: Item[] = []
  let slashSel = 0

  function updateSlash() {
    const v = $<HTMLInputElement>('msg').value
    if (!v.startsWith('/') || /\s/.test(v)) return closeSlash()
    const q = v.slice(1).toLowerCase()
    const starts = (c: Item) => (c.name.slice(1).startsWith(q) ? 0 : 1)
    slashItems = commands
      .map((c) => ({ name: `/${c.name}`, description: c.description, hint: c.argumentHint, builtin: c.builtin }))
      .filter((c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
      .sort((a, b) => starts(a) - starts(b))
    if (!slashItems.length) return closeSlash()
    slashSel = Math.min(slashSel, slashItems.length - 1)
    $('slash').innerHTML = slashItems
      .map((c, n) => `<div class="sl${n === slashSel ? ' sel' : ''}" data-i="${n}"><b>${esc(c.name)}${c.hint ? ` <small>${esc(c.hint)}</small>` : ''}</b><span>${esc(c.description)}</span><em class="${c.builtin ? '' : 'custom'}">${c.builtin ? 'built-in' : 'custom'}</em></div>`)
      .join('')
    $('slash').classList.add('show')
    $('slash').children[slashSel].scrollIntoView({ block: 'nearest' })
  }

  function closeSlash() {
    $('slash').classList.remove('show')
    slashItems = []
    slashSel = 0
  }

  /** Enter runs a command that takes no arguments; Tab, or a command with arguments, just completes it. */
  function pickSlash(n: number, run: boolean) {
    const c = slashItems[n]
    $<HTMLInputElement>('msg').value = `${c.name} `
    closeSlash()
    if (run && !c.hint) send()
    else $('msg').focus()
  }

  // ---------- Sending ----------
  function send() {
    const input = $<HTMLInputElement>('msg')
    const text = input.value.trim()
    if (!text) return advance()
    input.value = ''
    closeSlash()
    if (text === '/model') return openModels()
    link.send({ t: 'say', text })
    log('user', text)
    running = true
    // Unread pages stay; otherwise show that she is on it.
    if (!showing && !typing) narrate('Rem is working', true)
  }

  // ---------- Server events ----------
  link.on((m) => {
    if (!active) return
    switch (m.t) {
      case 'started':
        userName = m.userName
        $('workdir').textContent = m.cwdShort
        $('workdir').title = m.cwd
        for (const h of m.history) backlog.push({ who: h.who, text: h.text })
        if (m.history.length) {
          const last = [...m.history].reverse().find((h) => h.who === 'rem')
          if (last) queue.push({ text: last.text.split(/\n\s*\n/).at(-1)!.trim() })
          showNext()
        } else {
          narrate(`Rem is ready in <code>${esc(m.cwdShort)}</code>. What shall we do today, ${esc(userName)}-kun?`)
        }
        return
      case 'init':
        commands = m.commands
        models = m.models
        renderStats()
        return
      case 'face': return onFace(m.emotion)
      case 'text': return onText(m.delta)
      case 'text_end': return onTextEnd()
      case 'tool': return onTool(m)
      case 'tool_done': return onToolDone(m.id, m.ok)
      case 'todos': return renderTodos(m.items)
      case 'ask_permission': return onPermission(m)
      case 'ask_question': return onQuestion(m)
      case 'ask_plan': return onPlan(m)
      case 'ask_cancel':
        if (askId === m.id) closeAsk()
        return
      case 'state':
        running = m.state !== 'idle'
        return
      case 'stats':
        stats = m.stats
        return renderStats()
      case 'turn_end':
        running = false
        for (const t of tools.values()) if (!t.done) t.done = true
        updateRibbon()
        if (m.ok) {
          okTurns++
          renderHearts(true)
          if (m.seconds >= SUCCESS_MIN_SECONDS) rem.react('success')
        } else {
          rem.react('fail')
          rem.emote('sad')
          toast(`Rem stumbled: ${m.error ?? 'the turn failed'}`, 5000)
          log('narr', `✖ ${m.error ?? 'The turn failed'}`)
        }
        if (!showing && !typing && $('line').classList.contains('thinking')) narrate(m.ok ? 'Rem is done.' : 'Rem stopped.')
        return
      case 'error':
        toast(m.message, 5000)
        log('narr', `✖ ${m.message}`)
        return
      case 'ended':
        running = false
        updateRibbon()
        return
    }
  })

  // ---------- Controls ----------
  $('dialogue').addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('#quickmenu') || getSelection()?.toString()) return
    advance()
  })
  $('send').addEventListener('click', send)
  $('msg').addEventListener('input', () => ((slashSel = 0), updateSlash()))
  $('msg').addEventListener('keydown', (e) => {
    const open = $('slash').classList.contains('show')
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      slashSel = (slashSel + (e.key === 'ArrowDown' ? 1 : -1) + slashItems.length) % slashItems.length
      return updateSlash()
    }
    if (open && e.key === 'Tab') return e.preventDefault(), pickSlash(slashSel, false)
    if (open && e.key === 'Escape') return e.stopPropagation(), closeSlash()
    if (e.key === 'Enter') return e.preventDefault(), open ? pickSlash(slashSel, true) : send()
  })
  $('slash').addEventListener('mousedown', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.sl')
    if (!row) return
    e.preventDefault()
    pickSlash(Number(row.dataset.i), true)
  })
  $('qLog').onclick = openBacklog
  $('qAuto').onclick = () => {
    auto = !auto
    $('qAuto').classList.toggle('on', auto)
    if (auto && waiting) advance()
  }
  $('qMode').onclick = cycleMode
  $('mode').onclick = cycleMode
  $('model').onclick = openModels
  $('qCmd').onclick = () => {
    $<HTMLInputElement>('msg').value = '/'
    $('msg').focus()
    updateSlash()
  }
  $('qStop').onclick = () => link.send({ t: 'interrupt' })
  $('qMenu').onclick = () => {
    link.send({ t: 'end' })
    active = false
    closeAsk()
    hooks.onMenu()
  }
  for (const id of ['backlog', 'models']) {
    $(id).addEventListener('click', (e) => e.target === $(id) && $(id).classList.remove('show'))
  }
  for (const b of document.querySelectorAll<HTMLElement>('[data-close]')) {
    b.addEventListener('click', () => b.closest('.overlay')!.classList.remove('show'))
  }

  addEventListener('keydown', (e) => {
    if (!active) return
    const modal = document.querySelector('#backlog.show, #models.show')
    if (e.key === 'Escape') {
      if (modal) return modal.classList.remove('show')
      if (askId) return
      if (running) link.send({ t: 'interrupt' })
      return
    }
    if (e.key === 'Control' && !askId && !e.repeat) {
      skipping = true
      if (typing || waiting) advance()
    }
    if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) return e.preventDefault(), openBacklog()
    if (e.shiftKey && e.key === 'Tab') return e.preventDefault(), cycleMode()
    if (e.key === ' ' && document.activeElement !== $('msg') && !askId && !modal) return e.preventDefault(), advance()
  })
  addEventListener('keyup', (e) => {
    if (e.key === 'Control') skipping = false
  })

  return {
    start(cwd: string, resume?: string, title?: string) {
      active = true
      userName = userName || 'Yodha'
      startedAt = Date.now()
      okTurns = 0
      running = false
      stats = undefined
      commands = []
      models = []
      backlog.length = 0
      tools.clear()
      queue.length = 0
      buf = ''
      bufFace = undefined
      showing = waiting = false
      $('actions').innerHTML = ''
      $('party').innerHTML = '<span>✧ Rem</span>'
      renderTodos([])
      renderHearts()
      for (const id of ['ctxVal', 'fiveVal', 'weekVal', 'cost', 'turns', 'api', 'tin', 'tout', 'cache', 'hit', 'model']) $(id).textContent = '—'
      $('ctxBar').innerHTML = ''
      $('sessionTitle').textContent = title ?? 'A new day with Rem'
      $('ribbon').classList.remove('show')
      narrate('Rem is getting ready', true)
      rem.emote('smile')
      $('stage').classList.remove('menu-mode')
      link.send({ t: 'start', cwd, resume })
      $('msg').focus()
    },
  }
}
