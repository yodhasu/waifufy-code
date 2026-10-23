# Waifufy Code: spec

> The v0 design notes. The v1 requirements, architecture and contracts are in [docs/V1.md](docs/V1.md), which supersedes this file where they differ.

A desktop Claude Code client with a visual novel UI. Rem from Re:Zero is the agent's persona: every reply is in character. Under the hood it's the full Claude Code harness through the Claude Agent SDK (tools, MCP, skills, hooks, CLAUDE.md, permissions). Desktop first (Tauri 2), Android port later.

## Architecture

- `app/`: Tauri 2 window (WebView2). Holds the VN frontend and the Live2D stage, reused from waifufy's `overlay/src/stage.ts`.
- `link/`: a Node sidecar running the Agent SDK `query()` loop. It talks to the app over a localhost WebSocket with a token. The phone becomes a second client of this sidecar later.
- Auth: Claude subscription login, so the plan-limit gauges work.

## Screens

### Main menu (shown on open)

1. **Resume last chat**: only enabled when sessions exist.
   - Opens a session list from `listSessions()`, newest first. Each row shows the title (`customTitle` or `summary`), the working directory shortened (`~/Work/booking-tools`) with `gitBranch`, and a relative time.
   - Picking a session resumes it with `query({ resume, cwd })`, and the backlog is refilled from `getSessionMessages()`.
2. **New chat**: opens a folder picker, then starts `query({ cwd })` in the chosen folder.
3. **Settings**: to be decided.
4. **Exit**: confirms if a turn is still running, then stops the sidecar.

### Chat

The design is `ui-draft/index.html`, a 16:9 fixed stage scaled to fit the window:

- **Left, status**: affection, context (with breakdown), 5-hour and weekly limits, spend, turns, time, tokens, cache hit, model, permission mode.
- **Center**: Rem (Live2D). Her expression comes from emotion tags in her replies.
- **Bottom**: dialogue box (typewriter, name plate, ▼) and the Speak-to-Rem input bar.
  - Typing `/` opens a command picker that shows 5 rows and scrolls.
  - Quick menu: LOG · AUTO · MODE · CMD · STOP.
- **Right**: quest log (todos), party (subagents), Rem's actions (tool log).
- **Permission prompts and `AskUserQuestion`**: shown as VN choice menus.

## Open questions

- Settings contents.
- Model routing (Haiku for chat, Opus for work): deferred until the app is stable. See "Later".

## Decisions

- **Sessions: Waifufy Code sessions only, for now.** The app keeps its own `sessions.json` (session ID, cwd, title, created) and filters `listSessions()` by it.
  - Why: a resumed session appears to reuse the system prompt recorded when it started, so a terminal session would come back without the Rem persona. Verify this before adding terminal sessions.

## Later

- Import terminal sessions, once the system-prompt behavior on resume is verified.
- Haiku "flavor lane": a separate tool-less Haiku query for banter, greetings, headpat lines and tool narration. The main session stays on Opus.
