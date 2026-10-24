# V0.5 panel builder brief (shared by every builder)

Read `docs/V0.5.md` (the plan and the panel contract) first. Then read `app/src/chat/menu.ts`,
`app/src/chat/control.ts`, `app/src/chat/commands/index.ts` and `app/src/chat/commands/mcp.ts`. `mcp.ts` is the
finished reference panel: copy its style.

## What you own

- **Your command files:** only the ones your task names (under `app/src/chat/commands/`, already stubbed and
  registered), plus one new E2E scenario file `tests/e2e/scenarios/<NN>-<name>.mjs`.
- **Never edit** `app/src/chat/index.ts`, `input.ts`, `asks.ts`, `dialogue.ts`, `link/src/session.ts`,
  `link/src/protocol.ts`, `link/src/server.ts` or `commands/index.ts`. Other people are editing them right now.
  If you need a change there (a new control op, a registry entry), stop and say exactly what you need in your
  final report.
- **Shared files:**
  - **`link/src/mock.ts`:** you may add cases to `mockControl` / `mockCli` or new mock data for your panel. Use
    small Edit calls on distinct lines, and re-read before each edit, because other builders edit this file too.
  - **`app/src/chat/chat.css`:** append your styles in your own clearly headed section at the end only, using the
    existing tokens (`--accent`, `--ok`, `--bad`, `--warn`, `--panel-*`, `--text-*`, `--font-*`). Prefer the
    existing `.mrow` / `.mdetail` menu classes.

## How to build

- **Look and words:** match the CLI exactly where the research spec has it (titles, labels, glyphs, order, footer
  hints, result messages), shown in the VN menu.
- **Routes, in order of preference:**
  1. the CLI's own headless command through `host.cli('/x ...')`, so the CLI's own code runs;
  2. an SDK control through `control(host.link, op, …)`;
  3. the settings-file controls (`settingsFiles`, `editSettings`, `readText`, `cliExec`).
- **Never fake data in the real app.** If something can't be done headless, show a short, honest line
  ("Run `claude …` in a terminal for this").
- **Errors:** a failing control rejects with a message. Let `openMenu` toast it, or show it in the screen body.
- **Stay small:** keep each file focused, with comment density like `mcp.ts`. No new dependencies.

## Testing

- **Typecheck:** `cd app && npx tsc --noEmit -p .` and `cd link && npx tsc --noEmit -p .` must pass.
- **Your scenario:** copy the shape of an existing file in `tests/e2e/scenarios/` (see `tests/README.md`), using the
  `T(...)`, `app.waitFor`, `app.key` and `app.click` helpers and `data-test="menu-row"` rows with `data-id`.
- **Running it:**
  - Run only your file, in browser mode, on your own CDP port:
    `cd C:\Users\mybook\Documents\Work\waifufy-code && MSYS_NO_PATHCONV=1 WC_E2E_TARGET=browser WC_CDP_PORT=<your port> node tests/e2e/run.mjs <your-file-name-part>`.
  - A shared Vite is already running on port 1430. Don't start or kill Vite.
  - `MSYS_NO_PATHCONV=1` stops Git Bash from turning `/mcp` into a Windows path.
- **Eyeballing:** `tests/e2e/dev/peek.mjs` screenshots a command (`node tests/e2e/dev/peek.mjs /mcp Enter`, with the
  same environment). Look at the PNGs.
- **No real models:** never run real model calls, `claude.exe` sessions, the installer build, or the full suite.

## Report

When done, return:
- the files you changed,
- what the panel does,
- what you couldn't do and why,
- any change you need in a file you don't own,
- your test result.
