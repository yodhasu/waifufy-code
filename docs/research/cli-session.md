# CLI session and conversation-flow commands (Claude Code 2.1.309)

Scope: /resume, rewind/checkpoints, /export, /copy, /diff, /branch, /fork, /rename, /tasks, /background, /stop, /compact,
/clear, /btw, /plan, /goal, /loops, /workflows, /recap, /session, /exit, /help, /feedback, /bug, /init, /insights,
/ultraplan, /ultrareview, queued messages and steering, the background tasks UI (Ctrl+B, tasks panel).

Labels: **[obs]** observed in the CLI bundle or SDK files, **[inf]** inferred, **[unk]** unknown.
Chunk names are under the extracted `cc\` folder. SDK = `link/node_modules/@anthropic-ai/claude-agent-sdk` 0.3.309.

## 0. Things every route below relies on

| Fact | Label | Source |
|---|---|---|
| `_e()` = "not interactive" (SDK/print). Commands with `isEnabled:()=>_e()` are SDK-only (headless) variants. `Pn()` = remote (cloud) workspace. `Ht()` = this process is a background job ("bg session"). `xa()` = coordinator mode. `bk()` = fleet (background sessions) enabled. | obs | chunk-kxne69v8, chunk-hmek16m8 |
| In SDK mode, `local-jsx` commands without a headless twin only answer "opens an interactive panel" or a text fallback. `type:"local"` commands with `supportsNonInteractive:!0` and `type:"prompt"` commands run when their text is sent. | obs (brief) / obs | chunk-ktgr2fgq |
| The SDK runtime `Query` (sdk.mjs) has **undocumented methods** not in sdk.d.ts: `askSideQuestion(q,{history,signal})`, `getPlan()`, `getTaskOutput(taskId)`, `cancelAsyncMessage(uuid)`, `exportConversation()`, `submitFeedback(desc,{type,title,area,attach_transcript,save_locally,surface,draft_id})`, `generateSessionTitle(desc,{persist})`, `renameSession(title, sessionId)`, `launchUltrareview(args,{confirm})`, `messageRated(...)`, `getStatus()`. Each sends a control request the CLI's headless loop handles (chunk-wsjv31yy). They can change without notice. | obs | sdk.mjs, chunk-wsjv31yy |
| The headless loop also handles `rewind_conversation`, `fork_conversation`, `get_workspace_diff`, `end_session`, and a whole `ui_*` family (`ui_attach`, `ui_render`, `ui_press`...: a host-rendered UI protocol). None has a `Query` method. The only path is the private `request()`; `readCloudSessions(req)` passes any request object through. That is a hack: use it only behind a feature check. | obs | chunk-wsjv31yy, sdk.mjs |
| Documented options that matter here: `resume`, `continue`, `forkSession`, `sessionId`, `resumeSessionAt`, `resumeDropsTurn`, `enableFileCheckpointing` (the app sets it to true), `persistSession`, `agentProgressSummaries`, `perTaskStopAffordance`, `onUserDialog` + `supportedDialogKinds`. Functions: `listSessions`, `getSessionInfo`, `getSessionMessages`, `getSubagentMessages`, `listSubagents`, `forkSession`, `renameSession`, `tagSession`, `deleteSession`. | obs | sdk.d.ts |
| **`perTaskStopAffordance`**: when it is not declared, an `interrupt()` **kills running background tasks**. The app should declare it once it ships a per-task stop control. | obs | sdk.d.ts:1844 |
| SDK user messages take `priority: 'now' \| 'next' \| 'later'`. The CLI's "send now" sets `priority="now"`. Resurrected "now" items are demoted to "next". | obs (CLI sets "now" in chunk-ktgr2fgq) | sdk.d.ts:6543 |

## 1. Default key bindings relevant to this scope [obs] (chunk-8nwra1mk)

| Context | Chord | Action |
|---|---|---|
| Global | ctrl+c | app:interrupt (not rebindable) |
| Global | ctrl+d | app:exit (not rebindable) |
| Global | ctrl+t | app:toggleTodos ("toggle tasks" in help) |
| Global | ctrl+o | app:toggleTranscript ("verbose output") |
| Global | ctrl+r | history:search |
| Chat | escape | chat:cancel (interrupt a running turn) |
| Chat | enter / ctrl+x enter | chat:submit / chat:queueSubmit |
| Chat | ctrl+enter, ctrl+x ctrl+s | chat:sendNow |
| Chat | ctrl+x ctrl+k | chat:killAgents (double press: "Press … again to stop background agents"; "No background agents running") |
| Chat | ctrl+s | chat:stash ("Draft restored" when it comes back) |
| Chat | ctrl+_ / ctrl+- | chat:undo |
| Chat | ctrl+g, ctrl+x ctrl+e | chat:externalEditor |
| Chat | up / down | history:previous / next (also picks queued messages, see §6) |
| Task | ctrl+b, ctrl+x ctrl+b | task:background (tmux: hint shows "ctrl+b ctrl+b") |
| Confirmation | enter / escape / up / down / tab / space | confirm:yes / no / previous / next / nextField / toggle |
| Select | up/down, j/k, ctrl+n/p, pgup/pgdn, home/end, enter, escape | select:* |
| DiffDialog | escape, left/right, up/down, j/k, pgup/pgdn, space, b, g/G | diff:dismiss, previous/nextSource, previous/nextFile, scroll:* |
| Footer | up/down/ctrl+p/n, left/right, enter, escape, x | footer:up/down/previous/next/openSelected/clearSelection/close |
| Help | escape | help:dismiss |
| Rewind | **Esc Esc** (double press on the idle prompt) | opens the message selector (`S6(…, openMessageSelector)`). With text in the input, double Esc clears the input instead (help hint "double tap esc to clear input"). |

App route for all of these: the app's own keyboard layer. The ones with an SDK effect: Esc → `interrupt()`. Ctrl+B → `backgroundTasks()`. Ctrl+Enter → send with `priority:'now'`. Ctrl+X Ctrl+K → `stopTask(id)` for each agent task.

## 2. Per-command spec

### /resume (alias /continue): "Resume a previous conversation"; arg `[conversation id or search term]` [obs] (chunk-ayvjarhw, chunk-j68kr6y8)

- **With an arg:**
  - A UUID resumes that session. If its log is not in the project list, the CLI loads it by id.
  - Otherwise it looks for an exact title match (gated). One hit resumes it.
  - Errors: "Found N sessions matching X. Please use /resume to pick a specific session." / "Session X was not found." / "No conversations found to resume."
- **Picker screen**, a dialog with color "suggestion":
  - Title "Resume session", then " (i of N)" when the list scrolls, and " · Refreshing…" while it loads.
  - Below the title: a search line, a dim filter line (current repo · branch · worktree), and the list.
  - While it loads: "Loading conversations…"; after a pick: "Resuming conversation…".
- **List rows** (one label line plus one dim description line):
  - Label: `agentName || customTitle || aiTitle || summary || firstPrompt || sessionId[0..8]` (or "Autonomous session"). Suffixes: " (sidechain)", group header " (+N other session(s))", and an artifact count.
  - Description: `<modified, short> · [bg] · <gitBranch> · <file size or "N messages"> · #tag · @agent · repo#PR`, plus " · <projectPath>" when all projects are shown, plus a search-snippet line with the match highlighted.
  - Rows sharing a session id form a collapsible group: ▶ / ▼, ← "collapse", → "expand".
