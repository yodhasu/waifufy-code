// The phone's pairing: which desktop to reach and its token, from the QR code on the desktop's Settings → Phone
// (link/src/remote.ts pairUrl). Shown before anything else boots, since every screen needs the link.

import './pair.css'

export type Pairing = { hosts: string[]; port: number; token: string }

const KEY = 'wc-pairing'
/** The pairing link this phone was paired with (its code, not its own token): the way back in without the computer. */
const CODE_KEY = 'wc-pair-code'

/** `waifufy-code://pair?h=192.168.1.5,100.64.0.2&p=47920&t=…` → a pairing, or undefined if it isn't one. */
export function parsePairing(text: string): Pairing | undefined {
  const m = text.trim().match(/^waifufy-code:\/\/pair\?(.+)$/)
  if (!m) return undefined
  const q = new URLSearchParams(m[1])
  const hosts = (q.get('h') ?? '').split(',').map((h) => h.trim()).filter(Boolean)
  const port = Number(q.get('p'))
  const token = q.get('t') ?? ''
  return hosts.length && port > 0 && token ? { hosts, port, token } : undefined
}

export function savedPairing(): Pairing | undefined {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Pairing | null
    return p?.hosts?.length && p.port && p.token ? p : undefined
  } catch {
    return undefined
  }
}

/** A pairing link (scanned, pasted) is also kept as the emergency key; a pairing object is the phone's own. */
export function savePairing(p: Pairing | string) {
  const v = typeof p === 'string' ? parsePairing(p) : p
  if (!v) return
  try {
    localStorage.setItem(KEY, JSON.stringify(v))
    if (typeof p === 'string') localStorage.setItem(CODE_KEY, JSON.stringify(v))
  } catch {
    // Private storage off: pairing again next launch is the only cost.
  }
}

export function savedCode(): Pairing | undefined {
  try {
    const p = JSON.parse(localStorage.getItem(CODE_KEY) ?? 'null') as Pairing | null
    return p?.hosts?.length && p.port && p.token ? p : undefined
  } catch {
    return undefined
  }
}

export function clearCode() {
  try {
    localStorage.removeItem(CODE_KEY)
  } catch {
    // Nothing stored, then.
  }
}

export function clearPairing() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Nothing stored, then.
  }
}

const inTauri = () => '__TAURI_INTERNALS__' in window

/**
 * While a paired phone can't reach its computer at launch: says so and keeps the pairing (link.ts keeps trying every
 * address). "Pair again" is there for a computer that really changed; nothing forces it.
 */
export function waitForComputer(hosts: string[], repair: () => void) {
  const stage = document.getElementById('stage') ?? document.body
  const el = document.createElement('div')
  el.className = 'pair'
  el.dataset.test = 'pair-waiting'
  el.innerHTML = `
    <div class="pair-box panel">
      <h2>Waiting for your computer…</h2>
      <p class="pair-note">Trying <b data-hosts></b>. This phone stays paired and keeps trying on its own: it connects as soon as
        Waifufy Code on your computer is reachable, over your Wi-Fi or Tailscale.</p>
      <p class="pair-note">Is Waifufy Code running there (it stays in the tray when you close its window), with phone access on?</p>
      <p class="pair-error" data-test="pair-waiting-tries"></p>
      <button class="btn" type="button" data-act="repair" data-test="pair-again">Pair again</button>
    </div>`
  el.querySelector<HTMLElement>('[data-hosts]')!.textContent = hosts.join(', ')
  el.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-act="repair"]')) repair()
  })
  stage.append(el)
  return {
    update(tries: number) {
      el.querySelector<HTMLElement>('[data-test="pair-waiting-tries"]')!.textContent = `Still trying… (${tries})`
    },
    close: () => el.remove(),
  }
}

/** Thrown when the person cancels a scan: not an error to show. */
class Cancelled extends Error {}

/**
 * Scans a QR code with the phone's camera (the barcode-scanner plugin, mobile only). Windowed: the camera runs
 * behind the page, which turns transparent but for a frame and a Cancel button (`html.scanning`, pair.css).
 */
