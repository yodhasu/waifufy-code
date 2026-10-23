# Waifufy Code

Claude Code, played as a visual novel. Your waifu (Rem from Re:Zero by default, as a Live2D model) is the agent:
she talks in character, reacts with her face and gestures while she types at speaking pace, and you answer her
permission prompts, questions and plans from VN choice menus.

Under the skin it is the real Claude Code harness, through the Claude Agent SDK with its own bundled Claude Code,
so your tools, MCP servers, skills, hooks, `CLAUDE.md`, permission rules and settings files all apply, and the
keys you know from the terminal work the same way. The requirements are in [docs/V1.md](docs/V1.md).

## Install

Run `build\Waifufy-Code-0.1.0-setup.exe` (a per-user install; no Node or Claude Code install needed). The first
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
| Enter · Shift+Enter (or `\` Enter) | Send · new line |
| ↑ ↓ · Ctrl+R | Input history per project · search it |
| `/` | Commands: the CLI's, your custom commands and skills, plus app ones (`/model`, `/clear`, `/resume`, `/config`, `/costume`, `/login`, `/help`, `/exit`) |
| `@` | Mention a file or folder (fuzzy, respects `.gitignore`) |
| `!` | Shell command in the session folder; she answers the output, as the CLI does (`respondToBashCommands`) |
| Paste / drop / 📎 | Images |
| Enter while she works | Queues the message for the next turn |
| Esc · Ctrl+C | Close the top menu, then interrupt |
| Shift+Tab | Permission mode: default → accept edits → plan (→ auto) |
| Ctrl+L · Ctrl+O | LOG: the full trace, searchable and copyable |
| Click · Space · Enter | Next page · hold Ctrl to skip · AUTO advances by itself |
| 1–9 · ↑↓ Enter | Answer a choice menu (risky prompts default to No) |

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
  **Voice** (off in v1), **About**.

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
