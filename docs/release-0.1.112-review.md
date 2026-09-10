# Release 0.1.112 verification

This publishes the unchanged application code from
[the performance and harness audit](release-0.1.110-review.md). Tags 0.1.110 and
0.1.111 were blocked by one Windows file-page fixture assertion and remain intact.
No installer from either failed tag was published.

The second CI log exposed the exact mismatch: a bookmark used
`C:\Users\runneradmin\...`, while the fixture expected `C:\Users\RUNNER~1\...`.
`fs.realpathSync` preserves Windows 8.3 names; `fs.promises.realpath`, which the
production file reader uses, expands them through the native API. The fixture
now uses that same asynchronous resolver.

An actual 8.3 path from Windows' filesystem object reproduced the distinction
locally: the original fixture failed and the correction passed both tests.
Evidence: `.tmp/release-0.1.112-short-before.log` and `-short-after.log`.
This replaces the insufficient junction-only reproduction from the prior attempt.
All 1,966 backend/voice tests pass again. Production paging behavior and its
source/identity checks have not been changed.

CI now runs this focused file-page check before the long release suite, then
repeats the same 50 release gates, build, packaged voice/workspace/close/navigation
checks and update-feed validation. The runtime remains the one verified locally
with all 53 frontend tests, packaged file preservation and the measured performance
improvements described in the audit. The prior source-to-package comparisons
matched all 132 runtime files.

Publication does not restart the user's workspace. Apply the update through
Check for update, Update and Restart.
