# Release 0.1.114 verification

This release publishes the current terminal retirement, observation batching,
transport pressure, activity publication and Orchestrator safety/readiness repairs.
The [performance review](performance-orchestrator-overhaul-2026-09-10.md),
[conditional-close investigation](orchestrator-inactive-close-investigation-2026-09-10.md),
[capability audit](orchestrator-capability-audit-2026-09-10.md) and
[repair roadmap](orchestrator-repair-plan-2026-09-10.md) record the implementation,
measurements and remaining work. Planned roadmap packages are not release claims.

The production workflow gates publication on the full release suite, native
Windows file paging, the renderer build, embedded Codex and voice payloads,
installer/update-feed verification, and packaged voice, workspace, closure and
navigation checks. Local release logs use `.tmp/release-0.1.114-*.log`.

Local acceptance passed the production renderer build, native Windows paging,
and all 50 release checks, including 2,010 backend tests and the performance,
frontend, terminal, telemetry and voice suites. The existing Vite large-bundle
advisory remains. The local build uses the pinned Codex 0.144.0 payload from
`.tmp/codex-release-cli`; the user's newer global CLI is left intact.

Free-form model factual accuracy, child approval correlation, aggregate memory
budgets and the other open roadmap items remain unresolved. Fixture checks do
not certify physical microphone hardware, foreground animation timing or paid
model/native-provider behavior. Publication makes the update available without
installing it or restarting an active workspace.
