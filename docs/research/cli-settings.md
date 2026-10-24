# CLI settings and status panels → Waifufy Code routes

Source: `claude.exe` 2.1.309 extracted chunks (`scratchpad/cc/`), Agent SDK `sdk.d.ts`, app `link/src/*`.
Labels: **[obs]** observed in code, **[inf]** inferred, **[unk]** unknown.

## 0. Key findings (read first)

| # | Finding | Label |
|---|---|---|
| 1 | Most settings panels are **one component**: `GSe` "Settings" dialog (`chunk-rvbng2re.js`) with tabs **Status · Config · Usage · Stats**. `/status` opens it on Status, `/config` (`/settings`) on Config, `/usage` and `/cost` on Usage, `/stats` on Stats (alias name decides tab). | obs |
| 2 | Commands with a headless `local` variant (enabled when `_e()` = non-interactive, i.e. SDK mode) return **plain text** when sent as text: `/model <name>`, `/effort <level>`, `/fast [on\|off]`, `/config key=value …`, `/add-dir <path>`, `/usage`, `/context`, `/color [name]`, `/focus [on\|off]`. | obs |
| 3 | JSX-only (no headless variant; SDK answers "opens an interactive panel"): `/status`, `/permissions`, `/theme`, `/privacy-settings`, `/login`, `/logout`, `/terminal-setup`, `/scroll-speed`, `/version` (disabled: `isEnabled:()=>!1` on both variants). | obs |
| 4 | **`/config key=value` is the universal write path.** Headless `/config` runs the same row list as the panel (`l5e(...).settings`) through `JOt`→`Ro`, calling each row's own `onChange` (same file, same side effects). It refuses consent-gated rows ("can't be enabled with key=value — open /config") and locked rows. `/config` with no args (headless) prints `Usage: /config key=value [key=value ...]` + every `id=true\|false` / `id=opt1\|opt2` line. | obs |
| 5 | `Query.updateSettings()` only accepts an allowlist: `localSettings: outputStyle`, `userSettings: effortLevel` (string values, no deletion). Everything else must go through `/config key=value` text, `applyFlagSettings` (session-only flag layer), or the app writing files. | obs (sdk.d.ts) |
| 6 | Thin-client CLIs use `apply_flag_settings` control requests for `/effort` and `/focus` → `Query.applyFlagSettings` is the session-scoped route. | obs |
| 7 | App already proxies generic ops (`link/src/protocol.ts:271`: supportedModels, accountInfo, getContextUsage, usage, applyFlagSettings, updateSettings, setMaxThinkingTokens…) and has `setModel`, `setPermissionMode`. | obs |
| 8 | `/doctor` (alias `/checkup`) is a **bundled skill** (prompt command, `chunk-ccbqcjsa.js`), not a panel — send through as text. | obs |

Settings writers in the Config rows (`chunk-0w3bbckc.js`) [obs]:
- `j(key,v)` / `B(fn)` → `FY`/`Re` = **global config** `~/.claude.json`
- `F({...})` → `Hn("userSettings",…)` = **`~/.claude/settings.json`**
- `me({...})` → `Hn("localSettings",…)` = **`<project>/.claude/settings.local.json`**

---

## 1. Settings dialog shell (`GSe`)

- Title "Settings", color `permission`, tabs `Status | Config | Usage | Stats` [obs].
- Keybinding context `Settings` (defaults, `chunk-8nwra1mk.js`) [obs]: `escape` confirm:no (close/cancel), `up/k/ctrl+p` previous, `down/j/ctrl+n` next, `home/end`, `pageup/pagedown`, `space`/`enter` select:accept, `/` settings:search, `r` settings:retry, `d` settings:periodDay, `w` settings:periodWeek, `f` settings:fixUsage, `t` settings:sortByTokens, `ctrl+u/ctrl+d` half-page scroll.
- Tabs context: `tab`/`right` next, `shift+tab`/`left` previous.
- Esc pressed twice pattern: "Press Esc again to close/cancel" [obs].

## 2. /status (Status tab)

Rows built by `apr()`+`lpr()` (`chunk-t9tnejgs.js`) and helpers (`chunk-zt7scxs5.js`) [obs], rendered as 2-column table (bold label | value), then "System diagnostics" list, footer `Esc cancel`.

