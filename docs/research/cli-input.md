# CLI interactive shell around the prompt: spec and gaps (V0.5 research)

Scope: keybindings, prompt input, the running-turn UI, the footer and status line, and dialogs. Source: Claude Code 2.1.309,
extracted chunks in `scratchpad/cc/`. App: `app/src/chat/input.ts`, `asks.ts`, `index.ts`, `link/src/session.ts`,
`docs/V1.md`.

Labels: **[obs]** observed in the code, **[inf]** inferred, **[unk]** unknown. Routes: **SDK** (method or option),
**FILE** (the app reads or writes it), **TEXT** (send the command text through), **APP** (pure UI work in the app),
**NO** (not possible headless).

---

## 1. Keybinding registry

[obs] `chunk-8nwra1mk.js` exports `V1` (the default blocks), `Lzt` (the contexts), `XJs` (context descriptions), `fLe`
(every action) and the reserved-key lists. Users override it in `~/.claude/keybindings.json`
(`{bindings:[{context, bindings:{chord: action | "command:<name>" | null}}]}`). `"command:help"` runs a slash command;
`null` unbinds a key.

Platform variables [obs]:
- `imagePaste` is **alt+v on Windows and WSL**, ctrl+v elsewhere (WSL also binds ctrl+v).
- `cycleMode` is **shift+tab**. On Windows it falls back to **meta+m** (alt+m) when the runtime's Node/Bun version lacks
  VT shift+tab support.

### 1.1 Default table

| Context (when active) | Chord → action |
|---|---|
| **Global** (everywhere) | ctrl+c app:interrupt · ctrl+d app:exit · ctrl+t app:toggleTodos · ctrl+o app:toggleTranscript · ctrl+shift+b app:toggleBrief · ctrl+r history:search · ctrl+up / meta+up app:diffFileListUp · ctrl+down / meta+down app:diffFileListDown · ctrl+] app:openArtifact |
| **Chat** (input focused) | escape chat:cancel · ctrl+l chat:clearInput · cmd+k chat:clearScreen · ctrl+x ctrl+k chat:killAgents · shift+tab (or meta+m) chat:cycleMode · meta+p chat:modelPicker · meta+o chat:fastMode · ctrl+y chat:defaultToNewerModel · meta+t chat:thinkingToggle · meta+w chat:workflowKeywordToggle · enter chat:submit · ctrl+x enter chat:queueSubmit · ctrl+x ctrl+s / ctrl+enter chat:sendNow · ctrl+j chat:newline · up history:previous · down history:next · ctrl+_ / ctrl+- / ctrl+shift+- / ctrl+shift+_ chat:undo · ctrl+x ctrl+e / ctrl+g chat:externalEditor · ctrl+x ctrl+a abovePrompt:toggle · ctrl+x tab abovePrompt:focus · ctrl+s chat:stash · alt+v (Win) / ctrl+v chat:imagePaste · space voice:pushToTalk |
| **Autocomplete** (menu visible) | tab accept · escape dismiss · up previous · down next |
| **Confirmation** (permission or confirm dialog) | enter confirm:yes · escape confirm:no · up/down previous/next · tab confirm:nextField · space confirm:toggle · shift+tab confirm:cycleMode |
| **Transcript** (ctrl+o view) | ctrl+e toggleShowAll · ctrl+c / escape / q exit · ctrl+u/ctrl+d half page · ctrl+b/ctrl+f/b/space full page · ctrl+p/ctrl+n/k/j/up/down line · g/home top · shift+g/end bottom |
| **HistorySearch** (ctrl+r) | ctrl+r next · escape / tab accept (into the input) · enter **execute** (submits) · ctrl+c cancel · ctrl+s cycleScope |
| **Task** (foreground task or agent running) | ctrl+b / ctrl+x ctrl+b task:background |
| **Settings** | escape no · up/k/ctrl+p previous · down/j/ctrl+n next · home/end · pageup/pagedown · space/enter accept · / search · r retry · d day · w week · f fixUsage · t sortByTokens · ctrl+u/ctrl+d scroll |
| **Tabs** | tab/right next · shift+tab/left previous |
| **Select** (list) | up/k/ctrl+p · down/j/ctrl+n · pageup/pagedown · home/end · enter accept · escape cancel |
| **Attachments** | right/left next/previous · backspace/delete remove · down/escape exit |
| **Footer** (indicators focused) | up/ctrl+p · down/ctrl+n · left/right · enter openSelected · escape clearSelection · x close |
| **Scroll** (fullscreen layout) | pageup/pagedown · wheelup/wheeldown · ctrl+home/ctrl+end · ctrl+shift+c / cmd+c copy · shift+arrows / shift+home / shift+end extend the selection |
| **DiffDialog** | escape dismiss · left/right source · up/k down/j file · pageup/pagedown/space/shift+space/b · g/shift+g/home/end |
| **DiffPanel** | ctrl+x b cycleDiffBase |
| **ModelPicker** | left/right effort · s thisSessionOnly |
| **EffortSlider** | left/right effort · tab toggleUltracode · s thisSessionOnly |
| **ThemePicker** | ctrl+t syntax highlighting · ctrl+e editCustom |
| **Help** | escape dismiss |
| **FeedbackSurvey** | ctrl+x 1 / 2 / 3 bad / fine / good |
| **Plugin** | space toggle · i install · f favorite · ctrl+s cycleMarketplace |
| **Agents** (`claude agents`) | ctrl+s switchView · ctrl+t togglePin · ctrl+f find · ctrl+r rename · ctrl/meta+up/down group |
| **AbovePrompt / AbovePromptInput / AbovePromptSelect / Pane / PaneField** (plugin panels) | tab/shift+tab/left/right next/previous · enter/space press · escape leave · up/down/pageup/pagedown/home/end pane scroll · ctrl+x left/up grow · ctrl+x right/down shrink · ctrl+x x close |
| **MessageSelector** (rewind) | [obs] legacy `messageSelector:*` actions are mapped to `select:*`, so it uses the Select keys |