- **Filters:**
  - Hidden: sidechains and the current session.
  - Default scope is the current repo or worktree.
  - Branch filter starts **off**; Ctrl+B turns it on.
  - Paging: more rows load as the focus nears the end.
- **Footer (list mode):**
  - Keys: `ctrl+a` "show all projects" / "only show current repo", `ctrl+b` "only show current branch" / "show all branches", `ctrl+w` "only show current worktree" / "show all worktrees" (only when worktrees exist), `space` (or ctrl+v) "preview", `ctrl+r` "rename", "Type to search", `Esc` "cancel", ←/→ collapse/expand.
  - `/` or any printable key enters search.
  - Paste starts a search with the first pasted line.
- **Search mode:**
  - Footer: "Type to Search", `enter` "select", `Esc` "clear".
  - Matches title, branch, tag and "PR #n repo" at once. Full-text transcript search runs after 300 ms, with snippets.
  - "No sessions match "q"." when nothing matches.
  - ↑ from the first row enters search.
- **Rename mode:** "Rename session:" input (placeholder: current title or "Enter new session name"), `enter` "save", `Esc` "cancel".
- **Preview:**
  - Read-only transcript render.
  - Footer: `<relative modified> · N messages · <branch>`, `enter` "resume", `Esc` "cancel".
  - Shows "Loading session…" for lazy logs.
- **Empty state:** "No conversations found in this project." with hint `ctrl+a show all projects` (or "No conversations found.").
- **Other paths:**
  - Esc → "Resume cancelled".
  - Another directory → message: "This conversation is from a different directory. / To resume, run: / `cd <path> && claude --resume <id>` / (Command copied to clipboard)".
  - Live background session → "Opening <title>, running in the background (…)".
  - On a remote attach, /resume is refused with a fixed message.
