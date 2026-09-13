# Release 0.1.120 review

This publishes the complete pending work described in the
[0.1.118 review](release-0.1.118-review.md), with the bootstrap ownership and
mobile dependency fixes in [0.1.119](release-0.1.119-review.md), plus the final
compact-sidebar correction below. Production publication is pending the final
workflow and public-asset verification.

## Retained unpublished candidates

- `v0.1.118` / `502463c`: the Windows workflow stopped on the closure fixture's
  early-start checkpoint race. No release assets were published. Renderer
  bootstrap ownership and fixture readiness were subsequently corrected.
- `v0.1.119` / `4d4ef73`: the startup correction passed the clean runner, but
  [workflow 34771788065](https://github.com/luigicarter/VibeTerminal/actions/runs/34771788065)
  stopped at the compact-sidebar check. Missing provider installations produced
  warnings that consumed too much of the 640-pixel-high sidebar. No release
  assets were published. Both tags remain unchanged for auditability.

## Final UI repair

The chat list reserves at least 44 pixels. Warning/recovery text has a bounded,
scrollable area that can shrink as needed. The navigation fixture now injects
a long provider warning and checks both the chat-row height and that its bottom
remains inside the Chats region. The 1440×960 and 1024×640 cases pass; the latter
retains 44 pixels for chat rows while Projects and Settings remain reachable.
The three-process chat/crash/reload fixture also passes with the correction.

The earlier acceptance includes all 59 local release gates, 2,374 backend tests,
67 frontend tests, 37 dedicated chat tests, all-app builds/checks, and local
packaged verification. Mobile CI is green with 79 tests and mobile-owned xterm
development assets. The final version's installer, workflow and public update
feed are checked before recording publication here.

The local 0.1.120 installer is 536,704,063 bytes; its SHA-512 and size match the
generated update feed. Verification includes 15 bundled alerts and 14 voice
models. The packaged navigation test passes the long-warning layout and
project-file-preservation checks in
`apps/desktop/.tmp/orchestrator-navigation-smoke/1789321695806-48396`.

Hosted account deployment, account-preview wiring, mobile store submission and
the documented native unsent-input/recovery limits remain unchanged. Publication
does not install or restart the user's currently running application.
