# Herdr customization: vault-owned app home

The Herdr app home is `D:/__CODING/personal/__my-vault/.fatih-agentic/herdr/app`,
accessed through `C:/Users/GNERyze/.config/herdr-app`. The installed `fatih`
layout, keys and selected mods are maintained in that app home.

## 1. Owned surface

Live task data, router data, sockets, caches and generated `.d.ts` files are
runtime state and must stay out of Git. Preserve existing configuration and
data when updating the installed mods. Do not run upstream install scripts.

## 2. Mods, pins, licenses

Every vendored file is pinned in `mods.lock.json` with its SHA-256.

| mod | origin | ref | license | delta |
|---|---|---|---|---|
| `agents-stacked` | fedorovvvv/herdr-omp-progress | db4894f5e4b9b5aff56f25a755146ba839cb6334 | MIT | excludes upstream `gpui-kit.d.ts`; `jsconfig.json` is installed |
| `token-usage` | nakamotosai/herdr-agent-panels | c1ce242b6258ce3646e9b5e96a6a3986f57f9950 | MIT | verbatim |
| `convo-log` | nakamotosai/herdr-agent-panels | same | MIT | verbatim |
| `task-sched` | nakamotosai/herdr-agent-panels | same | MIT | starts with an empty seed; scheduling remains inactive until a task is created |
| `panel-buttons` | nakamotosai/herdr-agent-panels | same | MIT | verbatim |
| `session-search` | lucasmen9527/herdr-session-search | 17d48c54… | MIT | removed `--dangerously-skip-permissions` (was the default), the Orca source and its `resumeHome`/`env` wrap; Windows `test -d` replaced with a Node fs probe; display paths normalize `\`; installer/package/test not copied |
| `git` | SimonBystromTableCheck/herdr-mods | 0e9a01bf… | MIT | Windows: shell detected as Git Bash (`bash`) then pwsh/powershell, every `-lic` argv goes through `shPrefix()`, `open` routed per platform, editor default is `notepad` on Windows and `config.json` editor is empty so that applies; `git-conflicts` not installed |
| `servers` | SimonBystromTableCheck/herdr-mods | 0e9a01bf… | MIT | Windows: shell detection (`bash` → pwsh/powershell), `test -d` → Node fs probe, POSIX listing scripts run through the detected shell, URLs open per platform, remove now needs a second press |
| `leader` | SimonBystromTableCheck/herdr-mods | same | MIT | verbatim; binding merged additively |
| `task-board` | native | — | vault | Board + Gantt over one store |
| `ninerouter` | native | — | vault | always-mounted status and lifecycle controls |
| `launch-bar` | native | — | vault | launcher buttons |

`martinkozle/herdr-corral` was reviewed and **not vendored**: the repository
ships no license file and its README calls the recipes the source of truth.
The native `task-board` replaces it.

Upstream licenses are kept beside each mod as `LICENSE-UPSTREAM.txt`.
The OMP progress extensions come from the same omp-progress pin under MIT; they
implement the progress side of the agents row.

## 3. Workspace layout

Files and Changes retain their baseline hidden panel and order. Board and Gantt
open as 1120x720 app windows; five columns clipped in the 368px panel. Their
launcher passes the view to the same task-board store.

The always-visible status row mounts one compact router instance, independent of
the selected panel. Its icon and status open the control window; the Router
launcher and `alt-shift-r` also open that window. Only the compact instance
starts the router automatically; control windows observe and provide actions.

Board, Gantt and router control overlays have an icon-and-label Close button
and support Escape when focused. Both close the instance identified by
`props().overlay`; Escape stops propagation to prevent dismissing a parent
overlay. Closing a router window does not stop the router or remove its
compact status instance.

## 4. Keys

The installed `keys.json` retains the existing bindings and adds:

| key | action | note |
|---|---|---|
| `ctrl-a` | `mod.open:leader` | the Leader mod's own upstream binding |
| `alt-shift-b` | `mod.open:task-board` | board |
| `alt-shift-f` | `mod.open:session-search` | session find |
| `alt-shift-r` | `mod.open:ninerouter` | router panel |

## 5. `task-board` contract

One file, two views, no hidden state:

`data/task-board/board.json` (app home, ignored by Git)

```json
{ "version": 1,
  "tasks": [ { "id": "t-…", "title": "…", "notes": "…",
               "stage": "Brainstorm|Doing|Triage|Review|Done",
               "start": "YYYY-MM-DD|null", "end": "YYYY-MM-DD|null",
               "agent": {"address","space","tab","title","app"} | null,
               "createdAt": "ISO", "updatedAt": "ISO" } ] }
