# CLI extension-management panels (claude.exe 2.1.309) → Waifufy Code mapping

Scope: `/mcp`, `/plugin` (`/plugins`, `/marketplace`), `/skills`, `/hooks`, `/agents`, `/memory`, `/reload-plugins`,
`/reload-skills`, `/skill-doctor`, `/output-style`.

Labels: **[obs]** read in the extracted JS · **[inf]** inferred from code shape/names · **[unk]** not determined.
SDK = `@anthropic-ai/claude-agent-sdk` 0.3.309 `Query` (`link/src/protocol.ts` already proxies `mcpServerStatus`,
`reconnectMcpServer`, `toggleMcpServer`, `reloadPlugins`, `reloadSkills`, `reloadOutputStyles`, `supportedAgents`,
`updateSettings`, `initializationResult`).

Source map [obs] (lazy loader table lives in `chunk-6nsdtg9a.js`):

| Command | local-jsx chunk (interactive) | `local` variant (headless text) | Notes |
|---|---|---|---|
| `/mcp` | `chunk-gxezc1xn.js` (+ server/tool views in `chunk-vfxr8tvv.js`) | `chunk-hk38f0jf.js` (`supportsNonInteractive`, enabled only when `_e()`) | args `[reconnect (<server>\|all)\|enable\|disable [<server>\|all]]` |
| `/plugin` aliases `plugins`, `marketplace` | `chunk-p0cb8t3v.js` → `l3t` in `chunk-vfxr8tvv.js` | none | `requires.ink` |
| `/skills` | `chunk-h54fvgf6.js` (state helpers `chunk-dxq4vt58.js`) | none (`thinClientDispatch:"control-request"`) | |
| `/hooks` | `chunk-paptadxt.js` | none | read-only viewer |
| `/agents` | — | `Tlr` in `chunk-ktgr2fgq.js`, `isHidden:true` | **removed** in 2.1.309 |
| `/memory` | `chunk-vww84dk4.js` (row builders in `chunk-2bkcjhnz.js`) | none | |
| `/reload-plugins` | — | `chunk-49yqxntg.js` | `[--force]` |
| `/reload-skills` | — | `chunk-znaymhjp.js` | |
| `/skill-doctor` | `chunk-v9av8wh6.js` → opens `/plugin` Stats tab | `chunk-efmrnyx5.js` → `Vuo` in `chunk-42wbgv93.js` | |
| `/output-style` | `chunk-25hwm8ms.js` → redirect into `/config` | `chunk-tpwmaswk.js` | `[style]` |

Shared UI vocabulary [obs]:

- Status glyph component `mt` (`chunk-ye6r3v3f.js`): `success` ✔ (green, Windows fallback √) · `error` ✘ (red, ×) ·
  `warning` ⚠ (yellow, ‼) · `info` ℹ · `pending` ◯ (dim) · `loading` `…` · `on` ✔ green · `off` ◯ dim. Other figures:
  `radioOn` ◉, `radioOff` ◯, `bullet` ●, `pointer` ❯, `arrowRight` →, `arrowDown` ↓, `pointerSmall` ›.
- Dialog frame `Se`: `title`, dim `subtitle`, bottom "input guide" of hints joined by ` · `, each `<key> to <action>`.
- Keybinding contexts: **Select** ↑/↓ j/k ctrl+n/p PgUp/PgDn Home/End, Enter accept, Esc cancel. **Settings** adds Space=accept,
  `/` search, `t` sort by tokens. **Confirmation** Enter yes, Esc no. **Tabs** Tab/→ next, Shift+Tab/← previous.
  **Plugin** Space toggle, `i` install, `f` favorite, ctrl+s cycle marketplace.

---

## 1. `/mcp` — "Manage MCP servers"

### 1.1 Entry routing [obs] (`Ud` in gxezc1xn)
- `/mcp` (or `/mcp no-redirect`) → list panel `_n`.
- `/mcp reconnect all` → `ft` spinner "Reconnecting N MCP server(s)" → result text
  `Reconnected X of N MCP servers` (+ ` (K still not connected — run /mcp to check)`), or `No MCP servers need reconnecting`.
- `/mcp reconnect <name>` → `dt`: "Reconnecting to **name**" + spinner "Establishing connection to MCP server"; outcomes:
  `Successfully reconnected to X` · `X requires authentication. Use /mcp to authenticate.` · `Failed to reconnect to X` ·
  ✘ "Failed to reconnect to X" + "Error: …" · `MCP server "X" not found`.
