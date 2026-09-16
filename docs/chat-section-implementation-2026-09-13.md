# Terminal-format Chats implementation

Chats now appears directly below Projects in the desktop sidebar. Opening a chat reveals its existing terminal, or resumes its exact saved native conversation in a terminal pane. The section itself is published in [v0.1.121](release-0.1.121-review.md); the provenance rule this document describes — one flat list holding only the conversations started from the Chats section, recorded by a persisted `chat` flag and an `origin` field, so the list starts empty and no folder scan fills it — is published in [v0.1.123](release-0.1.123-review.md). Additional hardening from the [design and recovery plan](chat-section-plan-2026-09-13.md) remains open as listed below; the full roadmap is not a claim of completed implementation.

## Visibility (2026-09-16)

The section is hidden by default. `App.tsx` reads one renderer switch once at module load — `localStorage['lina:chats:visible']` — and renders `<ChatsSection>` only when its value is exactly `'1'`; anything else (missing, another value, storage throwing) means hidden, and the sidebar's `aria-label` reads `Projects` instead of `Projects and chats`. With the section absent, the Projects list keeps its base `flex: 1 1 auto` and grows to the sidebar footer: the sidebar height cap now lives in a single rule guarded by `.sidebar:has(.chats-section:not(.collapsed))`, so hiding and collapsing take the same path. Nothing behind the section changed — the catalog, workspace checkpoints, drafts, recovery and exact native resume all keep running, new panes still record their `chat` flag, and every existing `origin === 'chat'` row reappears in place the moment the switch is set. Two Electron smokes cover both states: `smoke:electron:orchestrator-navigation` asserts the hidden default at 1440×960 and 1024×640 (no `.chats-section`, the `Projects` label, and the Projects list reaching the footer), and `smoke:chats` sets the switch in the renderer and reloads before its first read, so the whole shown path — rows, rename, recovery, picker, collapse — is exercised unchanged.

## Implemented behavior

- One flat list of chats across every project, ordered by latest activity: a chat is only a conversation started from the Chats section itself (its New chat picker, or opening one of its rows), recorded by a persisted `chat` flag on the pane and an `origin` field on the catalog row. Panes opened from the terminal launcher, the Orchestrator, or the spare-pane keeper are terminals and never appear; neither do rows found by a folder scan. Because no earlier row can be proven to be a chat, the list starts empty after this upgrade, and every prior catalog row is retained in the database, just hidden. The sidebar no longer scans folders for provider history (the backend refresh API is kept, with no UI caller).
- Each row shows `provider · status · folder label`, where the label is the owning project's name or the conversation's folder. Local metadata search, incremental row display, New chat provider picker, sidebar title overrides, and archive/unarchive remain. The section collapses to its header, and that choice is remembered in `localStorage` (`lina:chats:collapsed`); Projects takes the reclaimed height.
- Existing agent terminal views remain the interactive chat format. The history viewer uses a monospace terminal presentation without message bubbles. Fusion and Open Fusion retain their existing specialized panes.
- A chat's native identity and launch settings survive pane closure and project removal, and the row stays in the single list after its project is closed. Plain shell panes are excluded from Chats.
- A live chat focuses its existing pane. A paused/exited chat uses the existing generation-fenced resume route. Missing history produces an error while preserving the row, instead of silently starting fresh. Pending native IDs can be retried through exact root confirmation.
- Custom provider profile/model and Fusion/Open Fusion settings are recorded when known. New Open Claude Code chats created from Chats resolve the selected default model to a concrete profile. Legacy `default-custom` histories cannot silently choose a different profile through the sidebar opener.

The sidebar has independently scrolling project/chat regions. Compact rules leave room for chat rows on shorter windows. Search, new-chat selection, row menus, rename, and the history dialog are keyboard-accessible. Titles are rendered as text, and native prose in the history view is rendered in a `pre`, not executed as markup.

## Persistence and recovery

`backend/chatStore.cjs` owns `userData/chat-workspace.sqlite`. The separate Electron-as-Node worker uses the bundled `node:sqlite`, WAL, FULL synchronization, transactions, a schema version, and startup validation. There is no new npm runtime dependency. Provider transcripts remain in their original native stores; credentials are not copied into the catalog.

