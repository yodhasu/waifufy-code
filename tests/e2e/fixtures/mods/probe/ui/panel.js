// E2E fixture panel: every observation goes out as waifufy.call('report', …), which the test reads off the
// app's socket (the frame is cross-origin to the page, so the driver can't read its DOM).
const report = (o) => waifufy.call('report', o)
let parentDoc
try {
  parentDoc = typeof window.parent.document.title
} catch {
  parentDoc = 'threw'
}
addEventListener('message', (e) => {
  if (e.source === window.parent && e.data?.kind === 'theme') report({ accent: e.data.vars?.['--accent'] ?? null })
})
waifufy.on('tick', (p) => report({ tick: p }))
waifufy.on('reconnected', () => report({ reconnected: true }))
waifufy.ready()
report({ parentDoc })
waifufy.call('echo', { n: 1 }).then((v) => report({ echo: v }), (e) => report({ echoError: e.message }))
waifufy.call('emit', { n: 2 })
