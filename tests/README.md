# Tests

Everything here runs without spending plan budget, except `e2e/real.mjs`, which you run by hand.

| What | Command | Needs |
|---|---|---|
| Mock session unit check | `node tests/unit/mock.test.mjs` | Node 24 |
| E2E suite (mock session) | `node tests/e2e/run.mjs` | a dev-config debug build (below), or Chrome/Edge for `WC_E2E_TARGET=browser` |
| Part of the suite | `node tests/e2e/run.mjs chat R14` | files whose name contains `chat`, plus every test tagged R14 |
| Strict run | `node tests/e2e/run.mjs --strict` | also fails when a requirement is skipped or has no test |
| Real SDK smoke test | `node tests/e2e/real.mjs` | a Claude login; sends at most 3 short Haiku messages |

**The build.** `cargo build --manifest-path app/src-tauri/Cargo.toml` makes
`app/src-tauri/target/debug/waifufy-code.exe` with the dev config, which loads the page from Vite on 1430 (the
driver starts it), so every run tests the current frontend. `npm run tauri build -- --debug` embeds a `dist`
snapshot instead; the driver warns when the page comes from `tauri.localhost`.

`run.mjs` prints a PASS/FAIL table by requirement (R1–R49 from `docs/V1.md`) and exits non-zero on any
failure. It then lists every requirement that is only skipped or has no test as **Unverified**; with `--strict`
those fail the run too. A test that times out may still be driving the app, so the next test gets a freshly
launched one (and the file's `setup` runs again). Screenshots of failures, per-tab settings screenshots, dark-mode screenshots, the app/sidecar/Vite
logs and `results.json` go to `tests/e2e/out/` (git-ignored).

## How it works

- **The mock session.** `link/src/mock.ts` exports `createMockSession: SessionFactory`. With `WC_MOCK=1` the
  sidecar uses it instead of the Agent SDK, so no Claude process starts. It streams the same events as the real
  session, at a similar pace (a text delta every ~30 ms), and picks a scenario by keyword in what you type:

  | Type | You get |
  |---|---|
  | `emotions` | three paragraphs with inline tags, some cut across deltas on purpose |
  | `tools` | TaskCreate quests, Read, Grep, a subagent (Agent → running → done), Edit, Bash, a 26k Read truncated at 20k |
  | `permission` | an Edit permission with a diff; continues after allow/always/feedback, stops on deny |
  | `fetch` | a WebFetch permission whose detail is the URL |
  | `danger` / `reset` | `git reset --hard HEAD~1` with `danger: true`, `defaultToNo: true` |
  | `question` | AskUserQuestion with a single-choice and a multi-select question; a permission answer (the app's Esc) dismisses it |
  | `plan` | ExitPlanMode; `auto` switches to acceptEdits (stats + a notice) |
  | `push` | a successful `git push` |
  | `long` | a 10-item list, a code block, a table, a 320+ character paragraph and a single 320+ character sentence |
  | `slow` | three 7 s build steps with a line after each: a turn longer than the chat's 20 s success threshold |
  | `markdown` | bold, a link and a 3-item list (none of it collapses) |
  | `error` | an auth error (`Not logged in · Please run /login`) and `turn_end ok:false` (no repeated error, no cost) |
  | `api error` | an API error after a short line |
  | `crash` | a process error, then `ended: crashed` |
  | `/context`, `/cost`, `/compact`, `/model x`, `/clear` | the CLI's local command output, or a new session id and reset stats |
  | anything else | a short in-character echo that mentions pasted images and `@paths` |

  Every turn ends with `turn_end` and cumulative `stats` (cost, turns, tokens, context, plan limits).
  `interrupt()` stops a turn (`turn_end interrupted:true`) and cancels an open question. `!cmd` answers with fake
  output (`git status`, `ls`, `echo`, `exit N`). `WC_MOCK_TICK_MS` changes the pace (the unit check uses 1).

  The mock is also handy for UI work without a budget: `WC_MOCK=1 npm run dev`.

- **The driver** (`e2e/driver.mjs`) starts Vite on 1430 when it isn't running (without HMR, so a file saved
  mid-run never reloads the page under a test), then the app with a fresh `WC_DATA_DIR` seeded with an onboarded
  `settings.json` (the real costume folder, profile "Yodha", light theme, fast text) and a fresh WebView2 profile.
  It talks to the page over the Chrome DevTools Protocol with Node's built-in WebSocket, kills the whole
  process tree (`taskkill /T /F`) at the end, and deletes the data dir (with its browser profile) and the temp
  projects, so runs don't pile up in `%TEMP%`.
- **The recorder.** Before the app's own scripts run, the driver installs a prelude that records every server
  message, every client message, every `#chara` data-attribute change and every `dialogue-text` change, each
  with a timestamp. Tests assert on that timeline ("`[think]` fired when the typewriter had just typed `stale`")
  instead of sampling the screen. It can also **inject** fake server messages (logged-out auth, research
  progress and results), and it **blocks** `login`, `research` and `reveal`, so a test never opens a console,
  spends budget on research, or opens Explorer.
- **Helpers:** `eval`, `waitFor`, `click` (real mouse events at the element's center, failing when something
  covers it or the element itself is not hit-testable, such as `pointer-events: none`), `mouse.drag` (headpats), `type` (`Input.insertText`), `typeKeys` and `key('Shift+Tab')`,
  `keyDown('Control')`/`keyUp`, `pasteImage` (a generated PNG as a clipboard paste or a drop), `screenshot`,
  `capture(clip)` (a PNG of part of the page), `sidecarPids()` (the shell's node.exe children, for the R24 restart test),
  `waitEvent`/`waitSent`, `inject`, `updateSettings`, `go(screen, params)`. Flows like New Game (the OS folder
  picker can't be driven, so it calls `router.go('chat', { cwd })` like the title screen does after picking),
  `say`, `readAll`, `setField` and `makeProject` (a temp git repo with a `.gitignore`) are in `e2e/lib.mjs`.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `WC_E2E_TARGET` | `app` | `app`: the Tauri debug build. `browser`: Vite + the sidecar + headless Chrome/Edge, with `?link=&token=` in the URL (no Tauri, so no folder picker and no quitting) |
| `WC_E2E_EXE` | `app/src-tauri/target/debug/waifufy-code.exe` | the build to test |
| `WC_CDP_PORT` | `9333` | the DevTools port. The shell turns it into the WebView2 switches (plus tauri.conf.json's `additionalBrowserArgs`) and a WebView2 profile under `WC_DATA_DIR` |
| `WC_E2E_MODELS` | the first existing models folder from `settings.ts` | costume folder for the seeded settings |
| `WC_E2E_HEADED` | unset | `1` shows the browser in `browser` mode |
| `WC_E2E_BROWSER` | Chrome, then Edge | browser for `browser` mode |

If another tool already uses port 9333 (an editor's browser, another harness), set `WC_CDP_PORT=9341`.

## Writing a scenario

A file in `e2e/scenarios/` default-exports `{ name, launch?, setup?, tests: [{ r, name, timeout?, run(ctx) }] }`.
`launch` goes to `driver.launch` (`{ wizard: true }` for a first run, `{ settings: {...} }` to patch the seed, both
for a first run with given settings); make it a function when it creates something, such as a `tempDir()`, so that
happens only when the file runs;
each file gets its own app and data dir. `ctx` is `{ app, project, file, log }`; tests in a file share it, so a
test may build on the one before, but should still pass when run alone with `run.mjs R<id>`. Use only `data-test`
hooks and `window.__wc`, scope `set-*` hooks to the active screen (the wizard and settings share them), and
throw `skip(reason)` for what can't be checked in this environment.

## Hooks beyond docs/V1.md

The suite also uses these, falling back to text matching when they are missing: `wizard-login`,
`dialogue-action[data-v]` (Log in, Restart session), `research-cancel`, `preset-apply`, `preset-handwritten`,
`set-appearance.modelsDir-browse`, `#chara[data-focus]`, `#chara[data-head]`, and `idle-*` values of `data-gesture`.

## What can't be checked here

- **Cursor tracking (R32)** reads `#chara[data-focus="x,y"]` when the character sets it. Otherwise it compares
  pictures of her head with the cursor at the left and right edge against two pictures at the same spot (breathing
  and blinking), so it needs a Live2D model and is less exact.
- **Headpats and taps** find her head by probing the canvas unless `#chara` carries `data-head="x,y,r"` in stage
  pixels.
- **Idle variations (R31)** are seen through `data-gesture` values starting with `idle` (motions.ts `IDLE_HOLDS`
  names), so the character must report them there.
- **The sidecar restart (R24)** needs the Tauri shell, so it is skipped with `WC_E2E_TARGET=browser`.
- **R47 (installer) and R49 (`npm run dev`)** are checked by building, not by this suite.
- **The real research** (R40) needs budget: the suite drives the form, progress, cancel, result, Apply and save
  with injected messages instead.

## real.mjs

Runs the real Agent SDK (no `WC_MOCK`) in a temp project, refuses to send anything unless the session reports a
Haiku model, and sends exactly three messages: a one-sentence greeting (persona and emotion tags, no tag in the
dialogue), a Glob of the folder (a tool call with its result in the tool log; a permission prompt is allowed only
for Glob, Grep, Read or LS, and anything else is denied and reported as a failure), and `/context` (free). After the third, every further `say` is blocked. WARN lines are soft checks (the
model may skip a tag).