The database stores the chat catalog, project/Multi workspace snapshot, current pane bindings, draft revisions, and bounded recovery copies. Initial startup imports valid legacy workspace localStorage once. Later startup hydrates the renderer from the database. localStorage remains a compatibility/UI copy, not the recovery authority. A corrupt legacy browser snapshot does not hide an otherwise readable database.

Runtime identity events are captured in the backend independently of a mounted terminal. A pending B/C selection is retained even when an older renderer checkpoint arrives. Previous A/B chats remain catalog entries. Launch-token and snapshot-revision checks reject stale observations. Retired renderer clients cannot overwrite a newer client's workspace checkpoints.

App-owned Fusion/Open Fusion drafts are keyed to native conversation identity, with provisional owners for new panes. Draft writes are revision-checked and batched at 250 ms. Pane closure keeps the draft. A first native identity promotes its provisional draft; a new launch in the same pane gets a distinct provisional owner. A draft only has a durability guarantee after its write was acknowledged.

Each worker run begins with an unclean marker, and the shutdown routine records the intent to exit before it does anything else. The recovery pause is keyed on that marker, not on every shutdown deadline being met: saved agent panes reopen paused only after an exit that never reached the routine at all. A shutdown that started and then ran out of time on a slow step is still a shutdown, and a Windows session end - an OS restart or log-off with Lina open - records its intent and reopens its panes started. Paused panes are there for deliberate recovery; their previous prompts are not replayed. The run record keeps the previous run's outcome and the steps that missed their deadline, so the next diagnosis can say why. A renderer reload within a living main process reattaches to its existing terminal generation. Normal restarts preserve the previous started/paused intent. Standalone terminal launch admission is limited to two concurrent preparations.

The main close/Quit/update paths now share an idempotent preparation routine. It asks the renderer to flush drafts/workspace state, cancels new launch preparation, stops dispatch, sends host shutdown requests, and waits for host pipes to close before forced termination at the deadline. Further start/input work is refused while shutting down. The final database marker records whether the shutdown was clean and which steps missed their deadline; failed flushes/timeouts retain an unclean outcome without making the next launch a recovery. Windows session-end notifications request the same best-effort preparation, and the request is recorded before the routine waits on anything. PTY hosts also retire their owned terminals when their parent pipe closes unexpectedly.

Shutdown cannot prove that a third-party CLI has flushed all of its own files. Native unsent terminal input and interrupted external tool effects are outside Lina's database transaction.

## History and backups

The chat service reuses the existing native history discovery/reader helpers. Known scopes include catalog histories after a project/pane is removed. Refresh visits folders separately rather than spending one global 64-scope allowance across the whole catalog. Failure of native history does not discard existing catalog rows.

View history reads a bounded recent native page, currently requesting up to 64,000 characters subject to the reader's limits. It saves a read-only recovery copy, also refreshed opportunistically when opening a saved chat. Each stored copy is capped at 2 MiB; the aggregate cap is 200 MiB, evicting oldest copies only. Limited coverage and fallback copies are labeled. Full-history paging/search remains available through the existing Workspace tools history reader.

If the native file disappears after a copy was captured, View history can display the timestamped copy. It is not a substitute native session and cannot recreate an agent's tool/context state. Opening the missing native session still fails explicitly.

A consistent SQLite backup is scheduled at bootstrap when the last backup is more than a day old. The new backup is validated before rotation. Files are `chat-workspace.backup.sqlite`, `.1`, and `.2` in userData. These protect Lina metadata/drafts, not complete provider stores. Invalid/newer databases are preserved and reported; there is no destructive empty-reset fallback.

## Codex Web

Codex Web is now a distinct threaded provider in the shared catalog. Discovery and exact confirmation use its app-owned `codex-web/codex-home`, and never fall back to the global Codex home. The history reader decodes its native Codex prose format. Both the frontend launch compiler and the provider startup preparation preserve `codex-web resume <exact-id>`; mismatched identities are rejected.

The existing lifecycle/child-tracking capability limits remain unchanged. This work does not certify every native `/new` transition or live ChatGPT account/auth state. Private-home discovery, transcript decoding, exact command construction and cross-home rejection are covered by isolated tests.

## Bugs found and fixed during review

