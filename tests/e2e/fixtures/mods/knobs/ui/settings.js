// E2E fixture page: reports through waifufy.call('report', …), which the test reads off the app's socket.
const report = (o) => waifufy.call('report', o)
waifufy.on('settings', (s) => report({ settings: s }))
waifufy.ready()
report({ page: 'settings' })
waifufy.call('settings').then((s) => report({ settings: s }))
