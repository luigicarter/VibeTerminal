# Release 0.1.113 verification

This release publishes the current Claude task telemetry and terminal scrollback
repairs. Claude observers forward bounded native task metadata, settle completed
children and retain background activity. Terminal attachment restores decoded
cells with a shared 5,000-row scrollback limit instead of retaining a byte suffix
that redraw traffic could evict.

The release includes the generated Node/Windows hook regressions, terminal replay
tests and Electron scroll checks. The production workflow gates publication on
the full release suite, installer/feed verification and packaged runtime checks.

Release preparation reproduced a missing `@xterm/headless` dependency in the
packaged PTY helper. The package now explicitly unpacks the headless decoder,
serializer and shared display JSON beside that helper, with artifact checks for
their required files. The closure fixture also encountered startup output that
invalidated its input evidence. Its setup now rereads and retries only explicit
`stale-observation` / `not-dispatched` receipts; accepted or uncertain sends are
never repeated, and production input safeguards are unchanged.

Local acceptance verified the production renderer build, all 135 source/package
runtime files, the 0.1.113 installer and matching SHA-512 update feed, packaged
voice inference, workspace/PTY command delivery, pane and descendant termination,
navigation and project file preservation. All 50 release checks passed, including
1,980 backend/voice tests, 53 frontend tests and 14 terminal scrollback regressions.
The native Windows file paging check also passed. Logs are retained under
`.tmp/release-0.1.113-*.log`. Physical microphone hardware and paid model turns
were not exercised by these fixture checks.

See [the Claude investigation](claude-terminal-status-investigation.md) for the
remaining child approval matching gap and native/model verification limits.
Claude's updated observers take effect in newly launched panes after installation.
Publication itself does not install the update or restart an active workspace.
