# Waifufy Code

Claude Code, played as a visual novel. Your waifu (Rem from Re:Zero by default, as a Live2D model) is the agent:
she talks in character, reacts with her face and gestures while she types at speaking pace, and you answer her
permission prompts, questions and plans from VN choice menus.

Under the skin it is the real Claude Code harness, through the Claude Agent SDK with its own bundled Claude Code,
so your tools, MCP servers, skills, hooks, `CLAUDE.md`, permission rules and settings files all apply, and the
keys you know from the terminal work the same way. V0.5 brings the CLI's interactive panels in too (`/mcp`, `/config`,
`/permissions`, `/plugin`, rewind…), drawn as VN menus. The requirements are in [docs/V1.md](docs/V1.md) and
[docs/V0.5.md](docs/V0.5.md).

## Install

Run `build\Waifufy-Code-0.5.0-setup.exe` (a per-user install; no Node or Claude Code install needed). The first
run opens a short wizard:

1. **Your profile**: your name, what she calls you, the honorific (`-kun`, `-sama`, `-chan`, … or your own).
2. **Costumes**: the folder with the Live2D costume folders. It looks in
   `Downloads\ReZero LiM Live2D Characters\Live2D Characters` first. The models are third-party and not
   bundled; without them a built-in sprite stands in and everything else works.
3. **Claude login**: uses your Claude subscription (opens Claude Code's own login when needed).
4. **Theme**: light, dark or follow the system.

## Playing

- **Continue** resumes your latest save, **Load** opens the Save/Load page (thumbnails, play time, turns,
  affection; rename and delete), **New Game** asks for a folder and starts a session there.
- In the chat everything is the CLI you know:

| Key | Does |
|---|---|
| Enter · Shift+Enter, Ctrl+J or `\` Enter | Send · new line |
| Enter while she works · Ctrl+Enter | Queue for her next step · send now, into the running turn |
| ↑ ↓ · Ctrl+R | Input history per project · search it (Enter runs, Tab edits) |
| `/` · Ctrl+K · `?` | Commands · the command palette · the shortcut sheet |
| `@` | Mention a file, folder or agent (`@agent-Explore`) |
| `!` | Shell command in the session folder; she answers the output, as the CLI does (`respondToBashCommands`) |
| Paste / drop / 📎 / Alt+V | Images |
| Esc · Ctrl+C | Close the top menu, then interrupt · Esc Esc on an empty prompt: rewind |
| Shift+Tab | Permission mode: manual → accept edits → plan (→ auto); on a permission prompt, accept and switch |
| Ctrl+O · Ctrl+L · Ctrl+B | LOG (the full trace) · clear the prompt · send the running command to the background |
| Tab on an empty prompt | Take her greyed suggestion for the next prompt |
| Ctrl+Shift+F · `/focus` | Focus mode: just your prompt and her replies, shown whole; she stays still |
| Click · Space · Enter | Next page · hold Ctrl to skip (it always stops at a choice) · AUTO advances by itself |
| 1–9 · ↑↓ Enter | Answer a choice menu (risky prompts default to No) |

The CLI's interactive commands open as VN menus with the CLI's own groups, labels and actions: `/mcp`,
`/config` (every setting, saved through the CLI's own `/config key=value`), `/status`, `/usage` (`/cost`,
`/stats`), `/model`, `/effort`, `/fast`, `/context`, `/permissions`, `/add-dir`, `/plugin`, `/skills`,
`/hooks`, `/memory`, `/rewind`, `/tasks`, `/diff`, `/export` and `/copy`. Everything else (`/compact`,
`/init`, `/review`, your skills and custom commands) goes to Claude Code as typed. MCP servers that ask for input
get a form, and permission prompts offer the CLI's "don't ask again" scopes one per row.

Long output (lists, code, tables, reports) shows as a short page ending in `…`; the full text is always in the LOG.
Pat her head, tap her, or open 👗 to change her costume.

## Customizing

Settings (⚙ or `/config`) has a tab for each part:

- **You**: name, how she addresses you, pronouns, title, a note about you, avatar, nameplate color.
- **Waifu**: her name and series, your relationship (maid, childhood friend, senpai, kouhai, partner, rival, or your
  own), a personality preset (devoted, tsundere, kuudere, dandere, genki, onee-san, yandere-lite, ojou-sama,
  chuunibyou, deadpan senior, sensei) or your own text, formality / playfulness / chattiness, catchphrases,
  Japanese words, kaomoji, how much character goes into work output, emotion intensity, extra instructions,
  and a live preview of the persona prompt.
- **Roleplay**: type any character's name and series (and notes like "post-arc 4" or "more tsundere"), press
  Research, and Haiku researches them on the web and writes a profile and a tailored roleplay prompt. Edit it,
  save it to your library, and apply it.
- **Appearance**, **Text & Motion**, **Claude** (default model, permission mode, folder, settings sources),
  **Voice** (Fish Audio: her Japanese voice in sync with the text and her lips, once you store a key), **About**.

Persona changes apply from the next session; everything else applies live.

## Data

- Settings, saves, thumbnails: `%APPDATA%\waifufy-code\`
- Logs: `%APPDATA%\waifufy-code\logs\` (`link.log` from the sidecar, `sidecar.log` from the shell)
- Transcripts stay where Claude Code keeps them (`~\.claude\projects\`), so `claude --resume` in a terminal
  finds the same sessions. Deleting a save only removes it from the app's list.

## Development

Needs Node 24+, Rust (the `windows-gnu` toolchain works) and a Claude Code login.

```powershell
npm run setup                     # installs link/ and app/
Invoke-WebRequest https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js -OutFile app/public/live2dcubismcore.min.js
npm run dev                       # the app with the dev server
$env:WC_MOCK = '1'; npm run dev   # a scripted session instead of Claude: UI work without spending your plan
npm run check                     # type checks and cargo check
npm run build:installer           # build\Waifufy-Code-<version>-setup.exe
```

- `app/`: the Tauri 2 shell (`src-tauri/`) and the frontend: screens, the chat, the Live2D character.
- `link/`: the Node sidecar that runs the Agent SDK session and talks to the app over a local WebSocket
  (`link/src/protocol.ts`).
- Tests: see [tests/README.md](tests/README.md). The E2E suite drives the real app over CDP against a mock session;
  `tests/e2e/real.mjs` is a 3-turn Haiku smoke test you run by hand.

The Live2D Cubism Core is under the Live2D Proprietary Software License: download it, don't commit it.