| Finding | Repair |
| --- | --- |
| Paused panes retained a placeholder `threadRef` with no ID, shadowing their valid `resumeRef` and creating a second row. | Only an ID-bearing current ref takes precedence; paused placeholders reuse the saved chat and draft owner. |
| Pane checkpoints could overwrite a custom sidebar title. | Preserve title overrides independently of generated native titles. |
| Exited panes could be treated as merely needing focus. | Use the existing runtime-aware resume decision before focusing. |
| Missing native history could silently create a new conversation. | Strict resume policy for normal App launches and exact sidebar confirmation. Explicit New chat remains available. |
| An unconfirmed saved candidate could stay blocked forever. | Reconfirm the exact candidate on retry and clear its pending catalog state after success. |
| Codex Web startup preparation replaced a compiled resume command with the plain launcher. | Preserve and validate the exact native ID through provider preparation. |
| An older renderer client could checkpoint after a newer renderer took over. | Retire replaced client identities in the worker and reject their later writes. |
| Closing a pane discarded its only app-owned draft. | Retain chat-owned drafts; wait for the new workspace checkpoint before reporting a durable close. |
| A new provisional conversation could reuse the previous launch's draft key. | Include the launch token in provisional draft ownership. |
| A Windows Update restart with Lina open ended the session; the window's `query-session-end` handler starts the shutdown routine without awaiting it, so Windows terminated the process before the clean marker was written. The next launch judged the exit unexpected, reopened every agent pane paused, and the renderer saved that paused state, making it permanent. Any normal quit that missed one of the four shutdown deadlines ended the same way. | Key the pause on a recorded shutdown request instead of on every deadline being met, and keep the steps that missed one on the run record. |
| Native metadata could advance a row revision while its rename form was open. | Submit the latest observed row revision without replacing the typed title. |
| Short windows left no actual room for chat rows. | Compact sidebar chrome and enforce space for the chat list; assert its measured height in Electron. |
| The hidden Electron fixture's anonymous BrowserWindow subclass was omitted from normal window enumeration. | Track the fixture's windows explicitly so tests receive real runtime and PTY broadcasts; require actual output and unchanged process identity. |

## Verification

All tests use isolated fixture directories. Live provider-account turns were not made.

| Check | Result / evidence |
| --- | --- |
| Desktop TypeScript and Vite production build | Passed. The existing large-chunk warning remains informational. |
| Orchestrator/backend regression command | 2,371 tests passed, in addition to its preliminary performance suite. Log: `apps/desktop/.tmp/chat-section-orchestrator-tests.log`. |
| Frontend test suite | 65 tests passed. Log: `apps/desktop/.tmp/chat-section-frontend-tests.log`. |
| Focused chat/store/provider/launch/close/project group | 54 tests passed. Includes actual process termination after a committed SQLite write, pending selection persistence, private-home isolation, exact command preservation and backup validation. |
| Dedicated `test:chats` command | 36 tests passed after adding coverage for retired renderer clients, three-backup rotation, future schemas, recovery-copy limits and two-at-a-time startup. Included in the release-check registry with `smoke:chats`. |
| Source two-process resume fixture | 30 panes passed, including both Fusion planners, Open Fusion and Codex Web. Run: `apps/desktop/.tmp/session-resume-smoke/1789284945046-6676`. |
| Chat UI/crash/renderer-reload fixture | Three real Electron processes passed. A real PTY ran an isolated fixture program; a forced app exit retired its foreground child; the exact chat/title/draft recovered; renderer reload reused the same generation/PID; native history loss used a labeled copy; archive retained the terminal. Also verifies rename after a row revision changes and the provider picker in a short sidebar. Final run: `apps/desktop/.tmp/chat-section-smoke/1789285783443-32740`. |
| Visual inspection | Inspected the Chats section below Projects, a resumed terminal with real output, and a shorter window; tests assert list height and placement. Screenshots are in the chat fixture run. |
| Windows ConPTY acceptance | Passed real input/output, natural exit, foreground-child cleanup, bundled OpenConsole selection, and system-host fallback. |
| Windows directory package | Final package: `apps/desktop/.tmp/chat-section-delivery/win-unpacked`. A first extraction attempt hit a Windows EPERM rename; rebuilding from the matching installed Electron distribution succeeded. |
| Packaged-source resume fixture | 30 panes across two processes passed using the final packaged modules/renderer. Run: `apps/desktop/.tmp/session-resume-smoke/1789286010400-31220`. Provider starts are fixture boundaries. |
| Packaged SQLite and file parity | The final packaged Electron executable recovered an acknowledged draft using Node 24.19.0 / SQLite 3.53.3. Sixteen files matched source/build, including both compiled JS/CSS bundles and the backend/shared/preload/HTML files. Report: `apps/desktop/.tmp/chat-package-verification.json`. |

