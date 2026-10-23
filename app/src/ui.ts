// Small DOM and formatting helpers shared by the menu and the chat.

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function toast(text: string, ms = 2600) {
  const t = $('toast')
  t.textContent = text
  t.classList.add('show')
  clearTimeout(Number(t.dataset.timer))
  t.dataset.timer = String(setTimeout(() => t.classList.remove('show'), ms))
}

function inline(s: string) {
  return esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/^#{1,6}\s+(.*)$/gm, '<b>$1</b>')
    .replace(/^\s*[-*]\s+/gm, '• ')
}

/** Just enough Markdown for dialogue: code fences, inline code, bold, headings and bullets. */
export function renderMarkdown(src: string) {
  return src
    .split(/(```[\s\S]*?(?:```|$))/g)
    .map((part) => {
      if (!part.startsWith('```')) return inline(part).replace(/\n/g, '<br>')
      const body = part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')
      return `<pre><code>${esc(body)}</code></pre>`
    })
    .join('')
}

/** What the typewriter types before the formatted version is swapped in. */
export function plainText(src: string) {
  return src
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
}

export const fmtK = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)

export function fmtDur(ms: number) {
  const m = Math.floor(ms / 60000)
  return m < 60 ? `${m}m ${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function relTime(ms: number) {
  const s = (Date.now() - ms) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`
  return new Date(ms).toLocaleDateString()
}

/** "resets in 2h 14m" */
export function resetsIn(at?: number) {
  if (!at) return ''
  const ms = at - Date.now()
  if (ms <= 0) return 'resetting'
  const h = Math.floor(ms / 3600000)
  return h >= 48 ? `resets in ${Math.round(h / 24)}d` : `resets in ${h}h ${Math.floor(ms / 60000) % 60}m`
}
