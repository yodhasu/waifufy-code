// Panel-side half of the mod bridge. Loaded by a sandboxed iframe (opaque origin), so every message goes to
// window.parent with targetOrigin '*'; only replies from the parent with wc === 1 are believed.
;(() => {
  const pending = new Map() // seq -> { resolve, reject }
  const handlers = new Map() // event type -> Set<fn>
  let seq = 0

  const post = (msg) => window.parent.postMessage({ wc: 1, ...msg }, '*')
  const request = (kind, fields) =>
    new Promise((resolve, reject) => {
      const n = ++seq
      pending.set(n, { resolve, reject })
      post({ kind, seq: n, ...fields })
    })

  window.addEventListener('message', (e) => {
    const d = e.data
    if (e.source !== window.parent || !d || d.wc !== 1) return
    if (d.kind === 'reply') {
      const p = pending.get(d.seq)
      if (!p) return
      pending.delete(d.seq)
      d.ok ? p.resolve(d.value) : p.reject(new Error(d.error ?? 'failed'))
    } else if (d.kind === 'event') {
      for (const fn of handlers.get(d.type) ?? []) fn(d.payload)
    } else if (d.kind === 'theme') {
      for (const [k, v] of Object.entries(d.vars ?? {})) document.documentElement.style.setProperty(k, v)
      Object.assign(window.waifufy.theme, d.vars)
    }
  })

  window.waifufy = {
    /** Call a method on the mod's backend. */
    call: (method, params) => request('call', { method, params }),
    /** Ask the app for a capability (e.g. opening a file). */
    app: (capability, params) => request('app', { capability, params }),
    /** Listen for events pushed by the backend or app; returns an unsubscribe function. */
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set())
      handlers.get(type).add(fn)
      return () => handlers.get(type)?.delete(fn)
    },
    /** Tell the app how tall the panel wants to be, in px. */
    resize: (height) => post({ kind: 'resize', params: height }),
    /** Say the panel has loaded; the app answers with the theme. */
    ready: () => post({ kind: 'ready' }),
    /** Current theme CSS variables, kept up to date. */
    theme: {},
  }
})()
