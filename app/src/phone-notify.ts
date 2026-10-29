// Her messages as phone notifications (v0.7.2). The Android app (MainActivity.kt, PhoneLink.kt) exposes
// `window.WaifufyAndroid`: joining a session keeps the connection open in the background, her casual lines arrive
// as one conversation notification while the app isn't in front, and an inline Reply comes back here. Anywhere
// else (the desktop app, a browser) there is no bridge and every call does nothing.

type Bridge = { connected(name: string): void; disconnected(): void; notify(name: string, text: string): void; clear(): void }
type Win = { WaifufyAndroid?: Bridge; __waifufyReply?: (text: string) => void }

const bridge = () => (window as unknown as Win).WaifufyAndroid

/** Calls into the app never break the page: a failing bridge only costs the notification. */
function call(fn: (b: Bridge) => void) {
  const b = bridge()
  if (!b) return
  try {
    fn(b)
  } catch (e) {
    console.warn('[phone] bridge:', e)
  }
}

export const phoneNotify = {
  available: () => !!bridge(),
  /** Joined a session: notifications allowed (asked once), and the connection kept open in the background. */
  connected: (name: string) => call((b) => b.connected(name)),
  disconnected: () => call((b) => b.disconnected()),
  /** Only while the app isn't in front: in front, she's on screen anyway. */
  her: (name: string, text: string) => document.visibilityState === 'hidden' && call((b) => b.notify(name, text)),
  clear: () => call((b) => b.clear()),
  /** Where a Reply typed in the notification goes. */
  onReply: (fn: (text: string) => void) => void ((window as unknown as Win).__waifufyReply = fn),
}
