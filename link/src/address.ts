import type { Settings } from './protocol.ts'

// How she addresses the user. Pure (no Node imports), so the app shares it with the link: the persona, the
// title greeting, the wizard and Settings' preview all say the same thing.

/** Forms of address that are titles, not names: an honorific after them reads oddly ("Master-kun"). */
const TITLES = /^(master|goshujin[- ]?sama|ojou[- ]?sama|senpai|sensei|boss|captain|commander)$/i

/** "Yodha" + kun → "Yodha-kun". A title like "Master" stays as it is. */
export function addressOf(s: Pick<Settings, 'profile'>) {
  const p = s.profile
  const name = (p.callMe || p.displayName || 'Master').trim()
  const h = p.honorific === 'custom' ? p.customHonorific.trim() : p.honorific === 'none' ? '' : p.honorific
  return h && !TITLES.test(name) ? `${name}-${h.replace(/^-/, '')}` : name
}
