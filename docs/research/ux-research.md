# UX research: a productive dev tool that plays like a visual novel (V0.5)

Scope: VN UI conventions, game feel, gamification, agentic-coding-app productivity UX, accessibility/focus mode.
Evidence labels: **[src]** stated by a cited source, **[V1]** stated in `docs/V1.md` (a requirement, not checked in code), **[inf]** my inference.
App code was not read beyond `docs/V1.md` and `docs/research/BRIEF.md`.

## 0. TL;DR principles

1. **The VN layer is a skin over a CLI-parity core, never a gate.** Any VN affordance that adds a click, delay or modal between the user and the work must be skippable or switched off globally. Clippy's failure was unsolicited interruptions, poor context awareness and weak opt-out [src: CIO, Mental Floss].
2. **Use VN conventions for what they are good at:** reading pace, log, save/load, choices. These already line up with agent concepts. Backlog = transcript, save slot = session, choice menu = permission/AskUserQuestion, skip = "show me the result now" [inf].
3. **Gamify the relationship, not the output.** Rewards for volume (LOC, commits, streaks) push behaviour in bad directions. GitHub streaks changed behaviour when they were removed, and developers hide badges [src: arXiv 2006.02371, Calefato et al.]. Affection that reacts to *how you work with her* (headpats, thanks, finished quests) is safe [inf].
4. **Notify on state change, never during typing.** Notifications are costly when they arrive mid-task or while the user is typing [src: Cutrell CHI'00]. Recovery takes 10-15 min to resume editing and 30-45 min to recover full context [src: ShiftMag on Duke/Vanderbilt].
5. **Everything has a reduced/off setting, plus one master "Focus mode" switch** [src: WCAG 2.2.2, Game Accessibility Guidelines, Juicee].

## 1. VN UI conventions players expect

### 1.1 Canonical screen set (Ren'Py defaults = the de-facto genre standard)

| Convention | What players expect | Source | Agentic mapping in Waifufy | V1 status |
|---|---|---|---|---|
| Say screen: textbox + name plate (`who`) + text (`what`) + CTC indicator | Wide, high-contrast box. The name plate shows who speaks. A blinking ▼/CTC icon when the page is done | [Ren'Py special screens](https://www.renpy.org/doc/html/screen_special.html); readability: [ladyicepaw a11y tips](https://ladyicepaw.itch.io/invisible-seams/devlog/415360/tips-on-making-your-vn-more-accessible), [nomnomnami UI guide](https://nomnomnami.itch.io/how-can-i-design-a-good-ui-for-my-vn) | Rem's prose. The name plate should also say *what she is doing* ("Rem — editing session.ts") [inf] | R25-R30 [V1] |
| Click/Enter/Space to advance; click while typing = finish page | Universal | Ren'Py say/CTC docs | Enter on empty input advances [V1 InputHost.advance] | R27 [V1] |
| Quick menu row: Back, History, Skip, Auto, Save, Q.Save, Q.Load, Prefs | Always visible but unobtrusive. Many devs cut it to Back/Skip/Auto/Menu because 8 text buttons get ignored | [nomnomnami: pare down that quick menu](https://nomnomnami.com/blog/posts/2024-03-02-pare-down-that-quick-menu) | `qm-*` hooks exist: log, auto, mode, cmd, stop, costume, settings, menu [V1] | partial |
| Auto mode | Advances after a delay that scales with text length. Toggle with an on-screen indicator | Ren'Py Preferences "Auto-Forward Time" | AUTO [V1 R30]. Should become the **default while a turn runs** in Focus/Work mode [inf] | yes |
| Skip (Ctrl hold / Skip toggle) + "Skip Seen/All" + "Stop after choices" + skip indicator | Ctrl = hold-skip. Skip button = toggle. Skipping **stops at choices** by default | Ren'Py Preferences + Skip Indicator; Ctrl vs button behaviour: [itch.io thread](https://itch.io/post/7539834) | Skip = flush the typewriter for all queued pages. It must **always stop at permission/ask menus** [inf] | Ctrl hold [V1 R27] |
| History / backlog | Scrollable log of every line with speaker names. Often click-to-jump / voice replay | Ren'Py History screen (not on the special screens page) | LOG Ctrl+L, searchable, full trace [V1 R23] | yes |
| Rollback (scroll-up / Back) | Mouse-wheel up steps back one line | Ren'Py rollback | Rewind/checkpoints (`rewindFiles`, CLI Esc Esc rewind menu) [src: [CC interactive mode](https://code.claude.com/docs/en/interactive-mode)] | missing [inf] |
| Save/Load: grid of slots (10 per page in Ren'Py) with screenshot, timestamp, name; numbered pages; **Auto** and **Quick** pages | Thumbnails are the main recognition cue | Ren'Py Save/Load screens; autosave "A" page: [itch.io](https://itch.io/post/7588801); quicksave as a named slot: [Lemmasoft](https://lemmasoft.renai.us/forums/viewtopic.php?p=499762) | Sessions = slots, 8 per page with thumbnails [V1 R6-R9]. Q.Save maps naturally to a **git checkpoint / fork session** [inf] | yes, no Quick/Auto page |
| Preferences/config | Display, transitions (all/none), text speed, auto-forward time, skip seen/all, after choices, volumes | Ren'Py Preferences | Settings → Text & motion [V1 R42] | mostly |
| Confirm dialog | Yes/No modal for destructive actions | Ren'Py Confirm | Delete save, exit during turn [V1 R4, R8] | yes |
| Notify | A small toast that fades | Ren'Py Notify | Background session done, CI done, sidecar restart [inf] | toast z90 [V1] |
| Choice menu | Centered stack of options; keyboard 1-9; chosen options greyed on replays | Ren'Py Choice (`chosen` field) | Permission, AskUserQuestion, ExitPlanMode [V1 R20-21] | yes |
| CG gallery / extras | A grid of unlocked images. Unlocks are **global, not per save**. Locked tiles shown as silhouettes with hints. A replay room | [Yog-Sothoth's Yard guide](https://www.arrpeegeez.com/2023/10/yog-sothoths-yard-walthrough-cg-catalog.html), [VN Maker thread](https://steamcommunity.com/app/495480/discussions/0/1697169163405738316), [True Colours devlog](https://borealisgames.itch.io/true-colours/devlog/559949/new-feature-cg-gallery), [Penlight unlock bugs](https://angela-demille.itch.io/penlight/devlog/402235/public-release-015742-new-doll-storyline-ending) | "Memories": snapshot of Rem + caption on milestones (first merged PR, first green test run, 100th turn). Costumes and expressions as collectibles [inf] | missing |
| Affection / relationship meter | Persona-style ranks (10 levels) that unlock *abilities*. Rank-ups come from choices and time spent; romance gated at a rank | [rpgsite P5R confidant guide](https://www.rpgsite.net/feature/5479-persona-5-royal-confidant-guide-conversation-choices-answers-romance-options-gifts-skill-unlocks), [ggrecon Makoto](https://www.ggrecon.com/guides/persona-5-royal-confidant-guide-makoto-niijima-priestess) | Hearts on save slots [V1 R7, `hearts`]. Ranks should unlock *cosmetic* things (lines, costumes, Memories), never productivity features [inf] | partial |

### 1.2 Readability rules [src: ladyicepaw, nomnomnami, itch threads]
- The textbox is the most-read UI. It needs strong contrast, generous padding, and a **wide** box (narrow boxes were criticised).
- Don't fade text as a semantic signal (it causes eye strain). Offer a plain, non-textured box and a large-font option. Offer a dyslexia-friendly font.
- The name plate needs heavier font weight and few effects [src: VRChat nameplate thread, a non-VN source].

## 2. Game feel / "juice" that doesn't slow work

| Technique | Use in Waifufy | Guardrail | Source |
|---|---|---|---|
| Micro-reactions (squash, nod, sparkle) on events | Gestures on push/finish/error [V1 R35] | Effects play **in parallel** with the work and never block input. Under 400 ms | [inf]; game-feel guides [Juicee](https://store.godotengine.org/asset/kelpekk/juicee/) |
| Screen shake | Avoid it. At most a 1-2 px dialogue-box nudge on errors | Shake is the effect most likely to cause motion sickness. Keep it short, high-frequency, low-amplitude, eased, behind a global intensity slider | [StraySpark](https://www.strayspark.studio/blog/camera-shake-game-feel-without-motion-sickness), [Cult of the Lamb sliders](https://steamcommunity.com/app/1313140/discussions/0/3319737272513211796) |
| Combo / power-mode particles on typing | **Don't.** It runs on every keystroke and distracts during the most focus-heavy activity | Power Mode has combo threshold/timeout settings, which shows it needs a governor | [beyondjapan Power Mode](https://beyondjapan.com/en/blog/2019/01/visual-studio-code-power-mode), [Thiti-Dev fun-coding](https://github.com/Thiti-Dev/vscode-ext-fun-coding) |
| Typewriter + lip sync | Keep it, but **work output is never typewritten**. Diffs, tool logs and code appear instantly. Only Rem's prose types | Speed slider down to "instant" [V1 R27] | [inf] |
| Transitions between screens | 150-250 ms fades | "Transitions: all/none" toggle (Ren'Py has one) | Ren'Py Preferences |
| Sound | Optional chime when a turn finishes in the background | Cursor users note sound is useless when muted, so also use visual and OS notifications | [Cursor forum](https://forum.cursor.com/t/send-desktop-notification-once-an-agent-has-finished-running/100843) |
| Diegetic status | Ribbon, spinner, quest log and party already map tool state into the game world [V1 R18, R22] | Use the information tiers below so it stays legible | [inf] |

Rule of thumb [inf]: **juice confirms; it never announces.** It reacts to something the user did or that just finished. It never starts unprompted while the user is typing (Cutrell CHI'00).

## 3. Gamification: what devs like vs find annoying

| Example | What it does | Dev reception | Lesson | Source |
|---|---|---|---|---|
| GitHub streaks (removed 2016) | Public contribution-streak counter | Natural experiment: when it was removed, developers' weekend activity and streak-chasing dropped. The counter had been steering behaviour | Public streaks distort behaviour. Don't make them public or central | [arXiv 2006.02371](https://arxiv.org/pdf/2006.02371) |
| GitHub achievements | Profile badges (Pull Shark, YOLO, …) | Mixed. A growing share hide them. Badges are poor signals of skill | Make them private and opt-in, and keep them humorous | [Calefato et al.](https://ricerca.uniba.it/handle/11586/502580), [arXiv 2303.14702](https://arxiv.org/html/2303.14702v2), [GH discussion](https://github.com/orgs/community/discussions/50552) |
| Duolingo streak + freezes | Daily streak, loss aversion, owl guilt notifications | Effective, but criticised as manipulative and addictive. Streak maintenance gets mistaken for progress. Freezes are seen as either humane or cheapening | If you have streaks, make them forgiving and comeback-oriented, and never guilt-notify | [uxdesign.cc](https://uxdesign.cc/the-good-the-bad-and-the-ugly-of-duolingo-gamification-3a12f0e80dc7), [Yu-kai Chou](https://yukaichou.com/?p=38864), [JAPM](https://japm.substack.com/p/the-psychology-behind-duolingos-most), [PCWorld](https://www.pcworld.com/article/2924235/duolingo-got-easier-when-i-paid-for-it-that-was-the-problem.html) |
| Code::Stats | XP per language from keystroke pulses; levels | Niche but liked: private-ish, informational, never interrupts | Passive, per-language XP that you look at by choice is fine | [codestats Lazarus plugin](https://github.com/maico-smaniotto/codestats-pkg-lazarus), [code-stats-vscode](https://github.com/aviortheking/code-stats-vscode) |
| VS Code Power Mode | Particles, shake and combos on typing | A novelty that usually gets disabled (the settings exist to tame it) [inf] | Juice on input = annoying. Juice on outcomes = OK | see §2 |
| Habitica | An RPG layer over habits (pets, bosses, gold) | Complexity becomes overwhelming. The game layer stops mattering long-term. Self-reporting relies on honesty. A study found counterproductive effects | Don't build a second game the user must maintain. Keep the meta layer thin | [Wikipedia](https://en.wikipedia.org/wiki/Habitica), [LMU study](https://epub.ub.uni-muenchen.de/77668), [G2](https://g2.com/products/habitica-habitica/reviews), [jonathanmh review](https://jonathanmh.com/habitica-habit-tracker-review/) |
| Codecks | A PM tool styled as a card game (cards, decks, hand) | Liked by game devs. Status is shown by colour, and the metaphor is structural, not reward-based | **A metaphor that restructures the UI beats points.** Quest log + party is the same move | [Codecks features](https://www.codecks.io/features/cards-decks-and-projects), [GameFromScratch](https://gamefromscratch.com/codecks-game-development-project-management/) |
| Doki Theme (JetBrains/VS Code, includes Rem) | Anime character themes with stickers; a toggle hides stickers | Popular (~1.1k stars on VS Code) | The **sticker-off toggle is the feature** that lets it live in work IDEs | [doki-theme-jetbrains](https://gittrend.io/repo/doki-theme/doki-theme-jetbrains), [libhunt](https://www.libhunt.com/compare-vscode-jellyfish-vs-doki-theme-vscode), [UbuntuPIT](https://ubuntupit.com/best-intellij-themes-and-color-schemes) |
| Desktop pets / companions (Shimeji, Corner Companion, VTube-Studio AI companions, Qwen Code desktop-pet skill) | A character sits on the desktop, reacts and talks | Beloved as ambient presence. No mainstream example combines a pet with an agentic coding loop | Ambient, corner-docked, click-through when not hovered | [itch desktop pets](https://itch.io/c/733669/desktop-pets-virtual-companions), [Shimeji App](https://vtuber-studio-dev.itch.io/shimeji-app-desktop-pet/devlog), [Qwen desktop-pet](https://tessl.io/registry/skills/github/QwenLM/qwen-code/desktop-pet) |
| Anime terminals (neofetch/anifetch waifu ASCII) | Cosmetic identity | Pure vibes. People who use them opted in on purpose | Identity customisation (R38-R39) is the hook. It doesn't need points | [anifetch](https://pypi.org/project/anifetch-cli/1.0.5/), [winfetch](https://github.com/sjapanwala/winfetch) |
| Stack Overflow reputation | Points and badges | Developers mostly report intrinsic motivation; experienced devs are less moved by rewards | Rewards are seasoning for a minority. Never make them load-bearing | [Lu et al. summary](https://www.universityxp.com/research/2022/6/15/motivation-under-gamification-an-empirical-study-of-developers-motivations-and-contributions-in-stack-overflow), [arXiv 2305.08346](https://arxiv.org/pdf/2305.08346) |

**Liked:** private, informational, cosmetic, identity, humour, structural metaphors, rewards for outcomes.
**Annoying:** public leaderboards, loss-aversion streaks, guilt notifications, rewards for raw volume, effects on every keystroke, a second game to maintain, nagging characters (Clippy).

## 4. Productivity UX in agentic coding apps

| Pattern | Who does it, how | Source |
|---|---|---|
| **Diff review as a first-class pane** | Claude Code Desktop: click `+12 -1` on the Changes card to open the diff, click any line to comment, submit all with Ctrl+Enter, get a new diff. Codex app: Git diff pane with inline comments and stage/revert by chunk or file, plus commit/push/PR. Zed: Review Changes (Ctrl+Shift+R) opens a multibuffer, accept/reject per hunk or all. Cursor: a floating bar to accept/reject per file and jump to the next file. Cursor 3 moved to auto-apply plus "Discard all", and users complained about losing per-hunk review | [CC desktop](https://code.claude.com/docs/en/desktop), [Codex app](https://developers.openai.com/codex/app), [Zed agent panel](https://zed.dev/docs/ai/agent-panel), [Cursor review](https://docs.cursor.com/agent/review), [Cursor forum regression](https://forum.cursor.com/t/bring-back-per-change-apply-inline-diff-review-you-re-throwing-away-your-best-ux-advantage/160856) |
| **Tool activity at adjustable verbosity** | CC Desktop: Normal / Thinking / Verbose view modes, cycled with Ctrl+O. CLI: Ctrl+O transcript, MCP calls collapsed to "Called X 3 times" | [CC desktop](https://code.claude.com/docs/en/desktop), [CC interactive mode](https://code.claude.com/docs/en/interactive-mode) |
| **Interrupt and steer** | CC Desktop: the stop button interrupts. Typing a correction and pressing Enter sends it *without stopping*, and it is read after the current action. Esc stops. CLI: Esc Esc = rewind menu; Ctrl+B = background a task. Codex: steer from mobile | [CC desktop](https://code.claude.com/docs/en/desktop), [CC interactive mode](https://code.claude.com/docs/en/interactive-mode), [Codex app](https://developers.openai.com/codex/app) |
| **Multi-session / parallel** | CC Desktop: session sidebar, Ctrl+Tab cycling, split view, per-session worktree. Conductor: a workspace = branch + worktree + terminal + diff + PR. Codex: threads per project, Local vs Worktree. Cursor 3 Agents Window. Warp: a management view of all agents | [CC desktop](https://code.claude.com/docs/en/desktop), [Conductor](https://www.conductor.build/docs/guides/parallel-agents/run-multiple-claude-code-sessions), [Codex app](https://developers.openai.com/codex/app), [Cursor 3.0](https://cursor.com/changelog/3-0), [Warp agents](https://docs.warp.dev/agents/getting-started/agents-in-warp.md) |
| **Notifications** | CC Desktop: an OS notification when a session finishes *and you aren't viewing it*. Warp: notify on "needs input" and "done", in-app plus system. Cursor anti-patterns: a finished agent **steals focus**, and there are no per-tab completion badges | [CC desktop](https://code.claude.com/docs/en/desktop), [Warp blog](https://www.warp.dev/blog/universal-agent-support-level-up-coding-agent-warp), [Cursor focus-steal](https://forum.cursor.com/t/agent-finish-steals-focus/157090), [Cursor tab badge req](https://forum.cursor.com/t/show-completion-indicator-on-individual-agent-chat-tabs/151731) |
| **Keyboard-first + discoverability** | CC Desktop: Ctrl+/ opens the shortcut sheet; Ctrl+N new; Ctrl+Shift+D diff; Ctrl+Shift+M mode; Ctrl+Shift+I model. A Ctrl+K command palette (VS Code / Superhuman / Linear) = CLI-meets-GUI, fuzzy search over every action | [CC desktop](https://code.claude.com/docs/en/desktop), [Retool on palettes](https://retool.com/blog/designing-the-command-palette), [SaaS palette patterns](https://www.saasui.design/blog/saas-search-command-palette-ux-patterns) |
| **Permission mode always visible** | CC Desktop: a selector under the prompt (Manual / Accept edits / Plan / Auto / Bypass) | [CC desktop](https://code.claude.com/docs/en/desktop) |

## 5. Accessibility and Focus mode

- **WCAG 2.2.2 (Level A):** anything that moves, blinks or auto-updates on its own for more than 5 s needs a **user-facing** pause/stop/hide. `prefers-reduced-motion` alone may not satisfy it [src: [W3C](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide), [Hidde de Vries](https://hidde.blog/meeting-2-22-pause-stop-hide-with-prefers-reduced-motion/)]. Idle Live2D motion, sakura petals and blinking ▼ all fall under it [inf].
- **WCAG 2.3.3 (AAA):** motion triggered by interaction (cursor-tracking head turns, parallax) should be disableable [src: [Deque](https://dequeuniversity.com/resources/wcag2.1/2.3.3-animations-from-interactions)].
- **Game Accessibility Guidelines:** text size is among the top four complaints. Use a readable default font size, let players advance text at their own pace, and offer bypasses for non-core elements [src: [GAG basic](https://gameaccessibilityguidelines.com/basic/)]. Roblox exposes a `ReducedMotion` flag that removes or reduces tweens [src: [Roblox a11y](https://create.roblox.com/docs/production/publishing/accessibility)].
- **Flow cost:** interruptions cost 10-45 minutes of context. Never fire attention-grabbing UI while the user is typing [src: [ShiftMag](https://shiftmag.dev/do-not-interrupt-developers-study-says-5715/), [Cutrell CHI'00](https://www.interruptions.net/literature/Cutrell-CHI00.pdf), [Vella & Porter](https://www.scitepress.org/Papers/2021/102980/)].

**Proposed Focus mode (single toggle, F11-style hotkey, also `/focus`)** [inf]:

| Layer | Normal | Focus |
|---|---|---|
| Rem's prose | Typewriter, paged, ▼ | Instant, all pages concatenated, scrollable (NVL-style) |
| Live2D | Idle, tracking, gestures | Frozen on a calm pose or minimised to a corner portrait; no idle motion |
| Gestures/juice/petals | On | Off |
| Persona voice | Per setting | Work mode (R39) for this session |
| Tool log / diff | Side panels | Promoted to the main area |
| Notifications | Toasts + OS | OS only when unfocused; no in-app toasts while typing |
| Hearts/affection popups | On | Queued silently, shown on exit from Focus |

## 6. Recommendations for V0.5 (prioritized)

Tags: **F** = functional, **V** = vibes, **F+V** = both. "Route" = how it could be built (from BRIEF/SDK names; not verified in code).

### P0: needed so the VN layer never costs productivity

| # | Recommendation | Tag | Route / notes | Evidence |
|---|---|---|---|---|
| P0-1 | **Focus mode** master toggle (hotkey + `/focus` app command + quick-menu button) applying the table in §5. It persists and is per-session overridable | F+V | `APP_COMMANDS` in `app/src/chat/input.ts`; settings flag | §5, Clippy, Doki sticker toggle |
| P0-2 | **Work output is never typewritten or paged.** Code, diffs, tool results and command output render instantly in LOG/panels. Only Rem's prose types. The "(full text in LOG)" hint gets a one-key jump (e.g. `L`) | F | dialogue.ts / panels.ts | R29 [V1], §2 |
| P0-3 | **Skip semantics:** Ctrl-hold and a Skip toggle flush all queued dialogue pages instantly. Skip **always stops at a choice menu** (permission / question / plan) and at errors. Show a skip indicator | F+V | dialogue.ts | Ren'Py Preferences "After Choices", Skip Indicator |
| P0-4 | **Diff review pane** (not only inside the permission prompt): a "Changes" card per turn with `+N −M` → full diff view. Per-file navigation (`]`/`[`), line comments batched and sent with Ctrl+Enter as the next message. Revert per file via checkpoint | F | Edit/Write tool results from the SDK stream; `rewindFiles` for revert; comments = normal `submit()` | CC desktop, Codex, Zed, Cursor regression thread |
| P0-5 | **Steer without stopping:** Enter while busy sends a correction that is read after the current action. Make it explicit in the UI: the chip label "will be read after current step". Esc = hard interrupt. Keep R11 queueing but label the difference | F | streaming prompt in `link/src/session.ts` already supports injecting messages [inf] | CC desktop |
| P0-6 | **Tool activity verbosity, Ctrl+O cycle:** Normal (ribbon + one-line summaries) / Verbose (every call expanded) / Story (VN only, tools hidden in the ribbon). This keeps CLI parity for Ctrl+O | F+V | panels.ts | CC desktop view modes, CLI Ctrl+O |
| P0-7 | **Reduced motion:** honour `prefers-reduced-motion` by default, plus explicit toggles for idle motion, cursor tracking, petals, gesture intensity (slider 0-100%), and transitions all/none. No screen shake anywhere | F | Settings → Text & motion (R42 already has most toggles) | WCAG 2.2.2/2.3.3, StraySpark, Ren'Py transitions pref |
| P0-8 | **Never interrupt typing.** Gestures, affection popups and toasts are deferred while the input has focus and non-empty text (or keys were pressed in the last ~2 s). Permission/ask menus must never steal the textarea's focus mid-keystroke: show them, then focus them on the next Tab or after an idle gap | F | input.ts `busy`/focus state; asks.ts | Cutrell CHI'00, Cursor focus-steal thread |
| P0-9 | **Readable textbox defaults:** full-width box, min 18 px dialogue font at 1600×900 stage, ≥ 4.5:1 contrast in both themes, opacity floor (a box-opacity slider can't go below a readable value), dyslexia-friendly font option, no faded-text semantics | F+V | theme.css tokens, settings | ladyicepaw, GAG, nomnomnami |
| P0-10 | **Shortcut sheet + Ctrl+K command palette** listing every app action and slash command with its key (fuzzy search). It is the discoverable fallback for every VN button | F | new overlay; reuse slash picker data | CC Desktop Ctrl+/, Retool palette article |

### P1: makes it feel like a VN *and* closes the parity gap

| # | Recommendation | Tag | Route / notes | Evidence |
|---|---|---|---|---|
| P1-1 | **Quick Save / Quick Load = checkpoint:** Q.Save names the current point (a file checkpoint + message id). Q.Load opens the CLI's rewind menu equivalent ("restore code / conversation / both"). Bind F5/F9 like PC VNs, and Esc Esc on empty input for CLI parity | F+V | SDK `rewindFiles`; resume-at-message; Save/Load page gets **Quick** and **Auto** tabs | Ren'Py Q.Save/Auto pages, CC Esc Esc rewind |
| P1-2 | **Rollback on mouse wheel up in the dialogue box** re-shows previous pages (read-only, no rewind). Wheel down returns | V | dialogue.ts | Ren'Py rollback convention |
| P1-3 | **Multi-session "party" tabs:** a slot strip of open sessions, each with a Rem mini-portrait whose expression shows state (thinking / waiting for you / done / error). Ctrl+Tab cycles. No focus stealing on completion: badge the tab, OS-notify only if the window is unfocused or another session is visible | F+V | multiple `createSession` in the sidecar | CC desktop, Cursor tab-badge request, Warp |
| P1-4 | **Notifications in character, state-based only:** "needs input" (permission/ask) and "done" (turn > N s) → OS notification with Rem's line and portrait. Never on a timer, never guilt ("you haven't coded today") | F+V | Tauri notification plugin | CC desktop, Warp, Duolingo critique |
| P1-5 | **Choice menu polish:** number keys 1-9 select. The default option is highlighted. Destructive options in danger style need a 300 ms hold or a second press. `chosen` greying on repeated asks in the same session | F+V | asks.ts | Ren'Py choice `chosen`, R20 [V1] |
| P1-6 | **Name plate shows activity:** "Rem · reading 3 files", "Rem · running npm test (12 s)". It doubles as the ribbon on narrow layouts | F+V | dialogue.ts + tool events | [inf], R18 [V1] |
| P1-7 | **Affection v2 = Persona-style ranks (1-10)** earned by *relationship* signals: turns completed together, approving plans, headpats, saying thanks, finished quests. **Never** LOC, commits or streak days. Rank-ups unlock cosmetics only (new idle lines, costume, Memory). Private. Can be hidden. No decay | V | link `stats`; settings | P5 confidants, GitHub streak study, SO motivation study |
| P1-8 | **Config screen as a VN "Preferences" page** with Ren'Py-standard rows first (text speed, auto-forward time, skip seen/all, after choices, transitions) and then the Claude settings. Players find things where they expect them | V | settings.ts | Ren'Py Preferences |
| P1-9 | **Auto mode that respects work:** AUTO paces by text length and pauses at choices. When the window is unfocused it holds the page so the user doesn't miss lines | F+V | dialogue.ts | Ren'Py Auto-Forward |
| P1-10 | **Quick menu pared down:** visible icons only for LOG, AUTO, SKIP, Q.SAVE, MENU (everything else in MENU/palette), auto-hidden in Focus mode, with tooltips that show the shortcut | V | `qm-*` | nomnomnami quick-menu post |

### P2: delight, after parity

| # | Recommendation | Tag | Route / notes | Evidence |
|---|---|---|---|---|
| P2-1 | **Memories (CG gallery):** on milestones (first session in a repo, first green test after red, successful `git push`, plan approved, 100th turn) capture a Rem snapshot + caption + repo/branch. Unlocks are global (not per save). Locked silhouettes with a hint. Click → jump to that session/turn | V | `character.snapshot()`, saves thumbnails | VN gallery conventions, Penlight unlock-bug warning (store unlocks in their own file) |
| P2-2 | **Achievements, private and funny** (GitHub-style humour: "Reverted Rem's 3am refactor", "Plan approved first try"). They show only in Extras, never as popups during work, and can be turned off entirely | V | local JSON | GitHub achievements reception |
| P2-3 | **Code::Stats-style passive stats page** ("Records"): languages touched, tools used, time together. Informational only | V | link stats | Code::Stats |
| P2-4 | **Comeback-not-streak:** after a gap Rem greets you warmly ("Welcome back, X-kun!") with a recap of the last save. No streak counter, no loss framing | V | persona + saves | Duolingo critique (recovery-first framing) |
| P2-5 | **Mini mode / desktop-pet mode:** a corner-docked, always-on-top Rem portrait plus status for long background runs. Click-through except on hover | V | Tauri second window | desktop-pet genre |
| P2-6 | **Optional subtle sound set** (page-turn tick, choice chime, done chime), all off by default, each with its own volume, paired with visual cues | V | R44 audio pipeline later | Cursor sound-vs-mute thread, GAG |
| P2-7 | **Worktree-per-session option** on New Game ("New route"): branching storylines = branches | F+V | SDK cwd + git worktree | Conductor, Codex, CC desktop |

### Explicit non-goals (don't build) [inf, backed by §3]
- Power-mode particles or combos on typing; screen shake.
- Public leaderboards, a visible daily streak, streak-loss notifications, XP for lines of code.
- Rem speaking or emoting unprompted while the user types (Clippy).
- Gating any CLI feature behind affection rank.

## 7. Source list
- Ren'Py special screens: https://www.renpy.org/doc/html/screen_special.html
- Quick menu paring: https://nomnomnami.com/blog/posts/2024-03-02-pare-down-that-quick-menu
- VN UI guide: https://nomnomnami.itch.io/how-can-i-design-a-good-ui-for-my-vn
- VN accessibility tips: https://ladyicepaw.itch.io/invisible-seams/devlog/415360/tips-on-making-your-vn-more-accessible
- Skip button vs Ctrl: https://itch.io/post/7539834 ; autosave page: https://itch.io/post/7588801 ; quicksave slots: https://lemmasoft.renai.us/forums/viewtopic.php?p=499762
- CG gallery: https://www.arrpeegeez.com/2023/10/yog-sothoths-yard-walthrough-cg-catalog.html , https://steamcommunity.com/app/495480/discussions/0/1697169163405738316 , https://borealisgames.itch.io/true-colours/devlog/559949/new-feature-cg-gallery , https://angela-demille.itch.io/penlight/devlog/402235/public-release-015742-new-doll-storyline-ending
- Persona confidants: https://www.rpgsite.net/feature/5479-persona-5-royal-confidant-guide-conversation-choices-answers-romance-options-gifts-skill-unlocks , https://www.ggrecon.com/guides/persona-5-royal-confidant-guide-makoto-niijima-priestess , https://www.digitaltrends.com/gaming/persona-5-romance-confidants-guide-tips/
- Game feel / shake: https://www.strayspark.studio/blog/camera-shake-game-feel-without-motion-sickness , https://store.godotengine.org/asset/kelpekk/juicee/ , https://steamcommunity.com/app/1313140/discussions/0/3319737272513211796
- Power Mode: https://beyondjapan.com/en/blog/2019/01/visual-studio-code-power-mode , https://github.com/Thiti-Dev/vscode-ext-fun-coding
- GitHub gamification: https://arxiv.org/pdf/2006.02371 , https://ricerca.uniba.it/handle/11586/502580 , https://arxiv.org/html/2303.14702v2 , https://github.com/orgs/community/discussions/50552
- Duolingo: https://uxdesign.cc/the-good-the-bad-and-the-ugly-of-duolingo-gamification-3a12f0e80dc7 , https://yukaichou.com/?p=38864 , https://japm.substack.com/p/the-psychology-behind-duolingos-most , https://www.pcworld.com/article/2924235/duolingo-got-easier-when-i-paid-for-it-that-was-the-problem.html
- Code::Stats: https://github.com/maico-smaniotto/codestats-pkg-lazarus , https://github.com/aviortheking/code-stats-vscode
- Habitica: https://en.wikipedia.org/wiki/Habitica , https://epub.ub.uni-muenchen.de/77668 , https://g2.com/products/habitica-habitica/reviews , https://jonathanmh.com/habitica-habit-tracker-review/
- Codecks: https://www.codecks.io/features/cards-decks-and-projects , https://gamefromscratch.com/codecks-game-development-project-management/
- Doki Theme: https://gittrend.io/repo/doki-theme/doki-theme-jetbrains , https://www.libhunt.com/compare-vscode-jellyfish-vs-doki-theme-vscode , https://ubuntupit.com/best-intellij-themes-and-color-schemes
- Desktop pets/companions: https://itch.io/c/733669/desktop-pets-virtual-companions , https://vtuber-studio-dev.itch.io/shimeji-app-desktop-pet/devlog , https://tessl.io/registry/skills/github/QwenLM/qwen-code/desktop-pet
- Anime terminals: https://pypi.org/project/anifetch-cli/1.0.5/ , https://github.com/sjapanwala/winfetch
- Motivation studies: https://www.universityxp.com/research/2022/6/15/motivation-under-gamification-an-empirical-study-of-developers-motivations-and-contributions-in-stack-overflow , https://arxiv.org/pdf/2305.08346
- Clippy: https://www2.cio.co.nz/article/662045/what-went-wrong-clippy-virtual-assistant-pioneer-people-loved-to-hate/ , https://www.mentalfloss.com/technology/computers/tragic-life-clippy-worlds-most-hated-virtual-assistant
- Claude Code desktop: https://code.claude.com/docs/en/desktop ; CLI shortcuts: https://code.claude.com/docs/en/interactive-mode
- Codex app: https://developers.openai.com/codex/app
- Zed: https://zed.dev/docs/ai/agent-panel
- Cursor: https://docs.cursor.com/agent/review , https://forum.cursor.com/t/bring-back-per-change-apply-inline-diff-review-you-re-throwing-away-your-best-ux-advantage/160856 , https://cursor.com/changelog/3-0 , https://forum.cursor.com/t/agent-finish-steals-focus/157090 , https://forum.cursor.com/t/show-completion-indicator-on-individual-agent-chat-tabs/151731 , https://forum.cursor.com/t/send-desktop-notification-once-an-agent-has-finished-running/100843
- Warp: https://docs.warp.dev/agents/getting-started/agents-in-warp.md , https://www.warp.dev/blog/universal-agent-support-level-up-coding-agent-warp
- Conductor: https://www.conductor.build/docs/guides/parallel-agents/run-multiple-claude-code-sessions , https://conductor.build/compare/claude-code
- Command palette: https://retool.com/blog/designing-the-command-palette , https://www.saasui.design/blog/saas-search-command-palette-ux-patterns
- Interruptions: https://shiftmag.dev/do-not-interrupt-developers-study-says-5715/ , https://www.interruptions.net/literature/Cutrell-CHI00.pdf , https://www.scitepress.org/Papers/2021/102980/
- Accessibility: https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide , https://hidde.blog/meeting-2-22-pause-stop-hide-with-prefers-reduced-motion/ , https://dequeuniversity.com/resources/wcag2.1/2.3.3-animations-from-interactions , https://gameaccessibilityguidelines.com/basic/ , https://create.roblox.com/docs/production/publishing/accessibility

## 8. Gaps / unknowns
- Ren'Py History, quick menu and rollback docs were not fetched directly (only the special-screens page). Those conventions come from community sources [src: forums].
- Codex app in-app mid-turn steering: unconfirmed. Its docs only describe mobile steering.
- No primary data on how devs react to affection meters in work tools specifically. The P1-7 design is inferred from GitHub/Duolingo/SO evidence.
- Whether the SDK streaming prompt reads an injected message "after the current action" like CC Desktop (P0-5): not verified in `link/src/session.ts`.