| Group | Label | Value |
|---|---|---|
| Session | Version | `2.1.309` + suffix |
| | Session name | title or dim "/rename to add a name" |
| | Session ID / Cloud session ID | session UUID |
| | Session kind | `interactive` / `background job · unattended` / `background job · attached` |
| | tmux session | `$CLAUDE_CODE_TMUX_SESSION` (if set) |
| | Channels | "Listening for messages from plugin:x@m, server:y" / "Configured but not active (reason): …" |
| | Peer address | `uds:<socket>` or `unavailable — …` |
| | Memory | "Paused for this session · /pause-memory to resume" |
| | cwd | working directory |
| Account (`qAn`) | Login | "Expired — log in again" |
| | Login method | `<subscription> account` |
| | Auth token / API key / apiKeyHelper | source (+ " · not in use") |
| | Profile, Organization, Email | from OAuth account |
| Cloud | Cloud sessions | "GitHub connected" / "Not set up · /web-setup to connect GitHub" |
| Org | Organization configuration | e.g. hipaa flags |
| Provider (`YAn`) | Allowed providers, API provider, Anthropic base URL, Bedrock base URL, AWS region, Bedrock service tier, Vertex base URL, GCP project, Default region, Microsoft Foundry base URL/resource, Claude Platform on AWS/Google Cloud base URL, Workspace ID, GCP location, Gateway URL, Gateway account, Bedrock (Mantle) base URL, Proxy, Additional CA cert(s), mTLS client cert/key | env/config |
| Model (`lpr`) | Model | model display name (+ "(previous …)") |
| | IDE | "Connected to <IDE> extension version x" / "Installed …" / "✗ Not connected to …" / error |
| | MCP servers | names + " · /mcp" |
| | Setting sources | user/project/local/policy (with "Enterprise managed settings (file/HKLM/HKCU/plist/remote…)") |
| | Skipped sources, Permission rules, Managed settings (remote), Organization policy, Client data | when applicable |
| | Auto mode server | Enabled / Disabled |
| Diagnostics | System diagnostics | install warnings, invalid settings entries, "No write permissions for auto-updates", process-wrapper notes |

**SDK route:** `initializationResult()` (`claude_code_version`, `account`, `models`, `output_style`, `fast_mode_state`), `accountInfo()` (email, organization, subscriptionType, tokenSource, apiKeySource, apiProvider), `mcpServerStatus()`, `getContextUsage({detail:'summary'}).model`, session id from `system/init`, `resolveSettings()` (sources + provenance → "Setting sources"), env vars from the app's own process for provider rows. Diagnostics: not exposed [inf] — skip or show settings parse errors from `resolveSettings`. tmux/peer/channels: terminal-only, skip.

## 3. /config (Config tab)

UI [obs]: search box "Search settings…" (`/` to focus, "Type to filter", `Esc clear`), list of rows (`label  value`), `No settings match "…"`. Footer: `↑/↓ navigate · Enter/space change · ←/→/tab switch · Esc save and close`. Booleans toggle in place; enums cycle or open a picker; `managedEnum` opens a sub-dialog (Theme, Model, Output style, Language, Auto-update channel, Notifications, External includes). Locked rows show policy reason. Changes write immediately; on close a change log is printed (`L.record`). Remote sessions hide rows `model, fast, thinking, useAutoModeDuringPlan, autoCompact, idleCompaction, autoContinueAtUsageLimit, precomputeCompactionEnabled, checkpoints, outputStyle, defaultView` (`mo()`).

`/config key=value` accepts the row **id** (case-insensitive) [obs]. Booleans accept true/false/1/0/on/off/yes/no [inf from `d5e`].

### Every row (order as in code; G = gated/conditional)

