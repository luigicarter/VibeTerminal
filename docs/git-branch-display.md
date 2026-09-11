# Git branch display

The toolbar's Git button opens a read-only view of local branches and detached worktrees. It does not switch branches, fetch, push, or contact GitHub. Upstream counts describe the remote-tracking refs already on disk; the popup labels that boundary explicitly.

## Behavior

- The popup opens below the top toolbar, is rendered outside clipping ancestors, and is constrained to the viewport. Long branch names and folder paths wrap.
- Only the displayed project is polled, every 7.5 seconds and on window focus. While the popup is open, its overview supplies the toolbar summary too, so the current-branch marker and toolbar update together. Refresh requests a fresh local snapshot; the popup shows its update time.
- Each component mount and open/closed state owns its asynchronous observer. Disposal rejects late success and error responses, including project A → B → A and close/reopen races. Overlapping refreshes from the same observer are coalesced.
- Working-tree changes and upstream divergence are separate fields. Clean working trees still show ahead/behind counts. Binary and empty-file changes retain a changed-file count; conflicts have an explicit label. Zero text-line totals do not imply no changes.
- No upstream, missing upstream, and in sync with the fetched upstream have different labels. Remote-only branches are not listed under “Local branches.”
- Detached worktrees retain their commit abbreviation, changes, folder and current marker. A branch forcibly checked out in multiple worktrees retains each location. Worktree folder buttons use the existing open-in-file-explorer API.
- Failed Git inspections show errors rather than a successful incomplete list. Failed worktree scans preserve their folder and error. Failed text-diff reads retain status/file counts but mark line totals unavailable; scan-limited counts are labeled partial.
- The popup is a dialog with a named, focusable list. Arrow keys, Page Up/Down, Home and End scroll the list. Tab stays within the dialog, Escape/outside pointer closes it, and focus returns to the trigger. Refresh remains focusable while busy, and disappearing worktree controls return focus to the list.

## Implementation

`frontend/components/GitBranchDisplay.tsx` owns display and polling, with `gitBranchDisplay.css` for layout and `frontend/gitDisplayState.ts` for the request observer, labels and positioning. `App.tsx` mounts it using the project's identity and path as a key. The Changes tool receives its project path directly rather than waiting for the summary poll.

`backend/codeChanges.cjs` resolves repository roots before calculating repository-wide counts. Root and subfolder requests therefore use the same scope. Concurrent reads share in-flight summaries; Git processes and per-overview worktree scans are limited to four. Clean working trees need only the root lookup and status command. Untracked file reads are asynchronous and bounded to 2,000 files, 2 MiB per file and 16 MiB per scan; oversize/unreadable content marks line totals partial. Git output has a hard 1 MiB cap and overflow is an error. UTF-8 is decoded after joining byte chunks, and worktree paths use NUL-delimited porcelain output.

These reads do not form a Git transaction: files and refs can change during a scan. A detected current-branch change between status and worktree inspection causes one retry, followed by an explicit error if the identity is still inconsistent. Other worktree identity mismatches are shown as unavailable. There is no persistent result cache that delays a manual refresh.

## Verification

- `npm run test:git-branches`: real temporary repositories cover unborn branches, clean-but-ahead branches, missing upstreams, remote-only exclusion, Unicode linked paths, unavailable worktrees, detached edits, binary files, conflicts, subfolder scope and scan limits. Controlled module tests cover ref/status/worktree/diff failures, output overflow, request sharing, concurrency, response ordering and popup positioning.
- `npm run smoke:backend:code-changes`: existing status/no-HEAD smoke checks plus the backend branch regressions.
- `npm run smoke:electron:git-branches`: isolated hidden Electron fixtures exercise popup geometry at 1440×960 and 1024×700, a long branch list and a single branch, keyboard scrolling/focus/escape, automatic updates after a real branch switch, manual refresh, and project switching.
- `npm run build`, workspace smoke and app-runtime smoke check integration.

The Electron check uses measured DOM geometry and real interactions by default. `--screenshots` explicitly opts into a visible QA window and PNG capture; hidden-window screenshot capture was not usable on the tested Windows runtime. Test repositories, profiles and results live under `.tmp/git-branch-display-smoke/`; the harness stops its own Electron process tree.

September 10 acceptance: the build, eight backend/frontend regression groups, existing code-change smoke, workspace smoke, app-runtime smoke and hidden Electron checks passed. The final Electron run (`.tmp/git-branch-display-smoke/1789065220669-14640/results.json`) measured the long popup at y=107 through 567 in a 1440×960 viewport; after resizing to 1024×700 the single-branch popup stayed inside the window at x=556 through 1016. Keyboard scrolling, focus containment/return, automatic branch refresh, manual refresh and switching projects all passed.

These are source/build repairs. No installer or release was produced, and the installed application was not replaced.