```

Rules:

- Stages must be the five fixed names. Unknown versions, malformed records,
  invalid stages and partial, invalid or reversed dates make the board read-only;
  invalid present timestamps (including null) or agent metadata make the board
  read-only. Parsing and loading preserve absent timestamps and valid extension
  fields. A user mutation sets `updatedAt` to the current time; an existing
  absent `createdAt` remains absent.
- Dates are explicit only. Both date fields may be absent, or both may be null;
  a missing single field or incomplete range is invalid. Nothing invents dates
  or treats `updatedAt` as a plan.
- Board and Gantt are separate copies of the same mod. Writes go through
  `readTextFile` → mutate → `writeTextFile(path, text, expected)`, which is a
  compare-and-swap; a stale snapshot is retried up to three times, then the
  mod reloads and reports the conflict instead of overwriting.
- A monotonic shared revision and four-second disk polling detect changes from
  other views and external writers. A task edited elsewhere while its editor is
  open is not overwritten; the editor retains its input and reports failure.
- A corrupt, incompatible or unreadable `board.json` is never written. Views,
  including the editor and attach dialog, show an actionable read-only error
  with Retry; the editor keeps its entered values while saving is unavailable.
- Delete is two-step inside the card (`trash` arms, `Delete?` confirms); there
  is no silent removal and no undo path that rewrites history.
- Attach observes a live `agents()` entry by `address`; it never starts,
  focuses or kills anything. A task whose agent is absent shows
  `offline · not in this window`. Detach clears it.
- Move is per-task chevrons through the fixed order, clamped at both ends.
- Search filters title, notes, stage, agent title and app.
- States: loading (reading), error (read/CAS failure with retry), empty
  (no tasks yet), success (saved toast), conflict (banner + reload).
- Gantt geometry: explicit rows sorted by start; `Unscheduled` lists every
  task without both dates. Bars are computed from the measured panel width;
  the track is plain rectangular geometry, no dependency on a chart library.

Limits, deliberately accepted:

- Notes are a single-line `Input`; multi-line editing is not in the mod API we
  use here.
- Both views render every task with a plain scrollbar. `ponytail:` upgrade
  path is a virtual list once a board regularly exceeds a few hundred tasks.
- No auto-stage, no auto-complete, no agent-triggered movement.

## 6. `ninerouter` contract

Contract as delivered by RouterBuild from `.fatih-agentic-tools/scripts/ninerouter-vault.rs`:

```
rust-script <VAULT>/.fatih-agentic-tools/scripts/ninerouter-vault.rs status|start|stop --vault <VAULT>
```

- `status` stdout line: `{ok, owned, installed, version, port, baseUrl, healthy, authenticated, running, pid, apiKeyConfigured}`. Before migration `version`/`pid` may be null and `owned`/`installed`/`running` false.
- `start`: `{ok, running, alreadyRunning, pid, version, port, apiKeyConfigured}`. It refuses a foreign listener; the mod shows that refusal and never retries with force/kill.
- `stop`: `{ok, running:false, stopped, pid}`.
- Failure: known exact foreign-listener refusals show a specific conflict; other non-zero exits and errors are generic and actionable. Raw launcher output and exception messages are not displayed.
- The mod calls only `status`, `start`, `stop`. It never calls `api-key` and never prints `apiKeyConfigured` anything but its boolean.
- `running`, `healthy` and `authenticated` are shown separately. The summary is healthy only when the listener is running, healthy, authenticated and owned, with an API key configured.
- The compact instance checks once on load and starts only when status reports `running:false`; a failed status is shown instead of guessing. Other instances only observe until an explicit action.
- Start polls status independently of launcher output pipes for up to four minutes, allowing runtime verification and the launcher's 90-second startup. Pending start blocks duplicate starts. The starting instance disables Refresh while observing; it re-enables after independently confirmed healthy status even if the launcher output is still pending. Other observing instances may refresh. The launcher call has a ten-minute host timeout.
- Regular polling is 15 seconds. Controls reflect in-flight operations; app shutdown never stops the router.
- Dashboard opens only `http://127.0.0.1:<port>` or `http://localhost:<port>`; anything else is refused in the panel.
- Closing the app does not stop the router.
## 7. `launch-bar`

Icon+label buttons for Board, Gantt, Find, Git, Servers, Leader, Usage, Log,
Sched and Router. Board, Gantt and Router open their windows; the rest call
`mod.open`, which toggles that mod's own docked place or overlay.

## 8. Git allowlist for the app home

Track (user-authored): `layouts/*.json`, `keys.json`, `settings.json`,
`themes/*.json`, `mods/**` sources (`.js`, `.mjs`, `.json`, `.svg`, `.md`),
and the custom mods' code.

Ignore: `data/**`, `layouts/.state/**`, `*.sock`, `*.d.ts`, `installed.json`,
`seen.json`, `shared.json`, `view.json`, `window.json`, `update-notes*`,
`frame/**`, `icons/**`, `backups/**`, and every runtime, secret or database
file. Verify with `git check-ignore -v` on explicit paths before committing.

## 9. Runtime requirements and operational boundaries

- Git Bash on PATH supports the git and servers mods' POSIX scripts. The
  session-search indexer requires Node.js 22.5 or later with `node:sqlite`;
  the router control requires `rust-script`.
- `convo-log` clears its own log without a second press. `task-sched` starts
  with an empty seed and fires only while its window is open. `panel-buttons`
  defaults to `sai-panel` IDs and is not used in this layout.
- Git's force-with-lease and hunk/file discard actions remain behind the mod's
  own confirmations. The session-search indexer's `process.kill(pid, 0)` is a
  liveness probe, not a termination request.
- If the router launcher contract changes, update its status parsing and
  displayed fields together. Never expose credentials or raw exception output.

## 10. Visual and interaction principles

The layout uses Herdr's theme tokens and icon character rather than a separate
palette or typeface. The terminal remains the dominant work surface; Board,
Gantt and router controls use compact, quiet chrome.

- Board columns support comparison across stages; Gantt bars represent only
  explicit dates. Accent marks open work and muted marks Done.
- Status colors are paired with text, and authored controls use relevant icons.
- Keep loading, empty, read error, conflict, success and confirmation states
  accessible without discarding user input.
- Contrast, focus behavior and live-agent attachment require their own
  verification; a screenshot alone does not establish those properties.
