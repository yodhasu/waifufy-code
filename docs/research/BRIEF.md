# V0.5 research brief (shared by every research pass)

Waifufy Code is a Tauri 2 desktop client for Claude Code with a visual-novel UI and a Live2D character (Rem).
It runs the real Claude Code harness through the Agent SDK: `link/src/session.ts` calls `query()` once per chat
with a streaming prompt, `systemPrompt: { type: 'preset', preset: 'claude_code', append: persona }`, the user's
settingSources, and `canUseTool` for permission prompts. The app's own slash commands live in
`app/src/chat/input.ts` (`APP_COMMANDS`) and `app/src/chat/index.ts` (`local(name, args)`). Everything else is
sent to the SDK as text, and in SDK (headless) mode the CLI's interactive `local-jsx` commands only answer
"opens an interactive panel" or a plain-text fallback.

V0.5 goal: a developer who knows the Claude Code CLI can use Waifufy Code with no relearning, and every
interactive CLI command has an in-app equivalent (for example `/mcp` opens a "Manage MCP servers" menu with the
same groups, statuses and per-server actions), while the app feels like playing a visual novel.

## Sources

- **CLI JavaScript, extracted from the bundled `claude.exe` 2.1.309 (Bun single-file executable):**
  `C:\Users\mybook\AppData\Local\Temp\claude\C--Users-mybook\87262028-c38e-4182-b8a6-d05ad7ef4ee1\scratchpad\cc\`
  - About 2,540 minified chunks. The command registry and most UI is in `chunk-ktgr2fgq.js` (5 MB); lazy
    panels live in other chunks (for example `/mcp` and `/plugin` in `chunk-vfxr8tvv.js` and `chunk-gxezc1xn.js`).
  - Commands are objects like `{type:"local-jsx",name:"mcp",description:...,load:()=>import(...)}`. Some have
    both a `local-jsx` variant (interactive) and a `local` variant (headless).
  - It is minified React/Ink: look for `label:"…"`, `title:"…"`, `children:"…"`, `chord:[…]`, `action:"…"`.
  - Read it with grep (`-o` with bounded context such as `.{0,300}`) or small node scripts. Never print whole
    lines; they are megabytes long.
- **Agent SDK types:** `C:\Users\mybook\Documents\Work\waifufy-code\link\node_modules\@anthropic-ai\claude-agent-sdk\sdk.d.ts`.
  The `Query` interface (around line 2914) has setModel, setPermissionMode, setMaxThinkingTokens,
  applyFlagSettings, updateSettings, supportedCommands/Models/Agents, mcpServerStatus, reconnectMcpServer,
  toggleMcpServer, setMcpServers, getContextUsage, reloadPlugins, reloadSkills, accountInfo, rewindFiles,
  stopTask, backgroundTasks and more.
- **The app:** `C:\Users\mybook\Documents\Work\waifufy-code` (`app/src/chat/*`, `link/src/*`, `docs/V1.md`).

## Rules

- **Read-only.** Do not edit app code. Write only your own spec file under `docs/research/`.
- **Don't run `claude.exe`,** and don't make model calls.
- **Label every claim:** say whether it was observed in code, inferred, or unknown.
- **Map every CLI feature to an implementation route:**
  - an SDK method or option (name it),
  - files the app can read or write itself (`~/.claude.json`, `settings.json`, `.mcp.json`, `~/.claude/agents/*.md`,
    `CLAUDE.md` and so on),
  - sending the command text through to the SDK, or
  - not possible headless.
- **Keep specs dense and structured:** tables and bullets, no prose padding.