- `/mcp enable|disable [<name>|all]` → `jo` (no UI): `MCP server "X" enabled|disabled`, `Enabled|Disabled N MCP server(s)`
  (+ ` (K couldn't be changed — run /mcp to check)`), `All MCP servers are already enabled|disabled`,
  `MCP server "X" is pending approval — approve it via /mcp first`.
- Background session without terminal: system message "Can't open MCP settings while no terminal is attached…".

### 1.2 Screen: server list `Mn`
Title **Manage MCP servers**, subtitle `N server(s)` (configured + agent-only). Border hides own guide; a separate dim italic
footer: `↑/↓ to navigate · Enter to confirm · Esc to cancel` (nav hints hidden in screen-reader mode).

Group order [obs] (`Nt` + extra groups; each heading = bold label + dim path, groups separated by a blank row, empty groups skipped,
servers sorted by name within a group):

| # | Heading | Dim path (from `lP(scope)`) |
|---|---|---|
| 1 | Project MCPs | `<repo>/.mcp.json` |
| 2 | Local MCPs | `~/.claude.json [project: <cwd>]` |
| 3 | User MCPs | `~/.claude.json` |
| 4 | Enterprise MCPs | (enterprise managed-mcp file path) |
| 5 | Managed MCPs | "provided by your organization" |
| 6 | Active agent MCPs | `@<agent> frontmatter` / "agent frontmatter" |
| 7 | claude.ai | — (connected/used connectors first, then fold row) |
| 8 | Agent MCPs | — sub-headings dim `@agentName`, rows = servers only declared in agent frontmatter |
| 9 | Built-in MCPs | "always available" (scope `dynamic`, e.g. `--mcp-config`) |

- claude.ai group: connectors in `needs-auth`/`failed` state that were never used go behind a fold row
  **Show unused connectors** (icon → / ↓, meta `N hidden|shown`), Enter toggles.
- Suppressed duplicates: dim row `· ◯ hidden — same URL as your server '<name>'` + hint line, one of:
  "To use this connector instead, disable the plugin server in /plugins" · "…, run `claude mcp remove <name>`" ·
  "…, drop it from your --mcp-config flag" · "An admin-managed server takes precedence here" ·
  "…, remove the duplicate server from your configuration".
- Excluded: server named `ide`, and internal servers (`D$`).
- Footer notes: if any server failed: `※ Run claude --debug to see error logs` (or `※ Error logs shown inline with --debug`);
  always `https://code.claude.com/docs/en/mcp for help`.

Row = `icon  name  · meta…` (`io`) [obs]:

| client state | icon | meta words |
|---|---|---|
| connected | ✔ | `N tool(s)` (only if server advertises tools) |
| connected, tools capability but 0 tools | ⚠ | `no tools · connected` |
| connected, tools/list errored | ⚠ | `tools fetch failed · connected` |
| connected, claude.ai bearer rejected | ⚠ | `session token rejected · connected` |
| cached | ◉ (inactive tone) | `cached <time ago> · connects on first use · N tools` |
| pending | `…` | `reconnecting (a/max)…` when retrying |
| needs-auth | ⚠ | `needs authentication` |
| failed, errorCode `UNCONFIGURED` | ◯ | `not configured` |
| failed, errorCode `INVALID_CONFIG` | ✘ | `config issue` |
| failed (other) | ✘ | — |
| disabled | ◯ (off) | — |
| enterprise-managed claude.ai connector | (as above) | + `managed` |
| agent-only server | ⚠ if needsAuth else ◯ | `may need auth` / `agent-only` |

Empty state [obs]: when no servers, agent servers, suppressed or refused entries → panel closes with
"No MCP servers configured. Run `claude doctor` if this is unexpected — it lists MCP config files that failed validation.
Otherwise, run `claude mcp --help` or visit https://code.claude.com/docs/en/mcp to learn more." Esc → "MCP dialog dismissed".

### 1.3 Screen: server detail — remote (http/sse/claude.ai) `hit`/`Nc`
Title `<Name> MCP Server`; guide `↑/↓ to navigate · Enter to select · Esc to back`; transient "Checking credentials…".
Fields (two-column table):

| Field | Value |
|---|---|
| Status: | `tg()`: ✔ connected · ⚠ connected · no tools / tools fetch failed / session token rejected · ◉ cached… · ◯ connecting… · ⚠ needs authentication · ◯ not configured · ✘ config issue / failed · ◯ disabled |
| Issue: | error text (+ displayDetail) when failed/needs-auth |
| Auth: | ✔ authenticated / ✘ not authenticated (not for claude.ai proxy) |
| Protocol: | negotiated MCP version (modern era only) |
| Managed: | "by your organization" (enterprise claude.ai connector) |
| URL: | display endpoint |
| Config location: | `lP(scope)` path |
| Capabilities: | `tools · resources · prompts` or `none` (when connected) |
| Tools: | `N tools` |
| Issue: | "claude.ai rejected the session token. Run /login, then reconnect." / toolsListError |