| id (key) | Label | Type | Options | Default | Saved to |
|---|---|---|---|---|---|
| theme | Theme | managedEnum | auto, dark, light, light-daltonized, dark-daltonized, light-ansi, dark-ansi (hint "For custom themes, use /theme.") | dark [inf] | `~/.claude.json` `theme` |
| remoteControl (G) | Enable Remote Control for all sessions | enum (managedEnum when policy-locked: only `false`) | true, false, default | default | `~/.claude.json` `remoteControlAtStartup` (default = delete) |
| defaultToAgentsView (G) | Open agents view by default | boolean | | false | `~/.claude.json` |
| leftArrowOpensAgents (G) | `← opens agents` | boolean | | true | `~/.claude.json` |
| notifChannel | Local notifications (or "Notifications" managedEnum) | enum | auto, iterm2, terminal_bell, iterm2_with_bell, kitty, ghostty, notifications_disabled (shown: Auto, iTerm2 (OSC 9), Terminal Bell (\a), iTerm2 w/ Bell, Kitty (OSC 99), Ghostty (OSC 777), Disabled) | auto [inf] | `~/.claude.json` `preferredNotifChannel` |
| inputNeededNotifEnabled (G) | Push when actions required | boolean | | false | `~/.claude.json` |
| agentPushNotifEnabled (G) | Push when Claude decides | boolean | | false | `~/.claude.json` |
| autoCompact | Auto-compact | boolean | | true [inf] | `~/.claude.json` `autoCompactEnabled` |
| idleCompaction (G) | Idle compaction | boolean | | true | settings.json `idleCompaction` |
| autoContinueAtUsageLimit | Continue automatically at usage limit | boolean | | true | settings.json |
| remoteHomeSettings (G, consent) | Use this machine's settings in cloud sessions | boolean | (forward / keep_local) | off | `~/.claude.json` `remoteHomeSettingsMode`; can only be turned on in panel |
| unattendedServing (G, consent) | Unattended commands from cloud sessions on this computer | enum | Not allowed, Allowed | Not asked yet | settings.json `remoteTools.allowUnattendedServing` [inf] |
| switchModelsOnFlag (G) | Switch models when a message is flagged | enum | Switch automatically, Ask each time | Not asked yet | settings.json `switchModelsOnFlag` [inf] |
| tips | Show tips | boolean | | true | **settings.local.json** `spinnerTipsEnabled` |
| feedbackDrafts (G) | Claude-drafted feedback | enum | notify, quiet, off | notify | via `dNn` [unk file] |
| reduceMotion | Reduce motion | boolean | | false | settings.local.json `prefersReducedMotion` |
| thinking | Thinking mode | boolean (lockable: "Thinking can't be turned off for this model") | | on | settings.json `alwaysThinkingEnabled` (false when off, removed when on) |
| fast (G) | Fast mode (`<model>`) | boolean | | off | settings.json `fastMode`; runs PreModelSwitch hooks |
| promptSuggestionEnabled (G) | Prompt suggestions | boolean | | on | settings.json (false / removed) |
| recap | Session recap | boolean | | on | settings.json `awaySummaryEnabled` |
| checkpoints (G) | Rewind code (checkpoints) | boolean | | on [inf] | `~/.claude.json` `fileCheckpointingEnabled` |
| orgMemoryRead (G) | Synced project memory (this directory; applies next session) | boolean | | true | per-project config via `y4s` [unk] |
| orgMemoryWrites (G, consent) | Synced project memory writes (…) | boolean | | off | `M8n` [unk] |
| workflows (G) | Dynamic workflows | boolean | | model-dependent | settings.json `enableWorkflows` (clears `disableWorkflows`) |
| workflowKeywordTriggerEnabled (G) | Ultracode keyword trigger | boolean | | true | settings.json |
| workflowSizeGuideline (G) | Dynamic workflow size | enum | unrestricted, small, medium, large | medium [inf] | `~/.claude.json` |
| artifacts (G) | Artifacts | boolean | | per account | settings.json `enableArtifact` |
| verbose | Verbose output | boolean | | false | `~/.claude.json` `verbose` |
| progressBar | Terminal progress bar | boolean | | on [inf] | `~/.claude.json` `terminalProgressBarEnabled` |
| showStatusInTerminalTab (G) | Show status in terminal tab | boolean | | false | `~/.claude.json` |
| turnDuration | Show turn duration | boolean | | [unk] | `~/.claude.json` `showTurnDuration` |
| precomputeCompactionEnabled | Precompute compaction | boolean | | true | settings.json |
| timestamps | Show message timestamps | boolean | | [unk] | `~/.claude.json` `showMessageTimestamps` |
| timeFormat | Time format | enum | auto, 12-hour, 24-hour, 24-hour-utc | auto | settings.json |
| permissionMode | Default permission mode | enum | default, plan, + other modes (acceptEdits, auto, dontAsk…) except bypassPermissions | default | settings.json `permissions.defaultMode` |
| worktreeBaseRef | Worktree base ref | enum | fresh, head | fresh | settings.json `worktree.baseRef` |
| useAutoModeDuringPlan | Use auto mode during plan | boolean | | true | settings.json |
| gitignore | Respect .gitignore in file picker | boolean | | true [inf] | `~/.claude.json` `respectGitignore` |
| copyFullResponse | Skip the /copy picker | boolean | | false [inf] | `~/.claude.json` |
| copyOnSelect | Copy on select | boolean | | true | `~/.claude.json` |
| autoScroll | Auto-scroll | boolean | | [unk] | `~/.claude.json` `autoScrollEnabled` |
| agentsView (G) | Agents view | managedEnum (read-only) | on, off | | display only |
| autoUpdatesChannel | Auto-update channel | managedEnum | latest, stable / "disabled" | latest [inf] | sub-dialogs "Enable Auto-Updates" (Enable with latest/stable channel), "Switch to Stable Channel" (Allow possible downgrade / stay) → settings.json `autoUpdatesChannel` [inf] |
| outputStyle | Output style | managedEnum | default + built-ins (Proactive, Explanatory, Learning…) + custom | default | settings.local.json `outputStyle` (dialog "Preferred output style") |
| defaultView (G) | Default view | enum | transcript, chat, default | default | settings.local.json |
| language | Language | managedEnum (free text, "Any language name or ISO code (e.g. 'ja'); use 'default' for English.") | | Default (English) | settings.json `language` |
| editor | Editor mode | enum | normal, vim | normal | `~/.claude.json` `editorMode` |
| askUserQuestionTimeout (G) | Question auto-continue timeout | enum | never, 60s, 5m, 10m | never | settings.json |
| modelProposedGoals | Claude-proposed goals | enum | auto, alwaysAsk, disabled | [unk] | settings.json |
| externalEditorContext | Show last response in external editor | boolean | | false | `~/.claude.json` |
| prStatus | Show PR status footer | boolean | | true | `~/.claude.json` `prStatusFooterEnabled` |
| model | Model | managedEnum | `So()` list (Default (recommended), …) — "For a specific model ID, use /model." | Default | settings.json `model` + session model |
| diffTool (G) | Diff tool | enum | terminal, auto | auto | `~/.claude.json` |
| autoConnectIde (G: not IDE terminal) | Auto-connect to IDE (external terminal) | boolean | | false | `~/.claude.json` |
| autoInstallIdeExtension (G: IDE terminal) | Auto-install IDE extension | boolean | | true | `~/.claude.json` |
| chrome (G) | Claude in Chrome enabled by default | boolean | | false | `~/.claude.json` `claudeInChromeDefaultEnabled` |
| teammateMode (G) | Teammate mode | enum | auto, tmux, iterm2, in-process | auto [inf] | `~/.claude.json` |
| dialogExpiry (G) | Dialog expiry | enum | default, 60s, 5m, 10m, never | default | settings.json |
| crossSessionInbound (G) | Messages from your other sessions | enum | default, accept, hold, refuse | default | settings.json |
| showExternalIncludesDialog (G) | External CLAUDE.md includes | managedEnum | true, false | | project entry in `~/.claude.json` [inf] (dialog "disable external includes") |
| apiKey (G: `ANTHROPIC_API_KEY` set, consent) | Use custom API key: `<key tail>` | boolean | | | `~/.claude.json` `customApiKeyResponses.approved/rejected` |

