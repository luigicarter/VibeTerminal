# Release 0.1.115 verification

The September 10 workflow was cancelled before publication. GitHub's latest
published release remained 0.1.113 when checked on September 11. The 0.1.115 tag
is retained; its changes are carried forward into 0.1.116.

This candidate carries the terminal resource and Orchestrator repairs described
in the [0.1.114 review](release-0.1.114-review.md), with a release-fixture repair.
There are no application logic changes after that candidate's local acceptance.

The 0.1.114 CI run stopped before packaging/publication because the closure
fixture never observed its four dormant panes. The fixture seeded localStorage
after preload appeared but before React was necessarily initialized, allowing
initial persistence to overwrite the seed before reload. Seeding now runs in
the replacement document before application scripts. All closure, descendant
termination and late-start assertions remain unchanged. The earlier CI log
contained only the setup timeout, so it cannot conclusively establish which
startup event won that race. Failure-state and Electron logs for closure and
navigation are now retained by the workflow to diagnose future failures.

The failed 0.1.114 tag remains immutable. Local 0.1.114 acceptance included all
50 release checks, 2,010 backend tests, 136 source/package file comparisons,
installer/feed verification and packaged voice, workspace, closure and performance
navigation. The repaired closure fixture is checked against both source and the
same packaged application. The 0.1.115 production workflow repeats the complete
clean Windows release and packaged acceptance gates before publication.

The [capability audit](orchestrator-capability-audit-2026-09-10.md) and
[repair roadmap](orchestrator-repair-plan-2026-09-10.md) still describe open work.
Fixture acceptance does not certify physical microphone hardware, foreground
animation timing or free-form model accuracy. Publication does not install the
update or restart an active workspace.
