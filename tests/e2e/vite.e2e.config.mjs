// Vite for E2E runs: the app's own config without HMR and file watching, so a source file saved mid-run
// (work in progress elsewhere) never reloads the page under a running test.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import base from '../../app/vite.config.ts'

const app = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app')

export default { ...base, root: app, server: { ...base.server, hmr: false, watch: null } }
