// Dev helper: opens a chat on the mock session, types a slash command and screenshots each step.
//   WC_E2E_TARGET=browser node tests/e2e/dev/peek.mjs /mcp [key …]   e.g. /mcp Enter ArrowDown Enter
import { launch, stopVite } from '../driver.mjs'
import { focusInput, makeProject, newGame, removeTempDirs, sleep } from '../lib.mjs'

const [command, ...keys] = process.argv.slice(2)
const app = await launch({})
try {
  await newGame(app, makeProject('peek'))
  await focusInput(app)
  await app.type(command)
  await app.key('Enter')
  await sleep(1200)
  console.log(await app.screenshot('peek/0'))
  let i = 0
  for (const k of keys) {
    await app.key(k)
    await sleep(700)
    console.log(await app.screenshot(`peek/${++i}`))
  }
} finally {
  await app.close?.()
  stopVite()
  removeTempDirs()
}