async function scanCode(): Promise<string> {
  const scanner = await import('@tauri-apps/plugin-barcode-scanner')
  if ((await scanner.checkPermissions()) !== 'granted' && (await scanner.requestPermissions()) !== 'granted') {
    throw new Error('Camera permission is off. Allow it in Android settings, or paste the pairing link instead.')
  }
  const root = document.documentElement
  root.classList.add('scanning')
  try {
    return (await scanner.scan({ formats: [scanner.Format.QRCode], windowed: true })).content
  } catch (e) {
    if (!root.classList.contains('scanning')) throw new Cancelled()
    throw e
  } finally {
    root.classList.remove('scanning')
  }
}

/** Stops a scan in progress; its scanCode() then rejects with Cancelled. */
async function cancelScan() {
  if (!document.documentElement.classList.contains('scanning')) return false
  document.documentElement.classList.remove('scanning')
  const scanner = await import('@tauri-apps/plugin-barcode-scanner')
  await scanner.cancel().catch(() => {})
  return true
}

/** Shows the pairing screen until a valid pairing is scanned or pasted; `error` explains why it is back. */
export function pair(error?: string): Promise<Pairing> {
  const stage = document.getElementById('stage') ?? document.body
  const el = document.createElement('div')
  el.className = 'pair'
  el.dataset.test = 'pair'
  el.innerHTML = `
    <div class="pair-box panel">
      <h2>Pair with your computer</h2>
      <ol>
        <li>On your computer, open <b>Waifufy Code → Settings → Phone</b> and turn on <b>phone access</b>.</li>
        <li>Scan the code it shows, or paste the pairing link.</li>
      </ol>
      <button class="btn primary" type="button" data-act="scan" data-test="pair-scan">Scan the QR code</button>
      <label class="pair-or">or paste the pairing link</label>
      <textarea class="field" rows="3" spellcheck="false" placeholder="waifufy-code://pair?…" data-test="pair-link"></textarea>
      <button class="btn" type="button" data-act="connect" data-test="pair-connect">Connect</button>
      <p class="pair-error" data-test="pair-error"></p>
      <p class="pair-note">Your phone talks to your computer directly, over your Wi-Fi or Tailscale. Claude Code keeps running on the computer.
        Saved the pairing link somewhere (notes, a password manager)? Pasting it here works without your computer's screen.</p>
    </div>
    <div class="pair-scan" aria-live="polite">
      <p>Point the camera at the QR code on your computer</p>
      <div class="pair-frame"></div>
      <button class="btn" type="button" data-act="cancel" data-test="pair-cancel">Cancel</button>
    </div>`
  stage.append(el)
  const err = el.querySelector<HTMLElement>('.pair-error')!
  const link = el.querySelector<HTMLTextAreaElement>('textarea')!
  const say = (text: string) => (err.textContent = text)
  if (error) say(error)
  // Back cancels a scan; otherwise, with nothing behind this screen, it closes the app as usual.
  const back = inTauri()
    ? import('@tauri-apps/api/app').then(({ exit, onBackButtonPress }) =>
        onBackButtonPress(() => void cancelScan().then((was) => void (was || exit(0)))),
      ).catch(() => undefined)
    : Promise.resolve(undefined)
  return new Promise((resolve) => {
    const done = (text: string) => {
      const p = parsePairing(text)
      if (!p) return say('That isn\'t a Waifufy Code pairing link. It starts with waifufy-code://pair')
      savePairing(text)
      el.remove()
      void back.then((l) => l?.unregister())
      resolve(p)
    }
    el.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act
      if (act === 'connect') return done(link.value)
      if (act === 'cancel') return void cancelScan()
      if (act === 'scan') {
        say('')
        void scanCode().then(done, (x: unknown) => {
          if (!(x instanceof Cancelled)) say(x instanceof Error ? x.message : `The scanner didn't open: ${x}`)
        })
      }
    })
  })
}