- **SDK route:**
  - Picker data: `listSessions({dir})`, or no `dir` for all projects. It gives `summary, customTitle, firstPrompt, gitBranch, cwd, tag, fileSize, lastModified, createdAt`.
  - Preview and full-text search: `getSessionMessages(id,{dir})`.
  - Rename: `renameSession(id, title,{dir})`.
  - Open: start a new `query({options:{resume:id}})`.
  - Branch filter compares `gitBranch` with the current `git branch`. The worktree filter compares `cwd`.
  - Cross-directory pick: the app can simply switch cwd (better than the CLI's copy-command message).
  - The app already has a Save/Load page (`link/src/saves.ts`). It is missing [inf]: the branch/worktree/all-projects toggles, full-text search with snippets, preview, rename-in-picker, and grouping.

### Rewind / checkpoints: `/rewind` (aliases `/checkpoint`, `/undo`) and Esc Esc. "Restore the code and/or conversation to a previous point" [obs] (chunk-jp1q389n, chunk-6nsdtg9a ~411–423k)

- `/rewind` only emits the query event `open_message_selector`. It is `supportsNonInteractive:!1`, and the headless loop **drops** that event, so sending `/rewind` through the SDK does nothing [obs].
- **Screen 1, message list.**
  - Title "Rewind". Subtitle "Restore the code and/or conversation to the point before…", or "Restore and fork the conversation to the point before…" when there is no file history.
  - Rows (2 lines each when metadata loads): the user prompt text, then a dim line: `<file> +a −r`, or "N files changed +a −r", "No code changes", "⚠ No code restore".
  - The last row is "(current)", an empty marker for now.
  - After a /clear, the first row is "/resume <parentId> (previous session)".
  - Keys: `enter` "continue", `escape` "cancel". Empty: "Nothing to rewind to yet."
- **Screen 2, confirm.**
  - "Confirm you want to restore [the conversation ]to the point before you sent this message:" with the quoted message and "(<age>)".
  - Options when code changed: **"Restore code and conversation"** (default), **"Restore conversation"**, **"Restore code"**.
  - Otherwise only **"Restore conversation"**.
  - Also: **"Summarize from here"** and **"Summarize up to here"**. Both are inline inputs with placeholder "add context (optional)".
  - Last: **"Never mind"**.
  - The description line follows the focused option:
    - both / conversation: "The conversation will be forked."
    - code / nevermind: "The conversation will be unchanged."
    - summarize: "Messages after this point will be summarized."
    - summarize_up_to: "Preceding messages will be summarized. This and subsequent messages will remain unchanged — you will stay at the end of the conversation."
  - Code line: "The code will be restored +a −r in <f1>[ and f2 | and N other files]." / "The code has not changed (nothing will be restored)." / "The code will be unchanged."
  - Warning: "⚠ Rewinding does not affect files edited manually or via bash."
  - While it works: "Summarizing…".
- **Errors:**
  - "Failed to restore the conversation:", "Failed to restore the code:", "Failed to restore the conversation and code:", "Failed to summarize:".
  - "Restored the code, but skipped N file(s): … Skipped files were left untouched — run with --debug for the paths."
  - In cloud sessions: "Rewind is not yet available in cloud sessions".
- **SDK route:**
  - Rows: the user message uuids the app sends (it already stamps a `uuid`), or `getSessionMessages`.
  - Per-row stats: `rewindFiles(uuid,{dryRun:true})`, which gives `filesChanged/insertions/deletions`.
  - Restore code: `rewindFiles(uuid)`. It returns `skippedLinks` for the "skipped N files" message.
  - Restore conversation, documented path: `close()` the query and start a new one with `resume:<sid>, resumeSessionAt:<last entry uuid before the target message>, resumeDropsTurn:<target prompt uuid>`.
    - Map a refusal (`Resume rejected by --resume-drops-turn:`) to a plain resume.
    - Or `forkSession(sid,{upToMessageId})` and resume the new id. That matches the CLI's "will be forked" wording [inf].
    - Put the target message text back into the input (the CLI returns `prefillText`) [inf].
  - Undocumented alternative: raw `rewind_conversation {target_message_uuid, last_seen_user_message_uuid, interrupt_if_running}`. It answers `{rewound, targetMessageUuid, prefillText, precedingAssistantUuid}` [obs].
  - Summarize from / up to here: **not possible headless** (partial compaction has no SDK surface). The nearest is `/compact <instructions>`, which is a whole compaction, so offer it only as an approximation [inf].

### /export: "Export the current conversation to a file or clipboard"; arg `[filename]` [obs] (chunk-afn9rhz7)

- With an arg it writes directly. ".txt" is added when there is no extension. Relative paths start at the launch dir.
  - "Conversation exported to: <path>" / "Failed to export conversation: <err>".
- **Dialog:** title "Export conversation", subtitle "Select export method", color "permission".
  - Options: "Copy to clipboard" ("Copy the conversation to your system clipboard") → "Conversation copied to clipboard".
  - "Save to file" ("Save the conversation to a file in the current directory", or "… in the directory claude was launched from") → "Enter filename:" `> [default]`, `enter` "save", `Esc` "go back".
- Default filename: `YYYY-MM-DD-HHMMSS-<first-prompt-slug>.txt`, or `conversation-YYYY-MM-DD-HHMMSS.txt`.
- Esc → "Export cancelled".
- **SDK route:** undocumented `q.exportConversation()` returns the CLI's rendered text [obs; the handler can answer "not available in this build"]. Otherwise the app renders text from `getSessionMessages`. The app does the clipboard and file write itself.

### /copy: "Copy Claude's last response to clipboard (or /copy N for the Nth-latest)" [obs] (chunk-f4jz0brs)

- `/copy N` takes N=1 for the latest, and looks back at most 20 assistant messages.
  - Errors: "Usage: /copy [N] where N is 1 (latest), 2, 3, … Got: X", "Only N assistant message(s) available to copy", "No assistant message to copy".
- Markdown tables are re-padded.
- With no code blocks or quotes, or with `copyFullResponse` set, it copies at once.
- **Picker:** "Select content to copy:" with rows:
  - "Full response" (meta "N chars", "N lines").
  - One row per code block or quote (first line, meta "lang, N lines").
  - "Always copy full response" ("Skip this picker in the future (revert via /config)").
  - Keys: `enter` "copy", `w` "write to file" (or "write full response to file"), `escape` "cancel". Esc → "Copy cancelled".
- Result: "Copied to clipboard (N characters, M lines)\nAlso written to <tmp>/response.md" (or `copy.<ext>` / `copy.md`). A warning appears when the clipboard is limited. "Preference saved. Use /config to change copyFullResponse".
- **SDK route:** app-only, from the assistant messages already streamed. Setting: `copyFullResponse` in `~/.claude.json`/settings [inf: it is the global config key `copyFullResponse`].

### /diff: "View uncommitted changes and per-turn diffs" (in fullscreen: "Toggle the diff panel showing uncommitted changes") [obs] (chunk-0kfqn9qy, chunk-g16s5ft5)

- **Dialog:** color "background".
  - Title: "Uncommitted changes (git diff HEAD)", or "Branch changes (vs <base>)", or "Staged and new files (no commits yet)", or `Turn N "<prompt preview>"`.
  - Tabs: "Current", "T1", "T2"… (one per turn that changed files).
- **List:** "N files changed +a −r", then file rows. Tags: "untracked", "Binary file", "Large file modified", " (truncated)".
  - Empty states: "No changes yet", "No file changes in this turn", "Too many files to display details", "No changed files".
  - Footer: `←/→` "switch source", `↑/↓` "select", `enter` "view", `Esc` "close".
- **Detail:** hunks, `↑/↓` "scroll", `Esc` "back". Esc on the list → "Diff dialog dismissed".
- Fullscreen panel: ctrl+x b cycles the base ("app:cycleDiffBase"). Hints: "Nothing to diff against until the repo's first commit", "No base branch to compare against — showing changes vs …".
- **SDK route:**
  - Current changes: the app runs `git diff HEAD` (plus untracked files) itself.
  - Per-turn: build from the Edit/Write/MultiEdit `tool_use` inputs or `tool_use_result` of each turn [inf], or `rewindFiles(turnUuid,{dryRun:true})` for counts only.
  - Undocumented raw `get_workspace_diff` exists [obs].

### /branch: "Create a branch of the current conversation at this point"; arg `[name]` [obs] (chunk-vtmxhnk6)

- Copies the transcript into a new session with fresh UUIDs and `forkedFrom` links, then resumes into it.
- Title: `[name]`, or `<first prompt, 100 chars> (Branch)`, or `(Branch N)` when that title is taken.
- Message: `Branched conversation "<name>". You are now in the new branch (session <new>). Use /resume <old> ("<oldName>") to return to the original, or run \`claude -r <old>\` in a new terminal.`
- Errors: "Failed to branch conversation: No conversation to branch" / "No messages to branch".
- **SDK route:** `forkSession(sid,{dir, title})`, then restart the query with `resume:<new>`. The SDK's default title is `<orig> (fork)`, so pass the CLI-style "(Branch)" title. `forkSession` does not copy file-history snapshots, so rewind does not work across the branch point [obs sdk.d.ts].

### /fork: two variants, chosen by the fleet gate [obs] (chunk-ktgr2fgq `Gln()`, chunk-cbc2pszw)

- Fleet off: "Spawn a background agent that inherits the full conversation", arg `<directive>`.
  - "Usage: /fork <directive>". Success: "<icon> forked <name> (<id last 4>)".
  - Errors: "Cannot fork before the first conversation turn", "Forking is not available in coordinator sessions. Use /branch instead."
- Fleet on: "Copy this conversation into a new background session and keep working here", arg `[prompt]`, plus `/subtask <task>` ("Send a subagent off with your full context; its result comes back here").
- **SDK route:** none documented. Approximations [inf]:
  - (a) Send a prompt that asks for a background `Agent` with the directive (it loses "full conversation" inheritance).
  - (b) `forkSession(sid)` plus a second app-managed `query({resume:forkId, prompt:directive})` running beside the main chat. This is the closest to the fleet variant.

### /rename (alias /name): "Rename the current conversation"; arg `[name]` [obs] (chunk-1ngb38j5, chunk-36eassqk, headless variant exists)

- No arg: the CLI generates a name from the conversation (model call) [obs].
- Messages: "Session renamed to: X", "… (\"Y\" is held by another live session on this machine)", "Session is named: X (a newer rename landed first)", "Could not generate a name: no conversation context yet. Usage: /rename <name>", "That name is empty once invisible characters are removed. Usage: /rename <name>". For teammates: "Cannot rename: This session is a teammate…".
- **SDK route:** `renameSession(sid,title,{dir})` (documented). For no arg: undocumented `q.generateSessionTitle(desc,{persist:true})`, or send `/rename` as text (the headless variant runs). The app already renames via saves.ts.

### /tasks (alias /bashes) and the background tasks UI: "View and manage everything running in the background" [obs] (chunk-6nsdtg9a ~669–752k)

- **Entry points:** `/tasks`; the footer pill (↓ "manage" / "view tasks"; Footer keys; `x` closes); `ctrl+t` toggles the todos/tasks list.
  - Footer counts: "N active shell(s)", "N active agent(s)", "N agent(s)". Hint "/tasks to see subagents".
- **Dialog:** title "Background". Subtitle is the counts line; color "background", or "permission" when a confirm is pending.
  - Groups: "Agents", "Shells", "Monitors", "MCP tasks", "Cloud agents", "Local agents", "Completed", "Dynamic workflows", plus team and subagent-history groups.
  - Row label: the shell command or monitor description, the agent description, `@teammate`, the cloud title or summary. " · stopping…" while it stops.
  - Empty: "No tasks currently running".
  - Footer: `↑/↓` "select", `enter` "view" (or "show" for history/self-managed groups), `f` "foreground" (running local agent or teammate), `x` "stop" (running shell, agent, workflow, monitor, MCP task, remote agent…), "stop all agents", `escape` (close or back). Esc → "Background dialog dismissed".
  - Actions submenu: "Actions for <label>" with view / foreground / stop.
- **Shell detail:** the command and status (`running`, or `(exit code: N)`), "Runtime:", "Output:" ("Loading output…", "No output available").
- **Agent detail:**
  - Status "Completed / Failed / Stopped · N tokens · N tools · <duration>", a "Progress" list (› marks the latest activity), "Prompt", and "Error".
  - Keys: `←` "go back", `x` "stop", `f` "foreground", "stop all agents".
- **Cloud session detail:** "Cloud session details": Status, Runtime, Title, Progress, Session URL, "Recent messages" ("Showing last N of M messages"), `teleport` ("Teleporting to session…", "Teleport failed: …").
- **Ultraplan/ultrareview rows:**
  - Ultraplan: "Stop ultraplan?" / "This will terminate the cloud session." / "Approve, edit, or comment on the plan" / "Discard the generated plan".
  - Ultrareview: "Stop ultrareview?" / "This archives the cloud session and stops local tracking. The review will not complete and any findings so far are discarded."
- **Ctrl+B:** while a foreground Bash or subagent runs, a dim hint "ctrl+b background" sits under it. Pressing it makes the blocking call return "running in the background" and the turn continues [obs sdk.d.ts].
- **Exit with background work:** "Background work is running" / "The following will stop when you exit:" (list), options "Exit and stop tasks", "Move to background and exit" (fleet only), "Stay".
- **SDK route:**
  - Live set: `system/background_tasks_changed` (REPLACE semantics; reset on process restart).
  - Edges: `task_started` (`task_type`, `is_backgrounded`, `parent_task_id`, `workflow_name`, `ambient`), `task_updated` (`patch.status`), `task_progress` (`usage`, `last_tool_name`, `summary` when `agentProgressSummaries:true`), `task_notification` (`completed/failed/stopped`, `output_file`, `summary`, `usage`).
  - Stop: `q.stopTask(task_id)`. Ctrl+B: `q.backgroundTasks(toolUseId?)`.
  - Shell output tail: undocumented `q.getTaskOutput(task_id)` (last 8 KiB, `{output,total_bytes,truncated}`), or read `output_file` from the notification.
  - Agent detail/foreground: `getSubagentMessages(sid, agentId)` / `listSubagents(sid)`.
  - Declare `perTaskStopAffordance:true` so Esc spares background tasks.

### /background (alias /bg): "Send this session to the background and free the terminal"; arg `[prompt]` [obs] (chunk-dxegypn1, chunk-6nsdtg9a)

- Fleet only.
- **Dialog:** "Background this session?"
  - Subtitle: "<summary> running — they will be stopped." plus "N task(s) carries/carry over to the background session."
  - Confirm: "Background", "Background anyway (tasks will be stopped)" or "Background anyway (N subagent(s) restart(s))". Cancel: "Stay".
  - Progress: "Moving to background…" / "Backgrounding…".
- Errors: "Nothing to background yet — send a message first.", "Cannot background — session persistence is disabled, so the forked job would have nothing to resume."
- **SDK route:** not possible headless (a CLI-process concept). App equivalent [inf]: keep the session's query alive while the UI goes to the title screen or another chat (the link server owns the process).

### /stop: "Stop this background session; transcript and worktree are kept" [obs] (chunk-tjt575ez, chunk-fmamc8wm)

- Enabled only inside a bg-session process (`Ht()`) or an attached one.
- **SDK route:** not applicable. The app equivalent is `close()` on that session's query.

### /compact: "Free up context by summarizing the conversation so far"; arg `<optional custom summarization instructions>` [obs] (chunk-atjs8w7s; headless OK)

- Runs PreCompact hooks; a block reads "compaction blocked by PreCompact hook".
- Results: "Not compacted · <reason>"; "Compaction canceled."; "Claude ended this conversation. Start a new session (or /clear) to continue."; the UI line "Conversation compacted" (ctrl+o for the summary).
- Disabled by `DISABLE_COMPACT`.
- **SDK route:** send the text `/compact [instr]`. Watch `system/status` (`compacting` / null with `compactResult`) and `compact_boundary`. `getContextUsage()` for before and after.

### /clear (aliases /reset, /new): "Start a new session with empty context; previous session stays on disk (resumable with /resume)"; arg `[name]` [obs] (chunk-fyz3khyn; headless OK)

- `[name]` sets `clearedSessionTitle`: it names the session being left behind [inf].
- **SDK route:** the app already handles `/clear` itself (a new session). Sending `/clear` through emits `conversation_reset {new_conversation_id, reason:'clear'}` [obs sdk.d.ts]. Keep the app-level version.

### /btw: "Ask a quick side question without interrupting the main conversation"; arg `[question]` [obs] (chunk-85wswqf6, chunk-1qd8rpkj)

- The answer comes from a tool-less one-turn fork that shares context (a fixed system reminder; tools are denied with "Side questions cannot use tools").
- History of earlier /btw exchanges is threaded.
- **Panel:**
  - Header "/btw <question>", with "(+N earlier /btw)" before it. While waiting: "Answering…", or " · retrying in Ns · attempt a/b".
  - Keys: `shift+←/→` "browse" (history), `↑/↓` "scroll", `c` "copy" ("Copied to clipboard"), `f` "fork", `x` "clear history", `escape` "close".
  - `f` forks the side answer into a background agent ("Forking…"), or a `btw: <q>` branch in coordinator mode.
- No arg: "Usage: /btw <your question>". Synthetic answers: "(The model tried to call X instead of answering directly…)", "(API error: …)".
- **SDK route:** undocumented `q.askSideQuestion(question,{history,signal})` returns `{response, synthetic, refusalFallback?}`. Progress arrives as `system/control_request_progress` [obs]. Fallback: a separate one-shot `query` with `resume:sid, forkSession:true, maxTurns:1, allowedTools:[]` [inf].

### /plan: "Enable plan mode or view the current session plan"; arg `[open|<description>]` [obs] (chunk-ymb95f70)

- Switches the permission mode to `plan`.
  - With a description: "Enabled plan mode" and the description is sent as a prompt.
  - With no plan yet: "Enabled plan mode" or "Already in plan mode. No plan written yet."
  - Otherwise it shows "Current Plan" (subtitle: the plan path), the plan text, and `"/plan open" to edit this plan in <editor>`.
- `/plan open` opens the file in $EDITOR ("Opened plan in editor: <path>").
- **SDK route:** `q.setPermissionMode('plan')`. Then send the description as a normal prompt. View: undocumented `q.getPlan()` returns `{exists, content, path}`, or read the plan file. Open: the app's own editor. The app already renders ExitPlanMode asks (`ask_plan`).

### /goal: "Set a goal Claude checks before stopping"; arg `[<condition> | clear]` [obs] (chunk-zrrxdsnf, chunk-tbhfyjj4 headless, chunk-1h2nvgvv UI)

- Set: "Goal set: <cond>", then a query starts. The condition is limited to 4000 chars ("Goal condition is limited to 4000 characters (got N)").
- `clear` → "Goal cleared: <cond>" or "No goal set".
- **No-arg panel:**
  - Running: "◎ Goal active", subtitle "running <dur> · N turns · N tokens", rows "Goal:", "Last check:", footer "/goal clear to stop early" · `escape` "dismiss".
  - Done: "✔ Goal achieved" + stats + "/goal <condition> to set another".
  - None: "Goal" / "No goal set" hint "/goal <condition> to set one".
  - Headless no-arg text: "Goal active: <cond> (not yet evaluated | N turns)\nLast check: …" / "No goal set. Usage: `/goal <condition>`".
- **SDK route:** send the text through (the headless variant is enabled when `_e()`). Render the panel from `active_goal {value:{condition, iterations, set_at, tokens_at_start, last_reason}|null}`. The type is declared in sdk.d.ts but is not in the `SDKMessage` union, so handle it as an unknown type [obs].

### /loops: "List, create, and delete loops" [obs]

- `isEnabled:()=>!1`: disabled in 2.1.309. Skip, or show nothing. (The `loop` *skill* is separate.)

### /workflows: "Browse running and completed workflows" [obs] (chunk-3y9mzh4d)

- Enabled unless workflows are disabled (runtime/managed setting, `CLAUDE_CODE_DISABLE_WORKFLOWS`).
- Opens the Background dialog's "Dynamic workflows" group; the footer has a workflows pill and a progress preview [inf from footer code].
- **SDK route:** `task_*` events with `task_type:'local_workflow'` and `workflow_name`; `stopTask`. A per-workflow detail view has no SDK feed beyond the task events [unk].

### /recap: "Generate a one-line session recap now" [obs] (chunk-g5px6ers; headless OK)

- Messages: "Nothing to recap yet — send a message first.", "Recap cancelled.", "Couldn't generate a recap. Run with --debug for details."
- It refuses requests that do not come from the user directly (relayed or programmatic): "/recap only runs when you ask for it yourself…".
- **SDK route:** send the text. The app stamps `origin:{kind:'human'}`, which should pass the check [inf, unverified].

### /session (alias /remote): "Show cloud session URL and QR code" [obs]

- Enabled only in a remote workspace (`Pn()`); hidden unless the fanout capability is on.
- **SDK route:** not applicable to the local app.

### /exit (alias /quit): "Exit the CLI" (in a bg session: "Detach from this background session (it keeps running)") [obs] (chunk-rpsefbk2)

- Ctrl+D / Ctrl+C double press: "Press Ctrl-C again to exit" (or "… to detach (session keeps running)").
- With background work, the exit dialog appears (see /tasks).
- **SDK route:** app-level (the app's `/exit` goes to the title screen). Do **not** send `/exit` through: the headless variant ends the CLI process. Mirror the "Background work is running" confirm using `background_tasks_changed`.

### /help: "Show help and available commands" [obs] (chunk-7embtey5)

- **Dialog:** title "Help", color "professionalBlue". Tabs (Tab / Shift+Tab / ← →): **General**, **Commands**, **Custom commands**.
- **General tab:**
  - "Claude understands your codebase, makes edits with your permission, and executes commands — right from your terminal."
  - "New here? Run /powerup to learn the features most people miss."
  - **Shortcuts** in columns:
    - "! for shell mode", "/ for commands", "@ for file paths", "/btw for side question"
    - "double tap esc to clear input", "shift+tab auto-accept edits", "ctrl+o for verbose output", "ctrl+t toggle tasks"
    - "shift + ⏎ for newline" (or "\⏎ for newline" / "backslash (\) + return (⏎) for newline")
    - "ctrl+_ undo", "ctrl+z suspend", "ctrl+v paste images" (alt+v on Windows), "alt+p switch model", "alt+o toggle fast mode", "ctrl+s stash prompt", "ctrl+g edit in $EDITOR", "/keybindings to customize"
  - The chords come from the user's keybindings.
- **Commands tab:** "Browse default commands". A scrollable list of `/name — description` (built-in and bundled, not hidden, deduped, sorted).
- **Custom commands tab:** "Browse custom commands", or "No custom commands found".
- **Footer:** "For more help: https://code.claude.com/docs/en/overview" · "Something else? Use /feedback to report bugs or request features." · "Esc to cancel". Esc → "Help dialog dismissed".
- **SDK route:** app-level (the app has `/help`). The command list comes from `supportedCommands()`. Split by `builtin` (the app already tags app / built-in / custom).

### /feedback and /bug (alias /share): "Send feedback to Anthropic or report a bug" / "Report a bug or share your conversation"; arg `[report]` [obs] (chunk-sbe0ms8h)

- **Dialog:** "Submit feedback / bug report". Steps:
  1. **userInput:** "Describe the issue below:" (multiline). Errors: "Edit and press Enter to retry, or Esc to cancel".
  2. **scope:** "How much session history should we include?" with "This session only" / "This session + the last 24 hours" / "This session + the last 7 days".
  3. **consent:** "This report will include:", then a list: "- Your feedback / bug description:", "- Environment info", "- Git repo metadata:", "- Session transcript:", "- Recent error messages: up to the last 100 since you launched Claude Code (may include file paths)". Footer: "We may use these to debug related issues and improve Claude Code." Keys: `enter` "submit", `←` "change", `Esc` "cancel".
  4. **submitting:** "Submitting report…".
  5. **done:** "Feedback sent", "Reference ID: …", "If you're working with Anthropic support, please include the ID above.", "Thank you for your report!", "Feedback ID: …", `enter` "open GitHub issue", "any key to close".
- Modes: `share` (/bug, /share) → "This shared conversation will include:", "Uploading share…". `bundle` → "Feedback bundle saved", "Bundle: <zip>".
- Errors: "Couldn't send feedback: not signed in. Run /login, then retry.", "Feedback is disabled by your organization's policy.", "Couldn't send feedback (request timed out)…". Esc → "Feedback / bug report cancelled".
- **SDK route:** undocumented `q.submitFeedback(description,{type,title,area,attach_transcript,save_locally})` returns `{feedback_id, ccshare_url?, failure_reason?}` [obs]. The app owns the dialog. "Open GitHub issue" is a URL the app builds [inf].

### /init: "Initialize a new CLAUDE.md file with codebase documentation" (with `CLAUDE_CODE_NEW_INIT`: "…CLAUDE.md file(s) and optional skills/hooks…") [obs]

- A `prompt` command ("Please analyze this codebase and create a CLAUDE.md file…"). Progress: "analyzing your codebase".
- **SDK route:** send the text `/init`. It runs as a normal turn with Write permission asks.

### /insights: "Generate a report analyzing your Claude Code sessions" [obs] (chunk-g0s780ww)

- A `prompt` command; `disableModelInvocation`; policy `allow_insights`. Progress: "analyzing your sessions".
- Writes `~/.claude/usage-data/report-<id>.html` and `report.html`. Reply: "Your shareable insights report is ready: file://…".
- **SDK route:** send the text. The app opens the HTML (a webview or an external browser).

### /ultraplan: "Draft an editable plan in a cloud session (<time>) · See <docs>"; arg `<prompt>`; claude.ai accounts only [obs]

- Asks for consent through the `ultraplan_launch` dialog (`promptIdentifier, showTerms, prompt` → `run|cancel|cancelled`).
- With no dialog surface: "ultraplan asks before it starts a cloud session, and this session can't show that prompt. Run /ultraplan from an interactive Claude Code session."
- Progress then shows in the tasks panel (an ultraplan row; "Stop ultraplan").
- **SDK route:** pass `onUserDialog` + `supportedDialogKinds:['ultraplan_launch']`, render the consent, then send `/ultraplan <prompt>` as text [inf: the headless path calls `requestDialog`]. Policy `allow_remote_sessions`.

### /ultrareview: "Start a cloud agent that finds and verifies bugs in your branch (<time>, <price> USD) · Runs in a cloud session…" [obs] (chunk-97z0wj64 headless)

- Headless results:
  - launched → a query with the message.
  - needs-confirm → "<body> /ultrareview can't show the billing confirmation in this session. Run \"claude ultrareview\" from your terminal…".
  - blocked → message + URL.
- **SDK route:** undocumented `q.launchUltrareview(args,{confirm:true})` after the app shows its own billing confirm, or send the text (gets "needs-confirm"). The cloud review is then tracked as a task row.

## 3. Queued messages and steering while a turn runs [obs] (chunk-6nsdtg9a, chunk-wsjv31yy, sdk.d.ts)

| Behaviour | CLI UI | SDK route |
|---|---|---|
| Typing + Enter during a turn | Queues the message. It is shown dim under the transcript as **"Waiting to be delivered"** with rows. Queued prompts are folded into the running turn at the next boundary (the `queued_command` attachment), or run next. | Stream an `SDKUserMessage` with `priority:'next'` (the app already does this when busy). Bind replies via `user_message_uuids` on assistant frames. |
| Send now | Hint "ctrl+enter send now" (`chat:sendNow`; also ctrl+x ctrl+s). | Send with `priority:'now'` (preempts) [inf from CLI code setting priority "now"]. |
| Queue explicitly | `ctrl+x enter` (`chat:queueSubmit`). | `priority:'later'` [inf]. |
| Edit queued | Placeholder hints: "Press up to edit queued messages", "…, Enter to send them immediately", "Press up to select a queued message, then Enter to edit it", "Press Enter to edit the selected message, or up again for an older one". Shell: "Clear the input to edit this queued shell command". | Undocumented `q.cancelAsyncMessage(uuid)` (works only while the message is still queued) then re-send the edited text. |
| Esc / Ctrl+C during a turn | Interrupts. Queued messages survive. | `q.interrupt()`. The receipt's `still_queued` lists the survivors. Raw `cancel_queued:true` clears them. Declare `perTaskStopAffordance` so bg tasks survive. |
| Message to a viewed agent | "Message @name…" placeholder; "Failed to deliver queued message to agent: …". | No documented route (`send_task_message` exists in remote/bridge code only) [obs]. |

## 4. Route summary

| Command | Headless variant? | Best route |
|---|---|---|
| /resume | no | `listSessions`/`getSessionMessages`/`renameSession` + `query({resume})` (app Save/Load page) |
| /rewind, Esc Esc | no (event dropped) | `rewindFiles(uuid,{dryRun})`, `rewindFiles(uuid)`, restart with `resume`+`resumeSessionAt`+`resumeDropsTurn` (or `forkSession({upToMessageId})`). Summarize options: not possible |
| /export | no | `exportConversation()` (undocumented) or app-rendered transcript |
| /copy | no | app-only |
| /diff | no | app runs git; per-turn from tool inputs |
| /branch | no | `forkSession(sid,{title})` + resume |
| /fork | no | approximation: `forkSession` + second app-managed query |
| /rename | yes | `renameSession`; `generateSessionTitle` (undocumented) for no-arg |
| /tasks, Ctrl+B | no | `background_tasks_changed`, `task_*`, `stopTask`, `backgroundTasks`, `getTaskOutput` (undocumented), `getSubagentMessages` |
| /background, /stop | no (bg-session only) | not possible headless; app keeps or closes queries |
| /compact | yes | send text; `compact_boundary`, `status` |
| /clear | yes | app-level (or send text → `conversation_reset`) |
| /btw | no | `askSideQuestion` (undocumented) or a one-shot fork query |
| /plan | no | `setPermissionMode('plan')` + prompt; `getPlan()` (undocumented) |
| /goal | yes | send text; render from `active_goal` |
| /loops | disabled | none |
| /workflows | no | `task_*` with `local_workflow`, `stopTask` |
| /recap | yes | send text |
| /session | n/a (remote only) | none |
| /exit | yes, but kills the CLI | app-level only |
| /help | no | app-level + `supportedCommands()` |
| /feedback, /bug | no | `submitFeedback` (undocumented) + app dialog |
| /init, /insights | prompt | send text |
| /ultraplan | no | `onUserDialog` + `supportedDialogKinds:['ultraplan_launch']`, then send text |
| /ultrareview | yes | `launchUltrareview(args,{confirm:true})` (undocumented) after app confirm |

## 5. Open questions [unk]

- Whether `/recap` accepts SDK-sent prompts with `origin:{kind:'human'}`.
- Exact semantics of `priority:'later'` versus `'next'` mid-turn (fold or not).
- Whether `exportConversation` is wired in this build (`Aj?.()` can be absent → "not available in this build").
- What the per-workflow detail view shows (no strings found beyond the group label and the footer preview).
- Whether resume-picker grouping (same session id, several logs) can happen for app-created sessions.