These initial packaged checks did not certify an installed live-account session, and the installed application was not replaced. The later complete-work release, its clean-runner checks and verified public assets are recorded in [the v0.1.121 release review](release-0.1.121-review.md).

## Remaining edge cases and follow-up plan

These are explicit limits of the current implementation, not silently recovered states:

| Priority | Remaining work | Required next check |
| --- | --- | --- |
| High | Full app-owned send/steer transaction journal. Draft persistence does not establish whether a fire-and-forget send reached its provider immediately before a crash. | Persist submission identity before transport and reconcile uncertain outcomes without auto resend. Test a kill on both sides of the write/ACK boundary and newer drafts typed during sends. |
| High | Provider-specific graceful interruption/flush acknowledgments, rather than host exit alone, and actual updater/Windows logout interruption tests. | Test each host's provider-specific stop contract in a disposable environment; retain explicit timeout/unclean outcomes. |
| High | A guided backup-restore UI and schema-upgrade/downgrade recovery. Current startup preserves unreadable files and offers Retry, but does not automatically restore a backup. | Restore into a separate verified store; retain original database/sidecars; test corrupt DB, missing backup, disk full and interrupted restoration. |
| Medium | Full physical provider-store binding and folder relocation workflow. Provider/home namespaces are isolated today, but custom root relocation and historical profile ambiguity need explicit resolution. | Test renamed/missing folders, changed environment homes and two historical stores containing the same native ID; never guess from a title or folder recency. |
| Medium | Large-catalog backend pagination and fair per-provider refresh scheduling. Current list transport returns catalog metadata and the UI displays rows progressively. | Measure 10,000 chats/100 scopes; paginate before IPC and keep search/filter results complete under churn. |
| Medium | Continuous recovery-copy refresh and optional full native backups/attachment retention. Current copies are bounded recent prose captured on open/read. | Verify source-revision changes, eviction, attachment loss, and explicit full backup restore without claiming prose copies restore native context. |
| Resolved in release review | Legacy Electron QA workspace seed helpers now use the durable checkpoint API before reload, via `scripts/qa/workspace-fixture.cjs`. | The release-gate runs cover migrated native launch, project navigation/closure and terminal-board fixtures. See the [0.1.118 release review](release-0.1.118-review.md). |
| Provider limit | Native unsent TUI text is not captured by recording raw terminal keys. Empty native `/new` without a trustworthy ID and provider-private pending tool state may not be recoverable. | Add only verified provider draft/selection adapters, with versioned native fixtures. No keystroke recording or automatic prompt replay. |

Prioritize the high items before advertising lossless crash recovery or automatic recovery of in-flight work. The broader plan contains the full recovery matrix and acceptance targets. Listing/opening persistent terminal chats, keeping acknowledged app drafts, and recovering committed workspace/native identity are the implemented foundation.

## Files and commands

The implementation lives in `apps/desktop`: `backend/chatStore*.cjs`, `backend/chatService.cjs`, `shared/chatIdentity.cjs`, `frontend/chatPersistence.ts`, `frontend/chatTypes.ts`, `frontend/components/ChatsSection.tsx` and its CSS, plus the App/preload/lifecycle/history/provider integrations. Tests are in the owning app's `scripts/backend`, `scripts/frontend`, and `scripts/qa` directories.

From `apps/desktop`:

```powershell
npm run test:chats
npm run build
npm run smoke:chats
node scripts/qa/session-resume-smoke.cjs
npm run test:frontend
npm run test:orchestrator
```

Runtime data stays under userData, never the repository. The detailed architectural sources and external lifecycle/storage references remain linked in the [design plan](chat-section-plan-2026-09-13.md#sources).
