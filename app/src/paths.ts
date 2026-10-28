// Paths as the chat shows them: inside the project, relative to it. No imports, so tests/unit can load it as is.

/**
 * `text` with the project folder taken off every path that starts with it (either slash, any case on Windows):
 * `C:\\Work\\app\\src\\a.ts` → `src\\a.ts`, `cd /home/u/app && ls` → `cd . && ls`. Only whole path starts
 * match, so `/src/wc-old` stays as it is when the project is `/src/wc`.
 */
export function relPath(text: string, cwd: string) {
  const base = cwd.replace(/[\\/]+$/, '')
  if (!base) return text
  const pattern = base.split(/[\\/]/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]')
  const re = new RegExp(`(^|[\\s"'=(:])${pattern}(?:[\\\\/]+|(?=[\\s"')]|$))`, 'gi')
  return text.replace(re, (whole, lead: string) => `${lead}${/[\\/]$/.test(whole) ? '' : '.'}`) || '.'
}