Menu (order as built) [obs]:
1. **Enable** (if disabled) · 2. **View tools** (connected & >0 tools) ·
3. claude.ai proxy: **Clear authentication** (connected) else **Authenticate** ·
   other remote: **Connect on claude.ai** (handoff URL known) · if authenticated: **Re-authenticate** + **Clear authentication**,
   else **Authenticate** (only when URL parses, no headersHelper rejection, not disabled, not policy-blocked) ·
4. **Reconnect** (not disabled; for needs-auth only with headersHelper or JL config) · 5. **Disable** (not disabled) ·
   fallback **Back**. Default focus skips auth items.

Sub-screens: "Authenticating with X…" + spinner "A browser window will open for authentication" (XAA: "Authenticating via your
identity provider"), "If your browser doesn't open automatically, copy this URL manually" + URL (`c` copies), optional paste box
"If the redirect page shows a connection error, paste the URL from your browser's address bar:", "Return here after
authenticating in your browser. Press Esc to go back." · claude.ai flow: "Press Enter after authenticating in your browser." ·
Clear claude.ai auth: "This will open claude.ai in the browser. Find the MCP server in the list and click "Disconnect"." ·
"Connecting to X… / Establishing connection to MCP server / This may take a few moments." · "Checking with claude.ai…".

Result messages (close panel): `Authentication successful. Connected|Reconnected to X.` · `Got new credentials, but X rejected
them on reconnect…` · `Authentication cleared for X.` · `Disconnected from X.` · `X is connected on claude.ai. Its tools load as a
claude.ai connector the next time you start Claude Code.` · reconnect result text (`fAt`).

### 1.4 Screen: server detail — stdio `VRn`
Same title/guide. Fields: Status (`rg`: ◯ disabled · ✔/⚠ connected… · ◯ connecting… · ✘ failed), Command (if differs),
Protocol, Config location, Capabilities, Tools, Issue. Menu: **View tools** (enabled & >0) · **Reconnect** (enabled) ·
**Disable**/**Enable**. Reconnect screen: "Reconnecting to X" + "Restarting MCP server process" + "This may take a few moments."

### 1.5 Screen: agent-only server `Gn`
Title `<Name> MCP Server`, subtitle `agent-only`. Fields Type, URL, Command, Used by; Status "◯ not connected (agent-only)",
Auth "⚠ may need authentication"; note "This server connects only when running the agent." Menu **Authenticate** (if needsAuth),
**Back**. Success: "Authentication successful for X. The server will connect when the agent runs."

### 1.6 Screen: tool list `a3t`
Title `Tools for <server>`; subtitle `N tools` or `N tools · K disabled by your organization` (or warning "<tool> is disabled by
your organization" when a blocked row is selected). Rows sorted with org-blocked last; label = user-facing tool name;
blocked rows ⚠ + `disabled by your organization`; meta `ask-only`, `read-only`, `destructive`, `open-world`.
Guide `↑/↓ navigate · Enter select · Esc back`. Empty: "No tools available".

### 1.7 Screen: tool detail `i3t`
Title = display name + ` [read-only]` (green) ` [destructive]` (red) ` [open-world]` (dim); subtitle = server name; guide
`Esc to go back`. Body: **Tool name:** short name · **Full name:** `mcp__server__tool` · **Description:** (truncated to the model's
char budget; note "The model receives only about the first N characters, or M once the model loads the tool through tool search.")
· **Parameters:** `name (required): type - description` per input-schema property. Load failure: "Failed to load description".

### 1.8 What actions do [obs]
| Action | Function | Persistent effect |
|---|---|---|
| Reconnect | `xSe()` hook (MCP client reconnect) | none (runtime) |
| Enable/Disable | `mxe()` → `gat()` | `~/.claude.json` project entry `disabledMcpServers[]` (built-in default-off servers use `enabledMcpServers[]`) [obs keys; file inferred from `La()`] |
| Authenticate / Re-auth | `mcpAuthModule().performMCPOAuthFlow` then reconnect; old tokens revoked | OAuth tokens in CLI credential store [inf: keychain/`.credentials.json`] |
| Clear authentication | `revokeServerTokens` + `clearServerCache`; state → failed | credential store |
| claude.ai Authenticate/Clear | opens claude.ai connector page; reconnect | claude.ai account |
| View tools / tool detail | reads `appState.mcp.tools` | none |

### 1.9 Headless `/mcp` (hk38f0jf) [obs]
`N MCP server(s): A connected, B cached, C connecting, D not connected, E not configured, F disabled.` (+ "Reply `/mcp reconnect all`
here to retry.") plus usage line `Usage: /mcp [reconnect|enable|disable [<server>|all]]. With no server name, applies to all.`;
status words map `connected · cached (connects on first use) · connecting · disabled · not connected · needs authentication ·
pending approval`. Empty: "No MCP servers are configured. Add one with `claude mcp add`."

---

## 2. `/plugin` (`/plugins`, `/marketplace`) — tabbed "Plugins" panel

### 2.1 Arg routing `um` [obs]
`install` (no arg → Discover; `<plugin>` → Discover targeted; `<plugin>@<mkt>` → browse marketplace; npm spec → npm install),
`manage` → Installed, `stats` → Stats, `directory [query]` → Discover on Anthropic Directory, `enable|disable|uninstall|configure
<plugin>` → Installed with action, `list [--enabled|--disabled]` → text list, `marketplace [list|add <src>|remove <n>|update <n>]`,
`validate <path>`, `eval [target]`, `tag [path] [--push] [--dry-run] [-f]`, `help` → static usage text, default → Discover.

### 2.2 Frame
Tabs component titled **Plugins** (color `suggestion`), tabs in order: **Discover · Installed · Marketplaces · Errors (N)** ·
**Stats** (only when skill stats feature `PF()`). Banners: "Skills are now managed here under the Skills section." (from
`/skills` redirect, Installed tab), "/skill-doctor moved — skill usage and context costs now live in this Stats tab." On close,
if plugins changed and cache impact allows: auto-submits `/reload-plugins` (or "Plugin changes apply when the current response
finishes (/reload-plugins is queued).").

### 2.3 Discover tab (`Dl`) [obs]
- Title "Discover plugins", search box "Type to search", list rows: `name · marketplace · N installs`, flags
  ` [Community Managed]`, ` [not installable on claude.ai yet]`, `installed`, suggestion reason (`suggested for this directory`,
  `suggested for <cmd> commands`, `suggested for <host>`, `suggested for <file>`, `suggested from <file>`).
  "↑ N more above / ↓ N more below". Marketplace filter shown in header; `ctrl+s` filter by marketplace.
- Footer: `Space toggle · i install · Enter select/details · Esc go back`.
- Empty/error states: "No plugins match "q"" · "Git is required to install marketplaces. Please install git and restart Claude
  Code." · "Your organization policy does not allow any external marketplaces." · "Your organization restricts which marketplaces
  can be added. Switch to the Marketplaces tab to view allowed sources." · "Failed to load marketplace data. Check your network
  connection." · "All available plugins are already installed." · "All available plugins are installed for this project." ·
  "Add a marketplace first using the Marketplaces tab. No plugins available." · "Your organization's policy hides every plugin
  that would be listed here." · "Checking <mkt> for new plugins…" · "Couldn't refresh marketplace … showing the cached catalog."
- Browse-marketplace variant (`Rl`): "Select marketplace" list (`N plugins available`, `N already installed`), then
  "Install Plugins" list; empties "No marketplaces configured. Add a marketplace first using 'Add marketplace'",
  "All plugins from this marketplace are already installed.", "No new plugins available to install."
- **Plugin details** screen: trust warning ("Make sure you trust a plugin before installing… Anthropic does not control what MCP
  servers, files, or other software are included in plugins…"), description, `from <mkt>`, "Community managed: maintained by its
  publisher, not Anthropic", Version, Repository, "Installs exactly commit X, the commit the <mkt> lists", component summary
  (Commands, Agents, Skills, Hooks, MCP Servers, LSP Servers), Context cost (`· Every turn: N tokens`, `· When invoked: N tokens`),
  headersHelper/command-install warnings. Menu: **Install for you (user scope)** · **Install for all collaborators on this
  repository (project scope)** · **Install for you, in this repo only (local scope)** · **Open homepage** · **View on GitHub** /
  **View repository** · **Back to plugin list**. "Installing…" then optional plugin-options form, then result
  `✓ Installed <plugin>. Plugin is now active.` / `Run /reload-plugins to apply.` / `The plugin couldn't be loaded — see /plugin
  for details.` / `Failed to install: …`.

### 2.4 Installed tab (`cs`) — unified plugins + MCP + skills list [obs]
Title "Manage plugins"; search "Type to search"; empty "No plugins or MCP servers installed."; loading "Loading installed plugins…".
Sections in order (`Ld`): **Needs attention** (⚠; plugins with errors, failed/flagged plugins, MCP needs-auth/failed) →
**Favorites** → **Not used recently** → main items grouped by scope headers in order **Flagged, Project, Local, User, Enterprise,
Managed, Built-in, Skills** → fold row `› disabled N · K unused claude.ai connectors` (Enter shows disabled items).
Search flattens to one unsectioned list. MCP servers belonging to a plugin are indented `└ name` under it.

Row = `glyph  name  type  status · details` (`$d`):

| type | glyph / status word | details |
|---|---|---|
| Plugin | ✔ enabled (default, hidden) · ◯ disabled · ✘ `N errors` · → `will enable`/`will disable` (pending) | marketplace, `required by your org`, `N skills`, `N uses`, `not used in N days` |
| Plugin (flagged) | ⚠ removed | marketplace |
| Plugin (failed) | ✘ failed to load | `N errors`, marketplace |
| MCP | ✔ connected · ◯ disabled · ◯ connecting… · ⚠ needs sign-in (+`Enter to auth`) · ◯ not configured · ✘ failed · ◉ cached… | `managed`, `from <plugin>` |
| Skill | ✔ on · ● name-only · ◯ user-only (warning) · ◯ off; 🔒 prefix when locked | source, `~N tok`, `N× today|Nd` / `never used` |

Footer: `Type to search · Space toggle · f favorite · Enter view · Esc go back` + "Changes apply when you close this menu" or
"Run /reload-plugins to apply changes". Safe-mode banner: "Safe mode: installed plugins are disabled this session…".

**Plugin detail** screen fields: Scope, Version (`· installed at commit X`), Author, Status (Enabled/Disabled ` · Required by your
org` ` · Marked for update` `· Last used: today|N days ago`), Installed components (Commands/Agents/Skills/Hooks/MCP Servers/LSP
Servers), errors. Menu order: **Disable plugin / Enable plugin** (unless org-required) · **Add to favorites / Remove from
favorites** · (non-built-in, non-claude.ai) **Mark for update / Unmark for update** · **Configure** (MCPB needing config) ·
**Update now** · **Uninstall** · **Configure options** (manifest `userConfig`) · **Open homepage** · **View repository** ·
**Usage** · **Switch to <marketplace>** · **Back to plugin list**. Built-in: "Built-in plugins cannot be updated or uninstalled."

Confirm sub-screens: project-shared uninstall ("X is enabled in .claude/settings.json (shared with your team) — Disable it just for
you in .claude/settings.local.json?" keys `y disable for me · u uninstall for everyone · Esc cancel`), data cleanup ("N of
persistent data — Delete it along with the plugin?" `y delete · n keep`), switch-copy (`y switch`), flagged detail ("Removed from
marketplace · reason: …", **Dismiss**), failed-plugin detail (**Remove**), Usage view ("Skill-listing footprint", "Activity").
MCP rows open the same `hit`/`VRn` server views and tool views as `/mcp`; Skill rows open **skill detail**: When to use, Source
`· ~N tokens`, Usage `N× · last used …` / never invoked, Allowed tools, Path, State (cycle with Enter: on → name-only → user-only
→ off; locked by policy/flag/reserved-name/author frontmatter).

Results: `✓ Enabled|Disabled|Updated|Uninstalled <plugin>.` + "Run /reload-plugins to apply." / "Applies when you close this menu."
`✓ Disabled X in .claude/settings.local.json`, `Removed X from .claude/settings.json`, `Failed to <action>: …`.

### 2.5 Marketplaces tab (`Ul`) [obs]
Title "Manage marketplaces"; first row "+ Add Marketplace"; rows: name (official `claude-plugins-official` with ✻), `N available ·
N installed • Updated <date>`, policy notes, claude.ai rows (`· available from claude.ai · Enter to add`, `hosted on claude.ai (…)`,
`· browse on claude.ai`), pending markers `UPDATE` / `REMOVE`, "Pending changes:" summary. Keys: `u update · d remove|turn off|turn
on · Enter apply changes · Esc go back`. Detail menu: **Browse plugins (N)** · **Update marketplace (last updated …)** · **Turn on /
Turn off (plugins installed from it stay installed)** (official) · **Enable auto-update / Disable auto-update** · **Remove
marketplace** (confirm: "This will also uninstall N plugins from this marketplace", `Enter confirm · Esc cancel`).
Add-marketplace screen: "Add Marketplace / Enter marketplace source:", examples `owner/repo`, `git@github.com:owner/repo.git`,
`https://example.com/marketplace.json`, `./path/to/marketplace`; errors "Please enter a marketplace source", "Invalid marketplace
source format. Try: owner/repo, https://..., or ./path"; progress "Checking marketplace source…", "Adding marketplace to
configuration…"; loading "Loading marketplaces…".

### 2.6 Errors tab (`Pc`) [obs]
List of plugin load errors, each: message (≈40 types: path-not-found, git-auth-failed, network-error, manifest-parse-error,
manifest-validation-error, plugin-not-found, marketplace-not-found/-load-failed/-blocked-by-policy, mcp-config-invalid,
hook-load-failed, component-load-failed, mcpb-*, dependency-unsatisfied, lsp-*, plugin-cache-miss, plugin-not-installed,
autoupdate-*) + guidance line. Footer `↑ navigate · Enter resolve · Esc go back`; resolve prompts "Press y to remove or n to keep".
Empty: "No plugin errors".

### 2.7 Stats tab (`ca`) — also `/skill-doctor`
"Skills loaded this session" table: `skill  source  context  7d tokens  uses  last used`, legend lines ("context = this skill's
one-line listing in the system prompt, included every turn", "(dash = not in the current listing…)", "7d tokens = tokens attributed
… last 7 days"), warnings "N skills loaded but never invoked… Disable in /skills, or remove from .claude/skills." (variants for
claude.ai-synced, plugin, MCP skills), success "All loaded skills have been used at least once.", "Plugins not used recently" +
"Manage these in the Installed tab". Loading "Scanning local sessions… / Computing skill usage…"; error "Couldn't compute skill
usage. Run with --debug for details."

### 2.8 Files touched [obs keys / inf paths]
`enabledPlugins` in user/project/local `settings.json`; `extraKnownMarketplaces` in settings; `~/.claude/plugins/known_marketplaces.json`,
`installed_plugins.json`, plugin cache dir; plugin `userConfig` values (`pluginConfigs` [unk exact key]); favorites [unk store].

---

## 3. `/skills` — "Skills" [obs]
- Title **Skills**, subtitle `N skills` (`a/N skills` when filtering) + ` · sorted by tokens` + ` · ` + hint:
  `enter/space to cycle, / to search, t to sort, esc to close` (no matches: `/ to search, esc to close`; while typing:
  `type to filter · ↓/enter to select · esc to clear`). Search placeholder "Search skills…" (typing any char starts a search).
- Rows: icon + display name, meta `[locked by <policy|flag|plugin|author> | reserved name]`, word (`name-only`/`user-only`),
  source (`plugin`, `mcp`, `memory store`, `built-in`, `user`/`project`…, claude.ai synced), `~N tok`.
- Order: by source label then name; `t` → by token cost desc.
- States cycle on Enter/Space: **on** ✔ → **name-only** ✔ → **user-invocable-only** ("user-only") ✔ → **off** ◯; locked rows don't cycle.
- Notes: "Plugin skills are managed via /plugin"; claude.ai name-collision sentence; reserved-name note "Settings can't store an
  entry named X…"; safe mode "Custom skills are disabled in safe mode — … to load them".
- Empty: **No skills found** hint "Create skills in .claude/skills/ or ~/.claude/skills/". Cloud session variant is read-only.
- Save on Esc: writes diff to **`localSettings.skillOverrides`** (`.claude/settings.local.json`) via `Hn("localSettings",…)`,
  then `uP()` refresh; message `Updated N skill overrides` / `No changes` / `Failed to save skill overrides: …`.
  Effective state = locked → local override → project/user `skillOverrides` → `on`.

## 4. `/hooks` — read-only viewer [obs]
- Screens: list → (All events) event picker → matcher list → hook list → hook detail; plus cloud-consent screen for `--cloud`.
- List: title **Hooks**, subtitle `N hooks on M events` / `no hooks yet` / `managed hooks only`; guide `Enter to view · Esc to
  close`. Body note "This menu is read-only. To add or change a hook, edit settings.json or ask Claude. Learn more"
  (https://code.claude.com/docs/en/hooks). Per configured event: bold event name + dim summary heading, rows
  `[Source] <command>  · plugin · matcher · type`; last row **All events**.
- Source tags: `[User]` `[Project]` `[Local]` `[policySettings]` `[Plugin]` `[Session]` `[Built-in]`; matcher sort order local →
  project → user, plugin/built-in last.
- Event picker: title "Hook events", subtitle `N events · M with hooks`, rows event + `N hooks` + description;
  guide `Enter to open · Esc to go back`.
- Matchers: title `<Event> - Matchers`, rows `[sources] matcher|(all)  N hooks`. Hooks: title `<Event> - Matcher: <m>`, rows
  command + type, description `User Settings`… Empty: "No hooks configured for this event" hint "To add hooks, edit settings.json
  directly or ask Claude".
- Detail: title `<Event> · <matcher|matches everything>`; rows Source, Plugin, Status message, and per type Command / Prompt /
  MCP tool / Script (labels "Command hook", "Prompt hook", "Agent hook", "HTTP hook", "MCP tool hook", "Script hook"); footer
  "To change or remove this hook, edit <file> or ask Claude." / plugin / built-in / session / policy variants. `Esc to go back`.
- Banners: safe mode; managed-only ("Only hooks from managed settings run here."); `disableAllHooks` ("While hooks are disabled
  no hook command runs… To turn hooks back on, remove "disableAllHooks" from settings.json or ask Claude.").
- Writes: none (except cloud-consent answer, saved per machine).

## 5. `/agents` — removed [obs]
Hidden `local` command returns: "The /agents wizard has been removed. Ask Claude to create or update subagents for you … or edit
the files directly: • .claude/agents/ (this project) • ~/.claude/agents/ (all projects) Docs: https://code.claude.com/docs/en/sub-agents".
(`claude agents` CLI subcommand now means background agents.)

## 6. `/memory` — "Memory" [obs]
- Title **Memory** (color `remember`), list of rows (`zo`), docs link https://code.claude.com/docs/en/memory. Last-chosen row
  remembered per session.
- Toggle rows at top (↑ from first file row): **Auto-memory** (on/off; dim reasons "unavailable for current model", "off in safe
  mode") → `userSettings.autoMemoryEnabled`; **Auto-dream** ("off while auto-memory is off", `last ran …`/`never`/`running`) →
  `userSettings.autoDreamEnabled`; **Write to synced project memory** (org feature).
- File rows (`nAn`): **User instructions** "Saved in ~/.claude/CLAUDE.md" · **Project instructions** "Saved in ./CLAUDE.md"
  (or "Checked in at ./CLAUDE.md" in git) · other loaded files (`.claude/CLAUDE.md`, `CLAUDE.local.md`, rules) by relative path,
  `@-imported` children indented `L name`. Missing user/project files still listed (created empty on open).
- Folder rows: **Open auto-memory folder**, **Open team memory folder**, **Open <agent> agent memory** (`<scope> scope`),
  **Open synced project memory: <mount>**, org picker **Sync memories from: <project>**.
- Enter on file: creates file if absent, opens `$VISUAL`/`$EDITOR`/default editor; message `Opened <path>` + editor hint, or
  "Couldn't open X in an editor. If no editor is configured, set $EDITOR or $VISUAL, then run /memory again." Esc →
  "Cancelled memory editing". Remote: "Memory files aren't available over this remote connection".

## 7. `/reload-plugins` [obs]
Text: `Reloaded: N plugins · N skills · N agents · N hooks · N plugin MCP servers · N plugin LSP servers` (+ `X installed but not
applied|resolved`), per-plugin "`<src>` re-read from its folder", "N errors during load. Run /plugin for details.", official
marketplace unreachable note. Cache guard (no `--force`): "This reload changes MCP tools (X) [and may add the LSP tool] — your next
message will re-read the whole conversation instead of using the cache. Run /reload-plugins --force to apply." Headless note:
"Plugin MCP server changes take effect in your next session."

## 8. `/reload-skills` [obs]
`Reloaded skills: N skills available (A added, R removed | none added or removed[; custom skills are disabled in safe mode]).`

## 9. `/skill-doctor` [obs]
Interactive → `/plugin` Stats tab with redirect banner. Headless → same report as plain text (§2.7) or "Skill usage reports are
not available on this connection."

## 10. `/output-style` [obs]
- Interactive: no picker of its own — shows `/output-style moved → Output style in /config` and opens `/config` (Config tab);
  there the picker is "Preferred output style" ("This changes how Claude Code communicates with you", "Loading output styles…").
- Headless text: no arg → `Output style: <current>` + `Available styles:` list `- name (current): description` + `Usage:
  /output-style <style>`; unknown → `Unknown output style "x". Available styles: …`; same → `Output style is already X`;
  set → writes **`localSettings.outputStyle`** → `Output style set to X`.

---

## 11. Action → Agent SDK host route

| CLI action | Route for Waifufy Code | Notes |
|---|---|---|
| List MCP servers + status | `Query.mcpServerStatus()` (name, status, error, config, scope, source, tools[name,description,annotations]) | SDK status enum lacks `cached`, `needs-approval`, `unconfigured`; no capability counts (resources/prompts), no protocol version, no errorCode → derive "config issue"/"not configured" from `error` text [inf] |
| Group by scope | `McpServerStatus.scope`/`source` + read `.mcp.json`, `~/.claude.json` (`mcpServers`, `projects[cwd].mcpServers`) for paths | |
| Reconnect / reconnect all | `Query.reconnectMcpServer(name)` (loop for all) | |
| Enable / Disable | `Query.toggleMcpServer(name, enabled)` | persists to `~/.claude.json` like CLI [inf] |
| View tools | `mcpServerStatus().tools` | |
| Tool detail | name/description/annotations from status | **Parameters not available** (no input schema in SDK status) [obs] — `supportedCommands` doesn't help |
| Authenticate / Re-authenticate | spawn `claude mcp login <name> [--no-browser]` (CLI subcommand exists [obs]), then `reconnectMcpServer` | no SDK method [obs]; text `/mcp` in SDK can't run OAuth panel |
| Clear authentication | spawn `claude mcp logout <name>`, then `reconnectMcpServer` | |
| claude.ai connector auth / clear | open `https://claude.ai/settings/connectors` in browser [inf URL], then reconnect | |
| Add/replace session servers | `Query.setMcpServers(record)` (session/dynamic only) or write `.mcp.json` / `claude mcp add` | |
| Plugin list (installed) | `system/init.plugins[]` + `plugin_errors[]`; `reloadPlugins().plugins`; or spawn `claude plugin list --json [--available]` | init has no enabled/disabled/scope; JSON CLI does [obs option] |
| Discover / browse marketplace | spawn `claude plugin list --json --available`, `claude plugin marketplace list --json`; or read `~/.claude/plugins/known_marketplaces.json` + marketplace caches | no SDK method |
| Install / Uninstall / Update / Enable / Disable | spawn `claude plugin install|uninstall|update|enable|disable <p> [-s scope] --json`, then `Query.reloadPlugins()` | or write `enabledPlugins` in settings for enable/disable only |
| Configure options | spawn `claude plugin configure <p> --values-stdin --json` | |
| Marketplace add / remove / update | spawn `claude plugin marketplace add <src> [--scope]` / `remove <n>` / `update [n] --json` | |
| Errors tab | `system/init.plugin_errors`, `reloadPlugins().error_count` | messages only (no guidance) |
| Stats / skill-doctor | send `/skill-doctor` text through the SDK (headless `local`, `supportsNonInteractive`) and render the text | [inf: enabled in SDK mode via `_e()`] |
| `/reload-plugins` | `Query.reloadPlugins({ holdOnCacheImpact: !force })` → show `held`/`cache_impact` like the CLI warning | |
| `/reload-skills` | `Query.reloadSkills()` → diff names vs previous list for "N added, R removed" | |
| `/skills` list | `supportedCommands()` / `reloadSkills().skills` (name, description) + scan `.claude/skills`, `~/.claude/skills` for source/size | no token estimate or lock source from SDK; compute `~tok` locally [inf] |
| `/skills` cycle state | write `skillOverrides` in `.claude/settings.local.json` (values `on`/`name-only`/`user-invocable-only`/`off`) then `reloadSkills()` | `updateSettings('localSettings')` allowlist is `outputStyle` only → write the file directly [obs doc] |
| `/hooks` viewer | read `hooks` from `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, managed settings, plugin `hooks/hooks.json`; event list hard-coded | read-only, same as CLI; session/built-in hooks not visible [obs] |
| `/agents` | removed; list via `Query.supportedAgents()`, edit `.claude/agents/*.md`, `~/.claude/agents/*.md` | |
| `/memory` file list | read `~/.claude/CLAUDE.md`, `./CLAUDE.md`, `./.claude/CLAUDE.md`, `./CLAUDE.local.md`, rules, `@imports`; `getContextUsage()` lists loaded memory files [inf] | |
| `/memory` open file | open in system editor (Tauri shell) or in-app editor; create if missing | |
| Auto-memory / auto-dream toggles | write `autoMemoryEnabled` / `autoDreamEnabled` in `~/.claude/settings.json` | not in `updateSettings` allowlist |
| `/output-style` list | `Query.initializationResult()` → `output_style`, `available_output_styles`; `reloadOutputStyles()` | |
| `/output-style <s>` | `Query.updateSettings('localSettings', { outputStyle: s })` | live-applies [obs doc] |
| Org memory picker, cloud hook consent, claude.ai handoff | not possible headless (needs CLI-internal state) | |