Also in the Config tab dialog rows: "Notifications" sub-dialog (Channel, Notify when Claude needs you, Notify when Claude is done, "get the app") [obs]; plugin options rows from `pluginConfigs` saved to settings.json [obs].

**SDK route per row:**
- Default route: send `/config <id>=<value>` as text (headless writer, same side effects, returns a text line per pair). Use it for every non-consent row. [obs]
- Session-only live effect: `applyFlagSettings({...})` with the settings key (e.g. `alwaysThinkingEnabled`, `fastMode`, `language`, `permissions`…). [obs API, inf mapping]
- `outputStyle`: `updateSettings('localSettings',{outputStyle})` (allowlisted) + `reloadOutputStyles()` for the list; list from `initializationResult().available_output_styles`. [obs]
- `model`: `setModel()` + `/config model=…` or write settings.json. `thinking`: `setMaxThinkingTokens(0 | null)`. `permissionMode`: `setPermissionMode()` for the session + settings.json for the default. [obs]
- Read current values: `resolveSettings({cwd})` for settings files; read `~/.claude.json` directly for global-config rows. [obs API]
- Consent-gated rows (remoteHomeSettings, unattendedServing, orgMemoryWrites, apiKey): only turn-off works headless; app must write the file with its own consent UI or skip. [obs]
- Terminal-only, skip in desktop: notifChannel (terminal OSC), progressBar, showStatusInTerminalTab, editor (vim), copyOnSelect, autoScroll, diffTool, autoConnectIde, autoInstallIdeExtension, teammateMode, reduceMotion (app has own), theme (app has own theme), agentsView/leftArrow/defaultToAgentsView, defaultView, verbose (app decides), externalEditorContext, gitignore (file picker is app's own). [inf]

## 4. /model

Panel (`chunk-6nsdtg9a.js` ~@659k) [obs]:
- Title "Select model" (color remember, bold); sub "Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model."; when a session override exists: "Currently using X for this session only (base model: Y). Selecting a model here replaces both."
- List: `Default (recommended)` ("Use the default model (currently …)") + models with description and price (`$x/$y per Mtok`); type to filter ("No models match …").
- Effort line under list: effort glyph + level (+ " (default)") + `←/→ adjust`, " · Ultracode on (/effort)" when relevant; fast-mode note.
- Footer: `Enter confirm/set as default · s use this session only · ↓ list · Esc cancel`; filter mode: "Type to filter · Enter/↓ list · Esc clear".
- Keybindings `ModelPicker`: `left` decreaseEffort, `right` increaseEffort, `s` thisSessionOnly. [obs]
- PreModelSwitch hooks run ("Running PreModelSwitch hooks…"); confirmation dialog `$pe` for usage-credit models; mid-conversation switch prompt `iY` (2 options) [obs, labels unk].
- Result message "Set model to X" (`YXe`), cancel: "Kept model as X".
- Saves: settings.json `model` (default pick) or session-only (`mainLoopModelForSession`) [obs via `Te`/config]; chosen effort → `sessionEffort`.
- Headless `/model <name>`: "Usage: /model <name>. Available: …, default, or a full model ID." [obs]

**SDK route:** `supportedModels()` (value, displayName, description, supportsEffort, supportedEffortLevels, supportsFastMode, supportsAdaptiveThinking) → list; `setModel(value|undefined)` → session; persist default by `/config model=<alias>` text or writing settings.json `model`; effort via `applyFlagSettings({effortLevel})`. Already partly in app (`session.setModel`).

## 5. /effort

Panel (`chunk-t9sccqvy.js`) [obs]:
- Slider "Effort" between "Faster" and "Smarter", ▲ marker; levels low (warning), medium (success), high (permission), xhigh (autoAccept-shimmer), max (rainbow); levels capped per model ("Higher effort levels are capped by your settings or organization."); "(default)" tag; org notes ("Your organization's default effort for this model is …").
- Optional row "Ultracode: on/off" (needs Dynamic workflows).
- Keys `EffortSlider`: `←/→` adjust, `tab` toggle Ultracode, `s` this session only, `Enter` confirm, `Esc` cancel ("Press Esc again to cancel").
- Descriptions (`chunk-s2ynbn07.js`): low "Quick, straightforward implementation", medium "Balanced approach with standard testing", high "Comprehensive implementation with extensive testing", xhigh "Extended reasoning with thorough analysis (on supported models)", max "Maximum capability with deepest reasoning (on supported models)", auto "Use the default effort level for your model".
- Messages: "Set effort level to X (saved as your default for new sessions)" / "(this session only)"; `max` is session-only; `CLAUDE_CODE_EFFORT_LEVEL` override notices. Saved: settings.json `effortLevel` (per model) [inf from message + sdk doc].
- Args: `/effort low|medium|high|xhigh|max|auto|current|status|ultracode on|off`.

**SDK route:** session: `applyFlagSettings({effortLevel})` (`null` = model default; `ultracode: true|false`); persist: `updateSettings('userSettings',{effortLevel})` (allowlisted). Or send `/effort <level>` as text. Levels from `ModelInfo.supportedEffortLevels`.

## 6. /fast

Picker `rCn` (`chunk-6nsdtg9a.js`) [obs]: title "Fast mode (research preview)", body "High-speed mode for <model>. Draws from usage credits at a higher rate. Separate rate limits apply.", toggle `ON / OFF`, footer `space toggle · Enter confirm · Esc cancel`; states "Applying fast mode…", "Running PreModelSwitch hooks…", "Turning fast mode on/off…", cooldown "You've hit your fast limit · resets in …", "Fast mode overloaded and is temporarily unavailable", link https://code.claude.com/docs/en/fast-mode. Results "Fast mode ON/OFF", "Kept Fast mode ON/OFF".
Saved settings.json `fastMode` (+ may switch model) [obs via config row].
Headless: `/fast [on|off]` → text; "Fast mode is not available" [obs].

**SDK route:** state from `initializationResult().fast_mode_state` / `fast_mode_disabled_reason`, `ModelInfo.supportsFastMode`; change by sending `/fast on|off` (runs hooks, model swap) [recommended], or `applyFlagSettings({fastMode})` [inf]. Persist: `/config fast=true`.

## 7. /permissions (alias /allowed-tools)

Dialog "Permissions" (`chunk-kej2h1x1.js`) [obs], tabs:

| Tab | Content |
|---|---|
| Recently denied (default when denials exist) | Commands denied by the auto mode classifier; per row toggle approve / retry ("(approved)", "(retry)"); footer "Enter to approve · r to retry · Esc to close"; on Esc: "Esc will approve N denied calls" / "Esc will retry N denied calls" → sends "Permission granted for: … You may now retry …". Empty: "No recent denials. Commands denied by the auto mode classifier will appear here." |
| Allow / Ask / Deny | Rule list grouped by source; first item "Add a new rule…"; search ("Type to filter · Enter/↓ to select · ↑ to tabs · Esc to clear"); shadow warnings ("Blocked by "X" deny rule (from …)", "Shadowed by … ask rule", with Fix text). |
| Auto mode | Sections Soft allow / Soft deny / Hard deny / Environment; "Add a new rule…" (saved to user settings `autoMode.<section>`), Built-in rules toggle ("Disable/Enable built-in rules for this section"), Edit environment (document), View in editor, delete confirm "Delete auto mode rule?". |
| Workspace | Directories list with "(Original working directory)" marker and "Add directory…"; select dir → "Remove directory from workspace?" "Claude Code will no longer have access to files in this directory." |

Flows [obs]:
- **Add rule:** title "Add <allow|ask|deny> permission rule"; help "Permission rules are a tool name, optionally followed by a specifier in parentheses." with examples (WebFetch / Bash(…)); input "Enter permission rule…" (`Enter submit · Esc cancel`) → "Where should this rule be saved?" options: **Project settings (local)** "Saved in .claude/settings.local.json", **Project settings** "Checked in at .claude/settings.json", **User settings** "Saved in at ~/.claude/settings.json".
- **Delete rule:** select → "Rule details" → "Delete <tool> tool?" "Are you sure you want to delete this permission rule?" (`Enter confirm · Esc cancel`); policy rules: "This rule is configured by managed settings and cannot be modified."; flag/command rules read-only. Result "Deleted allow rule X".
- Footer: `↑/↓ navigate · ←/→ switch · Esc close`; on exit prints list of changes.
- Remote/cloud session: read-only via `get_settings` control request.

**SDK route:** read rules: `resolveSettings({cwd}).sources[*].settings.permissions.{allow,ask,deny,additionalDirectories}` (with source path); write: the app edits the chosen settings file (`.claude/settings.local.json`, `.claude/settings.json`, `~/.claude/settings.json`) — no SDK writer for permissions [obs: updateSettings allowlist]; live-apply session rules with `applyFlagSettings({permissions})` [inf] or restart/`reinitialize`. Recently denied: the app owns denials through `canUseTool`/auto-mode messages → app-side list [inf]. Auto mode rules: settings.json `autoMode.{allow,soft_deny,hard_deny,environment}` file edit.

## 8. /add-dir

`eat` dialog (`chunk-35pbemrb.js`) [obs]: "Add directory to workspace"; no arg → input "Enter the path to the directory:" placeholder "Directory path…" with path completion (↑/↓, Tab). With path → confirm: "Claude Code will be able to read files in this directory and make edits when auto-accept edits is on." Options **Yes, for this session** / **Yes, and remember this directory** / **No**. Results: "Added X as a working directory for this session" / "… and saved to local settings" (`.claude/settings.local.json` `permissions.additionalDirectories`) + "· /permissions to manage"; cancel "Did not add a working directory."; runs DirectoryAdded hooks.
Headless `/add-dir <path>` exists (session-only, text) [obs].

**SDK route:** session: send `/add-dir <path>` text; persist: app writes `permissions.additionalDirectories` in settings.local.json; for new sessions `Options.additionalDirectories`. App supplies a native folder picker.

## 9. /usage · /cost · /stats

Usage tab [obs]: "Loading usage data…", bars "Current session" (5h), "Current week (all models)", "Current week (Sonnet only)" or per-model "Current week (<name>)", "Claude Code and Cowork credit", extra-usage bar ("$x spent", "Usage credits are off · /usage-credits to turn them on", "Unlimited"), "Spend limit · shown once your gateway reports one"; errors "Usage endpoint is rate limited…", "Showing last-known usage (could not refresh)", `r retry`. Section "What's contributing to your limits usage?" ("Approximate · sessions on this machine only", `d day / w week`, `% of usage`, Loops table: every/runs/tokens/per run/last run), "Skills, subagents, plugins, and MCP servers" (Skills / Subagents / Plugins / MCP servers lists), "Plugin skill-listing footprint" (tok/turn), `f` fix usage, `t` sort by tokens.
Stats tab [obs]: sub-tabs **Overview / Models**; range All time / Last 7 days / Last 30 days (`r to cycle dates`), `ctrl+s` copy screenshot to clipboard, "↑ tabs", "↓ stats"; Overview: heatmap, Sessions, Total tokens, Active days, Current streak, Longest streak, Longest session, Most active day, Favorite model, "Shot distribution", fun comparison ("~Nx the tokens in The Hobbit"); Models: per-model Input/Output/Cache read/write, "Tokens per Day" chart. Data: `~/.claude/stats-cache.json` + local transcripts [obs file name].
Headless `/usage` text: same bars + "Last 24h / Last 7d" behaviors; gateway spend [obs].

**SDK route:** `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors?})` → `session` cost/duration/lines/model_usage, `rate_limits` (five_hour, seven_day, seven_day_sonnet/opus, model_scoped[], extra_usage), `behaviors.day/week` (already used in `session.ts:1157`). Session cost also from `result` messages. Stats tab: app reads `~/.claude/stats-cache.json` / `listSessions()` + `getSessionMessages()` itself [inf]; `ctrl+s` screenshot: terminal-only.

## 10. /context

Grid panel (`chunk-m5hw2e93.js`) [obs]: title "Context Usage", left grid of squares (⛁ ≥70% full, ⛀ partial, ⛶ "Free space" dim, ⛝ "Autocompact buffer"), right legend: model, `used/total tokens (pct%)`, one line per category `⛁ name: N tokens (x%)`, deferred MCP "(loaded on-demand)", "Auto-compact window: auto (N tokens)". Sections: **MCP tools** (Loaded / Available, "· /mcp"), **Custom agents** ("· .claude/agents/", grouped by source), **Memory files** ("· /memory"), **Skills** ("· /skills", sources User/Managed/Plugin/Built-in), "/context all to expand". **Suggestions** list: "Context is N% full" (≥80%), tool result hogs (Bash/PowerShell/Read/Grep/WebFetch ≥15% & ≥10k), file reads, memory files ≥5%, "Autocompact is disabled".
Category ids (sdk): system_prompt, system_tools, mcp_tools, mcp_instructions, mcp_tools_deferred, system_tools_deferred, custom_agents, memory_files, skills, messages, autocompact buffer, free.

**SDK route:** `getContextUsage({detail:'full'})` → `categories[]` (id,name,tokens,color,kind), `gridRows[][]` (color,isFilled,categoryName,squareFullness), `memoryFiles`, `mcpTools`, `agents`, `skills.skillFrontmatter`, `messageBreakdown`, `isAutoCompactEnabled`, `autoCompactThreshold`. Suggestions: re-implement rules above client-side (thresholds 80%, 15%/10k, 5%/5k) [obs constants]. Already used in summary mode by the app.

## 11. /theme

Picker (`chunk-22g0s1fq.js`) [obs]: title "Theme", "Choose the text style that looks best with your terminal"; options Auto (match terminal), Dark mode, Light mode, Dark/Light mode (colorblind-friendly), Dark/Light mode (ANSI colors only), custom themes ("from <plugin>"), "New custom theme…"; live diff preview ("function greet()… Hello, Claude!"); `ctrl+t` toggle syntax highlighting (settings.json `syntaxHighlightingDisabled`), `ctrl+e` edit custom; `Enter select · Esc cancel`.
Custom theme editor (`chunk-fttkdftj.js`): Name step ("New custom theme"/"Fork X to your themes", slug `.json`), colors step: filter "Filter color tokens…", per-token "Value:" (rgb(r,g,b) · #rrggbb · ansi256(n) · ansi:name), reset. Saved to user themes dir `<slug>.json` [inf: ~/.claude/themes]. Theme saved to `~/.claude.json` `theme` [obs FY("theme")].

**SDK route:** none needed — terminal-only; desktop app has its own theme. Skip (or map to app theme).

## 12. /color

`/color [red|blue|green|yellow|purple|orange|pink|cyan|default]` (no arg = random) [obs]: sets prompt-bar/session color; stored as `agent-color` entry in the session transcript; "Session color set to: X" / "Session color reset to default"; refused for teammates. Has headless variant.
**SDK route:** send `/color <name>` text (persists in transcript); app paints its own prompt bar from the reply. Mostly cosmetic — optional.

## 13. /privacy-settings

[obs] Requires claude.ai OAuth; else prints "Review and manage your privacy settings at https://claude.ai/settings/data-privacy-controls". Dialog "Data privacy": row **Help improve our AI models** `true / false / false (for emails with your domain)`, `Enter/Tab/space toggle · Esc cancel`; first-time terms dialog "Updates to Consumer Terms and Policies" with options "Accept terms · Help improve our AI models: ON/OFF", "Not now". Result `"Help improve our AI models" set to true|false.` Stored server-side (account `grove_enabled`).
**SDK route:** not possible headless; open the URL in the browser. [inf]

## 14. /login · /logout

/login [obs]: "Select login method:" — **Claude account with subscription** · Pro, Max, Team, or Enterprise; **Anthropic Console account** · API usage billing (→ "How do you want to sign in?" Sign in with Console (recommended) / API key (legacy, "adds a key to your Console workspace"), Go back); **3rd-party platform** (Amazon Bedrock, Claude Platform on AWS, Microsoft Foundry, Google Vertex AI → docs); **Cloud gateway** (device code). Browser OAuth: "Opening browser to sign in…", "Browser didn't open? Visit:", paste code; `Esc` cancel/back. Description switches to "Switch Anthropic accounts" when logged in.
/logout [obs]: clears credentials + onboarding, "Successfully logged out from your Anthropic account.", then exits CLI; background sessions refused.
**SDK route:** not possible headless. App already opens a console window for login (`APP_COMMANDS.login`); `claude auth login` is the CLI subcommand referenced in messages [obs]. Logout: spawn `claude auth logout` [inf] or ask the user; then restart session. Show state via `accountInfo()`.

## 15. Terminal-only commands (skip in desktop)

| Command | What it does | Route |
|---|---|---|
| /terminal-setup | Installs Shift+Enter binding (VS Code/Cursor/Windsurf keybindings, Apple Terminal Option+Enter, iTerm2 clipboard); "Note: iTerm2, WezTerm, Ghostty, Kitty, Warp, and Windows Terminal support Shift+Enter natively." [obs] | skip |
| /scroll-speed | "Scroll speed" ruler, `←/→ adjust · r reset to auto · Enter save · Esc cancel`, "Scroll to feel it"; saves settings.json `env.CLAUDE_CODE_SCROLL_SPEED` (0.25–10 lines/notch) [obs] | skip |
| /focus | Toggle focus view (prompt, summary, response); headless variant uses `apply_flag_settings` `viewMode` [obs] | skip or map to app "focus" layout |
| /version | Disabled in this build [obs] | show `initializationResult().claude_code_version` in About |
| /tui | renderer default/fullscreen [obs] | skip |
| /color | cosmetic | optional |

## 16. Route summary

| Command | In-app screen | Primary route | Persist |
|---|---|---|---|
| /model | Model picker + effort slider | `supportedModels`, `setModel`, `applyFlagSettings({effortLevel})` | `/config model=…` text or settings.json `model` |
| /effort | Effort slider | `applyFlagSettings({effortLevel, ultracode})` | `updateSettings('userSettings',{effortLevel})` |
| /fast | Toggle | send `/fast on\|off` | `/config fast=true` |
| /config | Settings → Config (filtered rows) | send `/config id=value` text; read via `resolveSettings` + `~/.claude.json` | (writer handles file) |
| /permissions | Permissions tabs | `resolveSettings` read; app edits settings files | settings files |
| /add-dir | Folder picker + 3 options | send `/add-dir <path>` | settings.local.json `permissions.additionalDirectories` |
| /status | Settings → Status | `initializationResult`, `accountInfo`, `mcpServerStatus`, `resolveSettings` | — |
| /usage /cost /stats | Settings → Usage / Stats | `usage_EXPERIMENTAL…`; stats-cache.json | — |
| /context | Context grid | `getContextUsage({detail:'full'})` | — |
| /theme | app theme | app-only | app config |
| /color | prompt tint | `/color` text | transcript |
| /privacy-settings | link | open claude.ai URL | server |
| /login /logout | account screen | console window / `claude auth …` | credentials |
| /doctor | — | send text (bundled skill) | — |
| /terminal-setup /scroll-speed /focus /version | — | skip | — |
