// R37: with no model in the models folder, a placeholder sprite stands in and the chat still works.
import { assert, eq, fastText, newGame, readAll, say, T, tempDir, turnEnd } from '../lib.mjs'

const MODEL_LOAD_MS = 30_000

export default {
  name: 'Placeholder sprite without models',
  // A function, so the empty folder is only made when this file runs.
  launch: () => ({ settings: { appearance: { modelsDir: tempDir('wc-e2e-no-models-') } } }),
  tests: [
    {
      r: 'R37',
      name: 'an empty models folder shows the placeholder',
      async run({ app }) {
        const model = await app.waitFor(() => document.getElementById('chara').dataset.model, { timeout: MODEL_LOAD_MS, label: '#chara[data-model]' })
        eq(model, 'placeholder', 'data-model')
      },
    },
    {
      r: 'R37',
      name: 'the chat works fully with the placeholder',
      async run({ app, project }) {
        await newGame(app, project)
        await fastText(app)
        const m = await say(app, 'show me your emotions')
        await turnEnd(app, m)
        await readAll(app)
        assert((await app.text(T('dialogue-text'))).includes('leave it to me'), 'her reply reaches the dialogue')
        const emotions = (await app.attrLog(m, 'data-emotion')).map((a) => a.value)
        assert(emotions.length > 0, 'the placeholder still takes emotions')
        await app.click(T('qm-costume'))
        await app.waitVisible(T('costume-picker'))
        eq(await app.count(T('costume-item')), 0, 'no costumes to pick')
        await app.key('Escape')
      },
    },
  ],
}
