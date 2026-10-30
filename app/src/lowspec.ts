// Low-spec mode, a phone's own choice (Settings → Phone): no character is drawn at all (no Live2D, no 3D, nothing
// loaded for them), and the chat is a chat room of bubbles instead of the visual novel. Her voice, choices, prompts
// and the composer stay as they are. Kept on the device, not in the computer's settings: each phone picks for itself.

const KEY = 'wc-lowspec'

export function lowSpec() {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

/** Takes effect by reloading the page: the character layer and the chat are built for one mode at start. */
export function setLowSpec(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    return
  }
  location.reload()
}
