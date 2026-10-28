// The side panels around the character: who you are, her affection and the session gauges on the left;
// quests, party and her recent actions on the right (R18, R19, R22).

import type { Limit, ModelChoice, PermissionModeName, SessionEvent, Settings, Stats, Todo } from '../../../link/src/protocol.ts'
import { AFFECTION_LEVELS, affectionProgress } from '../../../link/src/affection.ts'
import { ICONS, type IconName } from '../icons'
import { relPath } from '../paths'

export { relPath }
import { esc, fmtDur, fmtK, resetsIn } from '../ui'

export const MODE_LABELS: Record<PermissionModeName, string> = {
  default: 'Default',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
  auto: 'Auto',
  bypassPermissions: 'Bypass',
}

export const MAX_HEARTS = AFFECTION_LEVELS
/** Rows kept in the actions list; older ones stay in the LOG. */
const ACTIONS_SHOWN = 14
const RIBBON_DETAIL_CHARS = 80
const ACTION_DETAIL_CHARS = 60
const ACTION_TITLE_CHARS = 200
const AGENT_LABEL_CHARS = 40
/** A limit gauge turns amber from this percentage even before the API warns. */
const LIMIT_WARN_PCT = 80
/** resetsAt arrives in epoch seconds from rate-limit events and in ms elsewhere. */
const EPOCH_MS_THRESHOLD = 1e12

const TOOL_ICONS: Record<string, IconName> = {
  Read: 'read', Write: 'edit', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Bash: 'shell', PowerShell: 'shell',
  Grep: 'search', Glob: 'search', WebFetch: 'web', WebSearch: 'web', Skill: 'skill', Agent: 'agent', Task: 'agent',
  TodoWrite: 'todo', TaskCreate: 'todo', TaskUpdate: 'todo', TaskList: 'todo', TaskGet: 'todo',
  AskUserQuestion: 'ask', ExitPlanMode: 'plan', EnterPlanMode: 'plan',
}
export const toolIcon = (name: string) => ICONS[TOOL_ICONS[name] ?? (name.startsWith('mcp__') ? 'plug' : 'tool')]
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/**
 * An action row's two lines: "Tool · target" and a detail. A file tool's target is the file's name and its detail
 * the folder, relative to the project (an absolute C:\Users\…\AppData path says nothing in 310px).
 */
export function actionText(name: string, detail: string, cwd: string): { title: string; sub: string } {
  const label = toolLabel(name)
  const line = oneLine(detail, 400)
  if (FILE_TOOLS.has(name) && line) {
    const path = relPath(line.replace(/\s+\(.*\)$/, ''), cwd)
    const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    const extra = line.match(/\s+\((.*)\)$/)?.[1]
    const dir = cut >= 0 ? path.slice(0, cut + 1) : './'
    return { title: `${label} · ${path.slice(cut + 1)}`, sub: extra ? `${dir} · ${extra}` : dir }
  }
  return { title: label, sub: relPath(line, cwd) }
}

export const isShell = (name: string) => name === 'Bash' || name === 'PowerShell'

