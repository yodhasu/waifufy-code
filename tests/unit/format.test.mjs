// The composer's live formatting: what Enter does around code fences, and the highlight layer's marks.
// Run: node tests/unit/format.test.mjs
import { highlight, planEnter, hasFence } from '../../app/src/chat/format.ts'

let failures = 0
const test = (name, fn) => {
  try {
    fn()
    console.log(`PASS  ${name}`)
  } catch (e) {
    failures++
    console.log(`FAIL  ${name}\n      ${e.message}`)
  }
}
const eq = (a, b) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
}

test('Enter on plain text sends', () => eq(planEnter('hello', 5), { kind: 'send' }))
test('Enter after an opening fence closes the block', () => eq(planEnter('x\n```ts', 7), { kind: 'close', text: '\n\n```', caret: 1 }))
test('Enter after an opening fence that is already closed is a newline', () => eq(planEnter('```\na\n```', 3), { kind: 'newline' }))
test('Enter inside a block is a newline', () => eq(planEnter('```\nabc\n```', 7), { kind: 'newline' }))
test('Enter on the closing fence sends', () => eq(planEnter('```\nabc\n```', 11), { kind: 'send' }))
test('Enter after a closed block sends', () => eq(planEnter('```\na\n```\nok', 12), { kind: 'send' }))
test('Enter in the middle of a fence line is a newline, not a close', () => eq(planEnter('```ts', 2), { kind: 'newline' }))

test('fences and code lines are marked', () => {
  const h = highlight('hi\n```js\nlet a = 1 < 2\n```')
  eq(h, 'hi\n<span class="hl-fence">```js</span>\n<span class="hl-code">let a = 1 &lt; 2</span>\n<span class="hl-fence">```</span>')
})
test('inline code and bold are marked, text escaped', () => {
  eq(highlight('a `b<c>` **d** e'), 'a <span class="hl-icode">`b&lt;c&gt;`</span> <span class="hl-bold">**d**</span> e')
})
test('bold inside inline code stays code', () => eq(highlight('`**x**`'), '<span class="hl-icode">`**x**`</span>'))
test('a trailing newline keeps the layer as tall as the box', () => eq(highlight('a\n'), 'a\n '))
test('hasFence', () => eq([hasFence('a ``` b'), hasFence('a\n  ```'), hasFence('`x`')], [false, true, false]))

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
