# Waifufy Code

Claude Code with a visual novel skin: Rem from Re:Zero is the agent. Under the hood it's the full Claude Code harness through the Claude Agent SDK, so your tools, MCP servers, skills, hooks, `CLAUDE.md` and permission rules all apply. See [SPEC.md](SPEC.md) for the design.

## Pieces

- `app/`: the Tauri 2 window.
  - Vite + PixiJS + `untitled-pixi-live2d-engine`.
  - Screens: the main menu (resume, new chat, settings, exit) and the VN chat.
  - On start it launches the link sidecar with a free port and a random token, and stops it on exit.
- `link/`: a Node sidecar running the Agent SDK `query()` loop. It talks to the app over a localhost WebSocket (`link/src/protocol.ts`) and also serves Rem's model and voices.
  - `persona.ts`: Rem's persona, appended to Claude Code's own system prompt. It also defines the emotion tags (`[smile]`, `[think]`, …) that drive her expression.
  - `session.ts`: one SDK session.
    - Streams text and emotion tags.
    - Turns permission checks, `AskUserQuestion` and plan approval into choice menus.
    - Collects the stats: cost, tokens, context, plan limits.
  - `store.ts`: the sessions this app started, plus settings, in `%APPDATA%\waifufy-code\`.

Rem's Live2D model, voices and reaction config come from the [waifufy](../waifufy) checkout next to this repo (`waifufy.config.json` + `assets/`). Set `WAIFUFY_HOME` to point somewhere else.

## Run

Needs Node 24+ on `PATH` (the sidecar runs its TypeScript directly), Rust, and a Claude Code login (`claude` → `/login`).

```powershell
cd link; npm install; cd ..
cd app; npm install
Invoke-WebRequest https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js -OutFile public/live2dcubismcore.min.js
npm run tauri dev
```

Type checks: `npx tsc --noEmit` in `link/` and in `app/`.

## Settings

`%APPDATA%\waifufy-code\settings.json`:

```json
{ "userName": "Yodha" }
```

Rem calls you `<userName>-kun`. A settings screen will replace this file.

## Controls

| | |
|---|---|
| Click the dialogue box, Space, or Enter in an empty input | Next line |
| Hold Ctrl | Skip through lines |
| `/` in the input | Command picker: ↑↓, Enter runs, Tab completes |
| Esc | Interrupt Rem |
| Shift+Tab | Cycle the permission mode |
| Ctrl+L | Backlog |
| Quick menu | LOG · AUTO · MODE · CMD · STOP · MENU |
