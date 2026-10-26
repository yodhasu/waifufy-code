// Android's back button (the gesture or the key) on the phone app. Without a listener Tauri closes the app at once;
// with one, back steps through the app like Esc does: the confirm dialog, then the screen (its popups and menus
// first), then the previous screen, and only quits from the title, on a second press.

import { exit, onBackButtonPress } from '@tauri-apps/api/app'
import type { Screen, ScreenName } from './contracts'

/** A second back within this long quits from the title. */
const EXIT_WINDOW_MS = 2000

export function installBackButton(o: {
  /** Answers an open confirm dialog with "no"; false when none is open. */
  closeConfirm(): boolean
  current(): ScreenName
  screen(): Screen
  back(): void
  toast(text: string): void
}) {
  let armedAt = -Infinity
  return onBackButtonPress(() => {
    if (o.closeConfirm()) return
    const s = o.screen()
    if (s.onBack?.() ?? s.onEscape?.()) return
    if (o.current() !== 'title') return o.back()
    if (performance.now() - armedAt < EXIT_WINDOW_MS) return void exit(0)
    armedAt = performance.now()
    o.toast('Press back again to exit')
  })
}
