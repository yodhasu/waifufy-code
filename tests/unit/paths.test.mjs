// relPath: action rows, the ribbon, the LOG and diffs name paths relative to the project. Run: node tests/unit/paths.test.mjs
import { relPath } from '../../app/src/paths.ts'

const cases = [
  ['/tmp/wc-proj/demo/src/a.ts', '/tmp/wc-proj/demo', 'src/a.ts', 'a file inside the project'],
  ['/src/wc-old/a.ts', '/src/wc', '/src/wc-old/a.ts', 'a sibling folder whose name starts the same stays whole'],
  ['cd /home/u/app && npm test', '/home/u/app', 'cd . && npm test', 'the project itself inside a command'],
  ['C:\\Users\\me\\Work\\app\\src\\a.ts', 'C:\\Users\\me\\Work\\app', 'src\\a.ts', 'Windows separators are kept'],
  ['c:\\users\\me\\work\\app\\x.ts', 'C:\\Users\\me\\Work\\app\\', 'x.ts', 'any case on Windows, a trailing slash on the folder'],
  ['/tmp/wc-proj/demo', '/tmp/wc-proj/demo', '.', 'the folder alone'],
  ['npm test', '/x', 'npm test', 'nothing to shorten'],
  ['grep foo /x/y', '/x', 'grep foo y', 'a path after other words'],
  ['/a/b', '', '/a/b', 'no project folder'],
]
let failures = 0
for (const [text, cwd, want, name] of cases) {
  const got = relPath(text, cwd)
  if (got === want) console.log(`PASS  ${name}`)
  else (failures++, console.log(`FAIL  ${name}: ${JSON.stringify(got)}, want ${JSON.stringify(want)}`))
}
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
