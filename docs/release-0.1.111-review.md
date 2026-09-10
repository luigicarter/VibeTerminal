# Release 0.1.111 verification

This records the first fixture-correction attempt for the runtime reviewed in
[the 0.1.110 performance and harness audit](release-0.1.110-review.md).
The 0.1.110 tag did not publish an installer: its Windows CI run passed 49 release
gates and 1,965 of 1,966 backend/voice tests, then correctly stopped at a file-page
fixture assertion. The failed tag is retained without rewriting published Git refs.

The fixture compared a canonical file bookmark with its original temporary path.
Windows CI can supply a short-form temporary directory, while the file service
returns its canonical path. This comparison worked with the ordinary local path
and failed with an aliased path. The fixture now canonicalizes its temporary parent
and retains the underlying mock assertion when reporting failures.

The correction was insufficient for native Windows 8.3 names: synchronous realpath
resolves junctions but preserves these short names. CI still failed the same
assertion. [Release 0.1.112](release-0.1.112-review.md) uses the native asynchronous
resolver and includes an actual 8.3 reproduction. This tag did not publish.

An explicit Windows junction reproduction fails with the original fixture and
passes both tests with the correction. Evidence is in
`.tmp/release-0.1.111-alias-before.log` and `-alias-after.log`. Production file paging,
cursor validation, bookmark commitment and source-change protections are unchanged.

The application code is identical to the locally accepted 0.1.110 runtime; only
the test fixture and release version/docs change. Its 50 local gates, 53 frontend
tests, packaged checks, current live-model evidence and measured performance
results remain documented in the linked audit. The corrected full backend suite
passes all 1,966 tests again. GitHub rebuilds this tag and repeats all release and
packaged checks before publishing the installer and update feed.

Publication preserves active workspaces. Installed users apply the update through
Check for update, Update and Restart.