Actions with no default chord [obs, from `fLe`]: app:toggleReplTab, app:toggleDiffNoiseFilter, app:toggleDiffPreSession,
app:toggleTerminal, app:redraw, strip:jump1–9/next/previous/tabNext/tabPrevious/viewAll/toggle/new, chat:cycleProactivity,
chat:attentionUp/Down, chat:increaseEffort/decreaseEffort, permission:toggleDebug, selection:clear, footer:dismiss,
pane:next/previous, diff:back, agents:setGroup, proactivityMenu:*.

Reserved keys [obs]:
- **Errors** (cannot be bound): ctrl+c, ctrl+d, ctrl+m (=Enter), ctrl+[ (=Esc), ctrl+i (=Tab), ctrl+h (=Backspace),
  capslock, ctrl+\\.
- **Warning:** ctrl+z (SIGTSTP).
- **macOS only:** cmd+c/v/x/q/w/tab/space.

### 1.2 The `?` shortcuts panel [obs]

The panel lists:
- `! for shell mode`
- `/ for commands`
- `@ for file paths`
- `/btw for side question`
- `double tap esc to clear input`
- the chord for "auto-accept edits"
- the chord "for verbose output"
- "toggle tasks"
- ctrl+_ "undo"
- ctrl+z "suspend"
- "paste images"
- "switch model"
- "toggle fast mode"
- "stash prompt"
- "edit in $EDITOR"
- "/keybindings to customize"

The footer hint reads `? for shortcuts`.

---

## 2. Prompt input

### 2.1 Modes

- [obs] The input has only two modes, `prompt` and `bash`.
- [obs] Typing or pasting `!` into an empty prompt switches to bash mode and **strips the `!`**. Backspace on an empty
  bash input returns to prompt mode.
- [obs] Bash-mode autocomplete offers up to 50 earlier `!` commands, taken from history (`shellHistoryCommands`).
- [inf] `#` memory mode is gone in 2.1.309: there is no "memorize" string. `&` as a mode prefix: [unk], with no evidence of
  it. Background work is Ctrl+B instead.
- [obs] The `/btw` side question is advertised in the shortcuts panel and in spinner tips.

### 2.2 Slash autocomplete [obs]

- Opens on a leading `/`.
- Tab accepts, ↑↓ move, Esc dismisses (Autocomplete context).
- An argument row exists (`command-arg-*`), so it can complete command arguments.
- Suggestions also cover `/resume` titles (`resume-title-*`).

### 2.3 @-mentions [obs] (`ece()`)

One merged list, at most **15 rows** (`AU=15`), with descriptions clipped to 60 characters:

| Type | Display | Inserted |
|---|---|---|
| file | relative path | `@path` (folders keep the picker open) |
| mcp_resource | `server:uri` | `@server:uri` |
| mcp_resource_template | `server:{template}` | partial; a second step completes the template value (`mcp-template-value::*`) |
| agent | `<agentType> (agent)`, coloured per agent, description = `whenToUse` | `@agent-<type>` |

- **Ranking:** files keep their own score. MCP items and agents are matched with Fuse (threshold 0.6; weights: name 3,
  agentType 3, displayText 2, uriTemplate 2, server 1, description 1). MCP resources get a +0.15 penalty, so they rank
  lower.
- **Empty query:** the list shows files, then resources, then templates, then agents.

### 2.4 History

- [obs] ↑/↓ = history:previous/next. [inf] The CLI reads history from `~/.claude/history.jsonl` (`kDr`), which is shared
  by every terminal session.
- [obs] **Ctrl+R** opens a picker titled `Search prompts · <scope>`. `wDr=["session","project","everywhere"]`, and
  **ctrl+s** cycles the scope.
- [obs] **Matching:** substring matches first, then subsequence (fuzzy) matches. The fuzzy pass is skipped while the
  history is still being scanned.
- [obs] **Layout:**
  - Each row shows a timestamp column and the first line of the prompt.
  - A preview pane sits on the right when the terminal is at least 100 columns wide, otherwise at the bottom.
  - The placeholder is `Filter history…`.
- [obs] **Empty or status messages:** `No history yet` · `No matching prompts` · `Searching older prompts…` ·
  `Couldn't read prompt history` · `· newest N only` (when the scan is truncated).
- [obs] **Keys:** Enter = **execute** (submit right away) · Tab/Esc = put the prompt into the input · ctrl+c = cancel.

### 2.5 Entry editing

- **Newlines:**
  - [obs] ctrl+j = newline.
  - [obs] The changelog says "Enter submits and Shift+Enter or a backslash before Enter starts a new line".
  - [obs] **ctrl+enter = sendNow** (not a newline).
- **Undo:** [obs] ctrl+_ / ctrl+- = undo.
- **Image paste:**
  - [obs] alt+v on Windows (ctrl+v elsewhere).
  - [obs] Inserts an `[Image #N]` placeholder token in the text. An Attachments context lets ←→ walk the images and
    Backspace remove one.
  - [obs] A failed image shows `[Image could not be processed: …]`.
  - [obs] A large text paste collapses to `[Pasted text #N …]`.
- **External editor:** [obs] ctrl+g or ctrl+x ctrl+e opens `$EDITOR` and shows `Save and close editor to continue...`.
  On failure: `External editor failed: …`.
- **Stash:**
  - [obs] ctrl+s stashes the prompt (`stashedPrompt`).
  - [obs] When there is nothing to stash: `Nothing was stashed: …`.
  - [inf] The stash pops back into the input after the next submit (`popStash`).
- **Vim mode:**
  - [obs] Enabled with the `editorMode: "vim"` setting.
  - [obs] Shows `-- INSERT --` / `-- VISUAL --` below the prompt, hidden by `statusLine.hideVimModeIndicator`.
  - [obs] The vim mode is passed to the status line JSON as `vim.mode`.
  - [obs] In vim, history search hints `Esc i / for slash commands`.
- **Clear:** [obs] ctrl+l clears the input; Esc Esc on a non-empty input clears it too (`Esc again to clear`).
- **Queueing:**
  - [obs] chat:queueSubmit (ctrl+x enter) and chat:sendNow (ctrl+enter, ctrl+x ctrl+s) exist.
  - [obs] Hint text exists: `enter to interrupt and send · ctrl+x then enter to queue` (in a `focus_mode`
    module).
  - [unk] Whether plain Enter queues or interrupts during a turn by default.
- **Push-to-talk:** [obs] space = voice:pushToTalk (only when voice is on).

---

## 3. While a turn runs (spinner, `chunk-ca8hrd0z.js`)

- [obs] **Verbs:** `W6t()` returns a random verb from **187 built-ins**:
  - The list starts Accomplishing, Actioning, Actualizing, Architecting, Baking … Clauding … Zesting, Zigzagging.
  - The full array `v` is in `chunk-cvr9pg8n.js`.
  - The `spinnerVerbs` setting is `{mode:"replace"|"append", verbs:[]}`.
- [obs] **Completion line verbs:** Baked, Brewed, Churned, Cogitated, Cooked, Crunched, Sautéed, Worked. The verb is
  picked by hashing, with "Worked" as the fallback. [inf] The line reads `<Verb> for <duration>`.
- [obs] **Line layout:** `<verb>…` followed by dim `(` + parts joined with ` · ` + `)`. The parts are:
  - the elapsed time (`un(ms)`, e.g. `12s`, `1m 3s`)
  - `↓ N tokens` (**down arrow**; N = streamed response length ÷ 4, animated)
  - the thinking status
  - suffixes
- [obs] **Thinking status** escalates with time: `thinking` → `still thinking` (10 s) → `thinking more` (20 s) →
  `thinking some more` (30 s) → `deep in thought` (45 s).
  - The effort suffix `Kfn()` appends ` with <level> effort`, e.g. **`thinking with high effort`**.
  - After thinking: `thought for Ns`.
  - During tools: `running tool for Xs` / `ran tool for Xs`.
  - Recovery: `picking the thought back up (n of m)`.
- [obs] **Stall and retry:**
  - A stall turns the spinner to warning colour.
  - `Waiting for API response`
  - `No response from the API after X`
  - ` · Retrying in X · attempt n/m`
  - ` · will retry in X · check your network`
  - `Reconnecting` / `Disconnected`
  - `<limit> reached` (usage limit)
- [obs] **Below the spinner:**
  - `Next: <next todo subject>`
  - `N in background`
  - `Tip: …`, for example "Use /btw to ask a quick side question without interrupting Claude's current work" or
    "Use /clear to start fresh when switching topics and free up context"
- **Ctrl+O:** [obs] transcript mode (verbose; ctrl+e show all; q/Esc exits).
- **Ctrl+T:** [obs] toggles the todo list.
- **Ctrl+B:** [obs] task:background backgrounds the foreground Bash or agent. SDK: `backgroundTasks(toolUseId?)`.
- **Esc:** [obs] chat:cancel interrupts the turn. Ctrl+C interrupts too; [inf] pressing it again on an idle prompt exits
  (`Press … again to exit`).
- **Double Esc:**
  - [obs] On an empty input it opens **rewind**: "Double-tap esc to rewind the code and/or conversation to a previous
    point in time".
  - [obs] The rewind options: `Restore code and conversation` / `Restore conversation` / `Restore code` /
    `Summarize from here` / `Summarize up to here` / `Never mind`.
  - [obs] On non-empty input, double Esc clears it.

---

## 4. Footer and status line

- **Mode indicator:**
  - [obs] Table `fa`:

    | Mode | Title | Indicator |
    |---|---|---|
    | default | Manual | manual mode |
    | acceptEdits | Accept edits | accept edits |
    | plan | Plan | plan mode |
    | auto | Auto | auto mode |
    | bypassPermissions | Bypass Permissions | bypass permissions |
    | dontAsk | Don't Ask | don't ask |

  - [obs] The footer renders `<symbol> <indicator> on` (⏵⏵ for edit modes, ⏸ for plan), plus a `shift+tab` "cycle" hint.
  - [obs] The colours are autoAccept, planMode, warning (auto) and error (bypass).
  - [inf] Default mode shows nothing (empty symbol).
- **Context warnings:**
  - [obs] `N% until auto-compact`, or `N% context used` when auto-compact is off.
  - [obs] Low context: `Context low (N% remaining) · Run /compact to compact & continue`.
  - [obs] There is also a memory warning: `Critical memory usage (…) — restart and resume with claude --continue`.
- **Notifications:** [obs] `addNotification({key, kind, text, priority: low|medium|high|immediate})`.
  SDK: `SDKNotificationMessage {key, text, priority, color?, timeout_ms?}`.
- **Custom status line:**
  - [obs] Settings: `statusLine: {type:"command", command, padding?, refreshInterval? (s, ≥1), hideVimModeIndicator?}`.
  - [obs] Re-runs when any of these change: tokenUsage, permissionMode, vimMode, mainLoopModel, fastMode, effortValue,
    thinkingEnabled, prStatus, or a new assistant message. It also re-runs every `refreshInterval` seconds and at the
    rate-limit and prompt-cache expiry times.
  - [obs] **stdin JSON:** the base hook fields (`session_id`, `transcript_path`, `cwd`, `permission_mode`…) plus:
    - `session_name?`
    - `model{id,display_name}`
    - `workspace{current_dir,project_dir,added_dirs,git_worktree?,repo?}`
    - `version`
    - `output_style{name}`
    - `cost{total_cost_usd,total_duration_ms,total_api_duration_ms,total_lines_added,total_lines_removed}`
    - `context_window{total_input_tokens,total_output_tokens,context_window_size,current_usage,used_percentage,remaining_percentage}`
    - `exceeds_200k_tokens`
    - `prompt_cache{warm,ttl,expires_at,hit_ratio,…}?`
    - `fast_mode`
    - `effort{level}?`
    - `thinking{enabled}`
    - `rate_limits{five_hour,seven_day,spend_limit}{used_percentage,resets_at}?`
    - `vim{mode}?`
    - `agent{name}?`
    - `remote{session_id}?`
    - `pr{number,url,review_state?,kind?}?`
    - `worktree{name,path,branch,original_cwd,original_branch}?`

---

## 5. Dialogs

### 5.1 Permission dialogs [obs unless marked]

Shared rules:
- The last option is always `No, and tell Claude what to do differently (esc)`. When typing is enabled, the input
  placeholder is `and tell Claude what to do differently`.
- Yes can carry feedback too (`yesInputMode`, Tab = confirm:nextField).
- Shift+Tab = confirm:cycleMode: accept and switch mode.

| Tool | Header / question | Options (value → scope) |
|---|---|---|
| **Bash / PowerShell** | title "Bash command", the command plus its description, `Do you want to proceed?` | `Yes` · `Yes, and don't ask again for <prefix…> commands in <cwd>` (addRules → **localSettings**). When reads are also needed: `… and always allow access to <dirs> from this project` / `Yes, allow reading from <dirs> from this project` · `No, and tell Claude…` |
| **Edit / MultiEdit** | title "Edit file", subtitle = path, `Do you want to make this edit to <file>?`, coloured diff. An edit too large to show is one-time only, with the message "Proposed edit is too large to show — cannot be reviewed…" | `Yes` · `Yes, and switch to <Accept edits> for this session (shift+tab)` (setMode acceptEdits → **session**, possibly merged with addDirectories) · inside `.claude`: `Yes, and allow Claude to edit files in this project's .claude folder for this session` / `…in its ~/.claude folder…` · `No, and tell Claude…` |
| **Write** | title "Create file" / "Overwrite file", [inf] `Do you want to create <file>?` | same as Edit |
| **Read outside the workspace** | — | `Yes, allow reading from <dirs> during this session` (**session**) · `Yes, and keep allowing any reads outside the working directories` · `No, and block reads outside the working directories from now on` |
| **WebFetch** | title "Fetch", `Host:` plus the URL, `Do you want to allow Claude to fetch this content?` | `Yes` · `Yes, and don't ask again for <hostname>` (rule `WebFetch(domain:host)` → **localSettings**; hidden for wildcard hosts or a safety-check reason) · `No, and tell Claude…` |
| **MCP / other tools** | tool name plus input | `Yes` · `Yes, and don't ask again for <server - tool> commands in <cwd>` (tool-wide rule → **localSettings**) · `No, and tell Claude…` |
| **Skill** | — | `Yes, and don't ask again for <skill> in <cwd>` (localSettings) |
| **EnterPlanMode** | `Enter plan mode?` | `Yes, enter plan mode` · `No, start implementing now` |

### 5.2 ExitPlanMode [obs]

- **Header:** `Ready to code?` and `Here is Claude's plan:`.
- **Options:**
  - First, one of: `Yes, clear context (N% used) and auto-accept edits`, `…and use auto mode` or
    `…and bypass permissions`.
  - Then `Yes, auto-accept edits`, or a resume-auto or bypass row when those modes are available.
  - Then `Yes, manually approve edits`.
  - Then `No, refine with Ultraplan in a cloud session` (optional).
  - Last, `No, keep planning`, an input row with the placeholder `Tell Claude what to change` and the hint
    `shift+tab to approve with this feedback`.
- **Large plan:** a plan over 200k characters withholds approval.

### 5.3 AskUserQuestion [obs]

- **Navigation:** a tab header per question (Tabs context, ←/→).
- **Options:** each question lists its options, then an `Other` input row with the placeholder `Type something.`.
  Single-select questions add `Chat about this` (conditional).
- **Previews:** options with previews show a side preview, a `n` "add notes" key and `Notes:` with the placeholder
  `Add notes on this design…`.
- **Submit:** a final `Review your answers` tab lists each `question → answer` and asks `Ready to submit your answers?`
  with **Submit answers** / **Cancel**. If questions are open it warns `You have not answered all questions`.
- **Hints:** `enter select · ↑↓ navigate`.

### 5.4 Trust dialog [obs]

- **Text:** `Accessing workspace:` + path, then "Quick safety check: Is this a project you created or one you trust?
  (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's
  in this folder first." and "Claude Code'll be able to read, edit, and execute files here."
- **Pre-approvals:** it lists what the folder pre-approves (rules, directories, sources).
- **Buttons:** `Yes, I trust this folder` / `No, exit`.

### 5.5 MCP elicitation [obs]

- **Form mode:** `MCP server "X" requests your input` with fields, and the buttons ` Accept ` / ` Decline`.
  Esc cancels. "(press an arrow key to choose)".
- **URL mode:** `MCP server "X" wants to open a URL`, then ` Reopen URL ` / ` Cancel`, then
  `Waiting for the server to confirm completion…` and `Continue without waiting`.
- **SDK:**
  - `onElicitation(request{serverName, mode:'form'|'url', message, requestedSchema?, url?, elicitationId?, title?}) →
    ElicitResult{action:'accept'|'decline'|'cancel', content?}`
  - `SDKElicitationCompleteMessage`
  - the `Elicitation` and `ElicitationResult` hooks

---

## 6. Waifufy Code today vs the CLI: gaps

The **Have** column is what the app does today [obs, from the app code]. **Gap** is what is missing or different, and
**Route** is how to close it.

### 6.1 Keys

| # | Area | Have | Gap | Route |
|---|---|---|---|---|
| K1 | Enter / Shift+Enter / `\`+Enter | yes | — | — |
| K2 | **Ctrl+Enter** | inserts a newline | CLI = **sendNow** (send at once while busy). Alt/Meta+Enter newline is fine | APP |
| K3 | **Ctrl+J** newline | not handled (WebView2 may open Downloads) | add as newline, preventDefault | APP |
| K4 | **Ctrl+L** | opens the backlog | CLI = clear input. Make Ctrl+O the backlog (transcript) and Ctrl+L clear the composer, or keep it and say so in /help | APP |
| K5 | Ctrl+O transcript | opens the backlog (LOG) | no verbose toggle (ctrl+e show all), no q/j/k/g/G scroll keys | APP |
| K6 | **Ctrl+T** todos | none (the quest log is always visible) | toggle the quest panel | APP |
| K7 | **Ctrl+B** background | none | background the running Bash or agent | SDK `backgroundTasks(toolUseId?)` (add to CTL_OPS) |
| K8 | Ctrl+C | interrupt / clear draft | no "press again to exit" on an idle prompt; Ctrl+D exit missing | APP |
| K9 | Ctrl+_ undo | native textarea Ctrl+Z | Ctrl+_ / Ctrl+- not mapped | APP |
| K10 | **Ctrl+G** external editor | none | open the draft in `$EDITOR`/`code --wait`, read it back | APP + link (spawn the editor, temp file) |
| K11 | **Ctrl+S** stash | none | stash the draft, restore it after the next submit | APP |
| K12 | Alt+V image paste | Ctrl+V paste or drop works | Alt+V (the CLI key on Windows) does nothing; map it to `navigator.clipboard.read()` | APP |
| K13 | Alt+P / Alt+T / Alt+O | none | model picker / thinking toggle / fast mode | APP + SDK `setModel`, `setMaxThinkingTokens`, `applyFlagSettings({fastMode})` |
| K14 | Ctrl+X Ctrl+K kill agents | none | stop every background agent | SDK `stopTask(id)` for each |
| K15 | Ctrl+X Enter queue | Enter queues while busy | fine. Add it as an alias | APP |
| K16 | `~/.claude/keybindings.json` | ignored | the user's rebinds and `command:*` bindings | FILE (read it, map the chords onto the app's handlers) |
| K17 | Shortcuts panel `?` | /help lists 12 keys | no `?` on an empty prompt; missing entries such as /btw | APP |
| K18 | Double Esc on an empty prompt | nothing | **rewind** (§3) | SDK `rewindFiles(userMessageId)` (code) + `resumeSessionAt` / `forkSession` (conversation); the "Summarize" rows are TEXT `/compact`-like [inf] |
| K19 | Shift+Tab cycle | yes (default → acceptEdits → plan → bypass → auto) | the mode is called "Manual" in the CLI now; the footer reads `⏵⏵ accept edits on` | APP (labels) |

### 6.2 Prompt input

| # | Area | Have | Gap | Route |
|---|---|---|---|---|
| P1 | `!` bash mode | `!` stays in the text, the badge shows bash | no autocomplete from earlier `!` commands. Backspace-to-exit semantics differ (cosmetic) | APP (filter history for `!`) |
| P2 | Slash picker | ranked, aliases, app commands | no argument completion (`command-arg`). No `/resume` title completion | APP + SDK `supportedCommands` (argumentHint) |
| P3 | @ files | link `files` index, 8 rows | **no agents** (`@agent-<type>`), **no MCP resources** (`@server:uri`) or templates. 8 rows, not 15 | SDK `supportedAgents()`; MCP resources via `mcpServerStatus()` + `readMcpResource`; the link merges them into `files` hits |
| P4 | History store | localStorage per folder | not shared with the terminal's `~/.claude/history.jsonl`. No session/everywhere scope | FILE (the link reads history.jsonl) |
| P5 | Ctrl+R picker | substring, newest 50, ↑ older, Enter/Tab pick, Esc close | no **fuzzy** fallback, no **scope cycle (ctrl+s)**, no timestamps or preview. **Enter should execute**, while Tab/Esc put the prompt in the input (the app treats Esc as cancel) | APP + FILE |
| P6 | Images | thumbnails, max 5 | no `[Image #N]` token in the text, no ←→/Backspace attachment navigation | APP |
| P7 | Long paste | pasted verbatim | no `[Pasted text #N +L lines]` collapse | APP |
| P8 | Vim mode | none | `editorMode:"vim"` with the INSERT/NORMAL/VISUAL indicator | APP (read settings.json `editorMode`) |
| P9 | Prompt suggestions | none | greyed next-prompt suggestion | SDK `promptSuggestions: true` → `SDKPromptSuggestionMessage` |
| P10 | `/btw` | sent as text | [inf] works as TEXT; check whether headless returns the side answer | TEXT |

### 6.3 Running turn

| # | Area | Have | Gap | Route |
|---|---|---|---|---|
| R1 | Spinner verb | fixed phase verbs ("thinking", "working"…) | no random verb from the 187-verb list, no `spinnerVerbs` setting. Keep her phrasing but use the CLI list | APP + FILE (settings `spinnerVerbs`) |
| R2 | Token counter | `↑ N tokens` (output) | the CLI uses **↓**, and N = response chars ÷ 4 | APP |
| R3 | Thinking status | none | `thinking with high effort`, the 10/20/30/45 s escalation, `thought for Ns`, `running tool for Xs` | link: effort from `initializationResult` / settings; thinking deltas from `stream_event` |
| R4 | Completion line | none | `<Baked/Brewed/…> for 1m 3s` after the turn | APP (`turn_end.seconds`) |
| R5 | Retry / stall | retry note | stall colour, `Waiting for API response`, `No response from the API after X` | APP (no-delta timer) |
| R6 | Next todo + tips | none | `Next: <todo>` under the spinner, rotating tips | APP |
| R7 | Background count | party panel | `N in background` | SDK `SDKBackgroundTasksChangedMessage` |

### 6.4 Footer and status

| # | Area | Have | Gap | Route |
|---|---|---|---|---|
| F1 | Context warning | gauge with % | no `N% until auto-compact` / `Context low (N% remaining) · Run /compact…` in-character warning | APP + SDK `getContextUsage` |
| F2 | Notifications | none | `SDKNotificationMessage` is ignored (session.ts has no `notification` case) | SDK → toast or narration by priority |
| F3 | Custom statusLine | none | run the user's `statusLine.command` with the JSON above, show its output (ANSI) | FILE (settings) + link builds the JSON from SDK data (`getContextUsage`, result cost, `rate_limit_event`, mode, model); `refreshInterval` timer. Some fields (`prompt_cache`, `pr`) [unk] headless |

### 6.5 Dialogs

| # | Area | Have | Gap | Route |
|---|---|---|---|---|
| D1 | Permission labels | generic `Yes` / `Yes, and don't ask again` (+ "Saves: …") / `No` / free text | Use the CLI's labels per tool (§5.1), e.g. `Yes, and don't ask again for npm run commands in ~/x`, `Yes, and switch to Accept edits for this session (shift+tab)`, `No, and tell Claude what to do differently (esc)`. Labels can come from `suggestions` (rule, destination). The question line (`Do you want to make this edit to X?`) is missing | link `describeAlways` → per-type labels |
| D2 | Several suggestion rows | one "always" row applies **all** suggestions | the CLI shows separate rows (session mode switch vs localSettings rule vs addDirectories) | SDK `updatedPermissions` subset per row |
| D3 | Shift+Tab inside a permission | none | accept and switch to acceptEdits | APP: allow + `setMode` session update |
| D4 | Feedback on Yes | none (only No) | Tab adds feedback to an approval | SDK `allow` + message [unk: whether `PermissionResult` allow carries a message] |
| D5 | Read-outside-workspace prompt | generic | the 3 special rows (§5.1) | link |
| D6 | ExitPlanMode | auto / manual / keep + text | no **clear context (N% used)** row, no bypass/auto variants, no `shift+tab to approve with this feedback`, title not "Ready to code?" | clear context: APP approximation (approve, then a fresh session seeded with the plan) [inf]; others SDK `setMode` |
| D7 | EnterPlanMode | generic permission | `Enter plan mode?` with `Yes, enter plan mode` / `No, start implementing now` | link (special-case the tool) |
| D8 | AskUserQuestion | sequential steps, Other, multi-select Confirm, preview | no tab header with back/forward, no **Review your answers / Submit answers / Cancel**, no `Chat about this`, no preview **notes** (`n`) | APP; notes and annotations via the answer payload [unk: field name] |
| D9 | Trust dialog | yes (same text and buttons, plus concerns) | matches; the CLI also lists pre-approved rules and dirs in detail | — |
| D10 | **MCP elicitation** | **none** (an elicitation hangs until the server times out) | form dialog (Accept / Decline / Esc cancel) and URL dialog (Reopen URL / Cancel / Continue without waiting) | SDK `onElicitation` option + `SDKElicitationCompleteMessage`; render `requestedSchema` as a VN form |

### 6.6 Priorities (inferred)

- **P0:** D10 elicitation (an MCP call can hang today), K2/K4 key conflicts, D1 labels, F2 notifications, P3 @agents /
  MCP resources.
- **P1:** K18 rewind, P5 Ctrl+R semantics, R3 thinking/effort line, D6/D8 dialog parity, K7 Ctrl+B, F1 warnings.
- **P2:** K10 editor, K11 stash, P8 vim, F3 statusLine, K16 keybindings.json, R1/R4 verbs.