export function oneLine(s: string, max = 90) {
  const line = s.trim().split('\n')[0]
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** `mcp__claude_ai_Slack__send_message` → `send_message · claude_ai_Slack`. */
export function toolLabel(name: string) {
  if (!name.startsWith('mcp__')) return name
  const [server, ...rest] = name.slice(5).split('__')
  return rest.length ? `${rest.join('__')} · ${server}` : server
}

/** What the ribbon says she is doing (HTML). */
export function doing(who: string, tool: string, detail: string) {
  const n = esc(who)
  const d = detail ? ` <code>${esc(oneLine(detail, RIBBON_DETAIL_CHARS))}</code>` : ''
  switch (tool) {
    case 'Read': return `${n} is reading${d}…`
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': return `${n} is writing${d}…`
    case 'Bash':
    case 'PowerShell': return `${n} is running${d}…`
    case 'Grep':
    case 'Glob': return `${n} is searching for${d}…`
    case 'WebFetch': return `${n} is visiting${d}…`
    case 'WebSearch': return `${n} is looking up${d}…`
    case 'Skill': return `${n} opens the${d} notebook…`
    case 'Agent':
    case 'Task': return `${n} sends a helper:${d}…`
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet': return `${n} updates the quest log…`
    case 'AskUserQuestion': return `${n} has a question for you…`
    case 'EnterPlanMode': return `${n} starts planning…`
    case 'ExitPlanMode': return `${n} presents a plan…`
  }
  return `${n} uses <b>${esc(toolLabel(tool))}</b>${d}…`
}

export type ToolRecord = {
  id: string
  name: string
  detail: string
  input: string
  sub: boolean
  output?: string
  state: 'run' | 'ok' | 'err' | 'stopped'
}

type AgentMsg = Extract<SessionEvent, { t: 'agent' }>

export type Panels = {
  reset(info: { title: string; cwd: string; cwdShort: string }): void
  identity(s: Settings): void
  stats(s: Stats): void
  models(list: ModelChoice[]): void
  model(id?: string): void
  mode(mode: PermissionModeName): void
  /** Affection points: full hearts for the level, the next one filled as far as its points go. */
  hearts(points: number, change?: 'up' | 'down'): void
  todos(items: Todo[]): void
  agent(m: AgentMsg): void
  /** Adds a tool row, or refreshes it after its state changed. */
  tool(t: ToolRecord): void
  /** Elapsed play time for the "Together" gauge; also ticks the clock. */
  tick(playMs: number): void
  /** The display name of a model id or alias. */
  modelName(id?: string): string
}

/** Context categories from getContextUsage(), grouped into the five colors of the memory bar. */
const CONTEXT_GROUPS: Record<string, string> = {
  system_prompt: 'system', system_tools: 'tools', skills: 'tools', custom_agents: 'tools', deferred_tools: 'tools',
  mcp_tools: 'mcp', mcp_instructions: 'mcp', memory_files: 'memory', messages: 'messages',
}
const GROUP_ORDER = ['system', 'tools', 'mcp', 'memory', 'messages']

export function createPanels(
  left: HTMLElement,
  right: HTMLElement,
  deps: { openModels(): void; cycleMode(): void; openAction(id: string): void },
  /** The phone's top bar (chat/index.ts): the session title, her hearts, and the context, plan and quest pills. */
  bar?: HTMLElement,
): Panels {
  const inBar = (sel: string, text: string) => {
    const el = bar?.querySelector<HTMLElement>(sel)
    if (el) el.textContent = text
  }
  /** A phone pill: a ring that fills like the desktop gauge, its key, the number; amber from LIMIT_WARN_PCT. */
  const pill = (sel: string, key: string, pct?: number) => {
    const el = bar?.querySelector<HTMLElement>(sel)
    if (!el) return
    const p = pct === undefined ? 0 : Math.max(0, Math.min(100, Math.round(pct)))
    el.style.setProperty('--p', `${p}%`)
    el.classList.toggle('warn', p >= LIMIT_WARN_PCT)
    el.innerHTML = `<span class="ring"></span><span class="k">${key}</span>${pct === undefined ? '—' : `${p}%`}`
    el.setAttribute('aria-label', `${key} ${pct === undefined ? 'unknown' : `${p} percent`}`)
  }
  const legend = GROUP_ORDER.map((g) => `<span><b style="background:var(--c-${g})"></b>${g === 'mcp' ? 'MCP' : g}</span>`).join('')
  left.innerHTML = `
    <div class="profile">
      <div class="portrait"></div>
      <div class="who">
        <h1 class="pname"></h1>
        <div class="sub"></div>
        <div class="hearts" data-test="hearts" data-count="0"></div>
        <div class="hint"></div>
      </div>
    </div>
    <div class="section-title">Status</div>
    <div class="stat">
      <div class="ico">${ICONS.context}</div><div class="label">Context</div><div class="val" data-test="stat-context">—</div>
      <div class="bar ctx"><div class="used"></div><div class="buffer"></div></div>
    </div>
    <div class="legend">${legend}<span><b class="hatch"></b>reserve</span></div>
    ${limitRow('five', ICONS.stamina, '5-hour limit')}
    ${limitRow('week', ICONS.week, 'Weekly limit')}
    ${limitRow('opus', ICONS.opus, 'Weekly · Opus')}
    <div class="grid3">
      ${chip('cost', 'Spent')}${chip('turns', 'Turns')}${chip('elapsed', 'Together')}
      <div class="chip" title="Tokens in ↓ · out ↑"><div class="k">Tokens</div><div class="v"><span data-test="stat-tokens-in">—</span> ↓ <span data-test="stat-tokens-out">—</span> ↑</div></div>
      ${chip('cache', 'Cache hit')}${chip('lines', 'Lines')}
      <span hidden data-test="stat-api"></span>
    </div>
    <div class="badges">
      <button class="badge model" type="button" data-test="badge-model" title="Change model (/model)">—</button>
      <button class="badge mode" type="button" data-test="badge-mode" data-mode="default" title="Permission mode (Shift+Tab)">
        Mode · Default</button>
    </div>
    <div class="left-foot">
      <div class="day"><span class="stitle"></span><small class="scwd"></small></div><div class="clock">--:--</div>
    </div>`
  right.innerHTML = `
    <div class="section-title quest-title">Quest<em></em></div>
    <ul class="quests"></ul>
    <div class="section-title">Party</div>
    <div class="party"><span class="leader"></span></div>
    <div class="section-title acts-title"></div>
    <div class="actions"></div>`

  const q = <T extends HTMLElement = HTMLElement>(root: HTMLElement, sel: string) => root.querySelector<T>(sel)!
  const stat = (id: string) => q(left, `[data-test="stat-${id}"]`)
  const modelBtn = q<HTMLButtonElement>(left, '[data-test="badge-model"]')
  const modeBtn = q<HTMLButtonElement>(left, '[data-test="badge-mode"]')
  const actionsEl = q(right, '.actions')
  const partyEl = q(right, '.party')
  modelBtn.onclick = () => deps.openModels()
  modeBtn.onclick = () => deps.cycleMode()
  actionsEl.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-test="action-item"]')
    if (row) deps.openAction(row.dataset.id!)
  })

  let models: ModelChoice[] = []
  let modelId: string | undefined
  /** The project folder, so action rows show paths inside it. */
  let cwd = ''
  const rows = new Map<string, HTMLElement>()
  const seen = new Set<string>()
  const agents = new Map<string, HTMLElement>()

  const modelName = (id?: string) => {
    if (!id) return '—'
    const m = models.find((x) => x.value === id || x.resolved === id)
    return m?.displayName ?? id.replace(/^claude-/, '')
  }

  function limit(id: string, l?: Limit) {
    const row = q(left, `.stat.${id}`)
    if (id === 'opus') row.hidden = !l
    const resets = l?.resetsAt ? resetsIn(l.resetsAt < EPOCH_MS_THRESHOLD ? l.resetsAt * 1000 : l.resetsAt) : ''
    stat(id).textContent = l ? `${Math.round(l.pct)}%${resets ? ` · ${resets.replace(/^resets in /, '')}` : ''}` : '—'
    const bar = q(row, '.bar > i')
    bar.style.width = `${Math.min(100, Math.max(0, l?.pct ?? 0))}%`
    const level = l?.status === 'rejected' ? 'bad' : l?.status === 'allowed_warning' || (l?.pct ?? 0) >= LIMIT_WARN_PCT ? 'warn' : ''
    row.dataset.level = level
    stat(id).dataset.status = l?.status ?? ''
    row.title = l?.status === 'rejected' ? `Limit reached${resets ? ` · ${resets}` : ''}` : resets
  }

  function context(c: Stats['context']) {
    const used = q(left, '.bar.ctx .used')
    const buffer = q(left, '.bar.ctx .buffer')
    if (!c || !c.max) {
      stat('context').textContent = '—'
      used.innerHTML = ''
      buffer.style.width = '0'
      return
    }
    stat('context').textContent = `${fmtK(c.used)} / ${fmtK(c.max)} · ${Math.round((c.used / c.max) * 100)}%`
    const groups = new Map<string, number>()
    let reserve = 0
    for (const p of c.parts) {
      if (p.kind === 'buffer') reserve += p.tokens
      else if (p.kind === 'used') {
        const g = CONTEXT_GROUPS[p.id] ?? 'system'
        groups.set(g, (groups.get(g) ?? 0) + p.tokens)
      }
    }
    used.innerHTML = GROUP_ORDER.map((g) => {
      const v = groups.get(g) ?? 0
      return `<i style="width:${(v / c.max) * 100}%;background:var(--c-${g})" title="${g} · ${fmtK(v)}"></i>`
    }).join('')
    buffer.style.width = `${(reserve / c.max) * 100}%`
    buffer.title = reserve ? `autocompact reserve · ${fmtK(reserve)}` : ''
  }

  function renderRow(t: ToolRecord) {
    let el = rows.get(t.id)
    // A row that already scrolled off stays gone when its result arrives.
    if (!el && seen.has(t.id)) return
    if (!el) {
      seen.add(t.id)
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.dataset.test = 'action-item'
      btn.dataset.id = t.id
      actionsEl.prepend(btn)
      rows.set(t.id, btn)
      el = btn
      while (actionsEl.children.length > ACTIONS_SHOWN) {
        const old = actionsEl.lastElementChild as HTMLElement
        rows.delete(old.dataset.id!)
        old.remove()
      }
    }
    el.className = `act ${t.state}${t.sub ? ' sub' : ''}`
    el.dataset.state = t.state
    el.title = `${toolLabel(t.name)}${t.detail ? ` · ${oneLine(t.detail, ACTION_TITLE_CHARS)}` : ''}\nClick for details`
    const { title, sub } = actionText(t.name, t.detail, cwd)
    const glyph = t.state === 'run' ? ICONS.run : t.state === 'ok' ? ICONS.ok : t.state === 'err' ? ICONS.err : ICONS.stop
    const state = t.state === 'run' ? 'running' : t.state === 'ok' ? 'done' : t.state === 'err' ? 'failed' : 'stopped'
    el.setAttribute('aria-label', `${title}, ${sub}, ${state}`)
    el.innerHTML = `<span class="ai">${toolIcon(t.name)}</span><span class="ab"><span class="an">${esc(title)}</span>`
      + `<span class="ad">${esc(oneLine(sub, ACTION_DETAIL_CHARS))}</span></span><span class="as">${glyph}</span>`
  }

  return {
    reset(info) {
      cwd = info.cwd
      q(left, '.stitle').textContent = info.title
      inBar('.pb-title', info.title)
      pill('.pb-ctx', 'CTX')
      pill('.pb-five', '5H')
      q(left, '.scwd').textContent = info.cwdShort
      q(left, '.day').title = info.cwd
      for (const id of ['cost', 'turns', 'api', 'tokens-in', 'tokens-out', 'cache', 'lines', 'elapsed']) stat(id).textContent = '—'
      context(undefined)
      for (const id of ['five', 'week', 'opus']) limit(id, undefined)
      models = []
      modelId = undefined
      modelBtn.textContent = '—'
      this.mode('default')
      this.todos([])
      rows.clear()
      seen.clear()
      agents.clear()
      actionsEl.innerHTML = ''
      for (const chip of partyEl.querySelectorAll('[data-test="party-chip"]')) chip.remove()
    },
    identity(s) {
      const p = s.profile
      const portrait = q(left, '.portrait')
      const initial = (p.displayName || '?').slice(0, 1).toUpperCase()
      portrait.innerHTML = p.avatar ? `<img alt="" src="${esc(p.avatar)}">` : `<span>${esc(initial)}</span>`
      q(left, '.pname').textContent = p.displayName
      q(left, '.sub').textContent = [p.title, `with ${s.waifu.name}`].filter(Boolean).join(' · ')
      q(left, '.hint').title = `${s.waifu.name}'s affection · praise and headpats warm her up`
      q(right, '.leader').textContent = `✧ ${s.waifu.name}`
      q(right, '.acts-title').textContent = `${s.waifu.name}'s actions`
    },
    stats(s) {
      context(s.context)
      if (s.context?.max) pill('.pb-ctx', 'CTX', (s.context.used / s.context.max) * 100)
      if (s.limits.fiveHour) pill('.pb-five', '5H', s.limits.fiveHour.pct)
      limit('five', s.limits.fiveHour)
      limit('week', s.limits.weekly)
      limit('opus', s.limits.weeklyOpus)
      stat('cost').textContent = `$${s.costUsd.toFixed(2)}`
      stat('turns').textContent = String(s.turns)
      stat('api').textContent = fmtDur(s.apiMs)
      stat('elapsed').parentElement!.title = `API time ${fmtDur(s.apiMs)}`
      stat('tokens-in').textContent = fmtK(s.tokensIn)
      stat('tokens-out').textContent = fmtK(s.tokensOut)
      const read = s.cacheRead + s.cacheWrite + s.tokensIn
      stat('cache').textContent = read ? `${Math.round((s.cacheRead / read) * 100)}%` : '—'
      stat('cache').title = `${fmtK(s.cacheRead)} tokens read from the cache`
      stat('lines').innerHTML = s.linesAdded === undefined && s.linesRemoved === undefined
        ? '—'
        : `<span class="add">+${s.linesAdded ?? 0}</span> <span class="del">−${s.linesRemoved ?? 0}</span>`
      if (s.model) this.model(s.model)
      if (s.mode) this.mode(s.mode)
    },
    models(list) {
      models = list
      modelBtn.textContent = modelName(modelId)
    },
    model(id) {
      modelId = id
      modelBtn.textContent = modelName(id)
      modelBtn.dataset.v = id ?? ''
    },
    mode(mode) {
      modeBtn.dataset.mode = mode
      modeBtn.textContent = `Mode · ${MODE_LABELS[mode] ?? mode}`
    },
    hearts(points, change) {
      const el = q(left, '.hearts')
      const { level, into, need } = affectionProgress(points)
      el.dataset.count = String(level)
      el.dataset.points = String(points)
      el.title = need ? `Affection ${level}/${MAX_HEARTS} · ${into}/${need} toward the next heart` : `Affection ${level}/${MAX_HEARTS} · full`
      const heart = (k: number) => {
        const cls = [k < level ? 'on' : '', k === level && into ? 'part' : '', change === 'up' && k === level - 1 ? 'pop' : '', change === 'down' && k === level ? 'drop' : '']
        const fill = k === level && into ? ` style="--fill:${Math.round((into / need) * 100)}%"` : ''
        return `<span class="${cls.filter(Boolean).join(' ')}"${fill}>♥</span>`
      }
      el.innerHTML = Array.from({ length: MAX_HEARTS }, (_, k) => heart(k)).join('')
      q(left, '.hint').textContent = `${level} / ${MAX_HEARTS}`
      const hearts = bar?.querySelector<HTMLElement>('.pb-hearts')
      if (hearts) {
        hearts.innerHTML = Array.from({ length: MAX_HEARTS }, (_, k) => `<span class="${k < level ? 'on' : ''}">♥</span>`).join('')
        hearts.setAttribute('aria-label', `Affection ${level} of ${MAX_HEARTS}`)
      }
    },
    todos(items) {
      const qb = bar?.querySelector<HTMLElement>('.pb-quests')
      if (qb) qb.innerHTML = `<span class="gem">◆</span><span class="k">QUEST</span>${items.length ? `${items.filter((t) => t.status === 'completed').length}/${items.length}` : '0'}`
      q(right, '.quest-title em').textContent = items.length ? `${items.filter((t) => t.status === 'completed').length} / ${items.length}` : ''
      q(right, '.quests').innerHTML = items.length
        ? items.map((t) => `<li class="${t.status}" data-test="quest-item" data-status="${t.status}">${esc(t.content)}</li>`).join('')
        : '<li class="empty">No quests yet</li>'
    },
    agent(m) {
      let chip = agents.get(m.id)
      if (!chip) {
        chip = document.createElement('span')
        chip.dataset.test = 'party-chip'
        chip.dataset.id = m.id
        partyEl.append(chip)
        agents.set(m.id, chip)
      }
      chip.className = `party-chip ${m.status}`
      chip.dataset.status = m.status
      chip.title = m.description
      chip.textContent = `👥 ${oneLine(m.description, AGENT_LABEL_CHARS) || 'helper'}`
    },
    tool: renderRow,
    tick(playMs) {
      const d = new Date()
      q(left, '.clock').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      stat('elapsed').textContent = fmtDur(playMs)
    },
    modelName,
  }
}

function limitRow(id: string, icon: string, label: string) {
  return `<div class="stat ${id}"><div class="ico">${icon}</div><div class="label">${label}</div>`
    + `<div class="val" data-test="stat-${id}">—</div><div class="bar"><i></i></div></div>`
}

function chip(id: string, label: string) {
  return `<div class="chip"><div class="k">${label}</div><div class="v" data-test="stat-${id}">—</div></div>`
}
