// A long-lived Vite shared by several E2E runs at once (parallel work): like vite.e2e.config.mjs it never
// hot-reloads a page under a running test, but it does watch files, so each new page load gets the current code.
//   node app/node_modules/vite/bin/vite.js --config tests/e2e/dev/vite.shared.config.mjs --port 1430 --strictPort
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import base from '../../../app/vite.config.ts'

const app = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'app')

export default { ...base, root: app, server: { ...base.server, hmr: false } }
