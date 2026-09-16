# Account backend: phase 1 implementation and verification

September 12, 2026 (local date; the final test run was September 13 UTC).

For subsequent disconnected login/payment preparation and current security
acceptance, see [account paid readiness](account-paid-readiness.md). The evidence
below remains the original phase-1 record; live deployment is still pending.

**The backend is implemented and locally verified in apps/server. Live Google
VM deployment is still pending.** No cloud resources, public signup, real-user
activity collection, live emails, or notification destinations were enabled.
The backend is available for phase-2 client development; the original phase-1
live rollout gate remains open until its production inputs are provided.

## Delivered

- Bun **1.4.2**, TypeScript, Hono **4.13.7**, Better Auth **1.7.4**, PostgreSQL,
  independent bun.lock and runtime version pin. The server is absent from client
  dependencies and desktop packaging.
- Reviewed auth/MFA schema and application migrations, checksum verification,
  migration serialization, transactional rollback, seeded Full Access and
  Orchestrator plans, and separate application/migration/worker database roles.
- Verified email/password registration, recovery, reset, renewal/logout and
  session revocation. New accounts await approval and receive no product grant.
- Account approval, tier/expiry changes, suspension/reactivation/closure,
  grant/session revocation, owner-only role changes, and protected account
  inspection. Administrative changes and audit records commit together and
  reject stale revisions. Last-owner protection is enforced.
- TOTP enrollment/verification and session-bound MFA evidence. Admin mutations
  require a fresh login and MFA; ordinary members cannot access admin APIs.
  Privileged sessions are revalidated inside the mutation transaction.
- Owned device/session bindings, heartbeat presence, allowlisted optional usage
  events, deduplication, provenance-labelled timelines, summaries, and retention.
- Real liveness/readiness, redacted request logs, private metrics, operational
  job status, encrypted email retry queue, backup/restore helpers, Compose and
  reverse-proxy configuration, and example monitoring/alert definitions.
- Generated [OpenAPI contract](../apps/server/contracts/openapi.json), server
  commands, independent CI definition, directory rules and setup instructions.

## Acceptance evidence

| Check | Result |
| --- | --- |
| Root npm run build:server | TypeScript check and Bun artifact build passed |
| Root npm run test:server | **40 tests passed, 0 failed; 310 assertions**, in isolated Linux Bun/PostgreSQL containers |
| Root repository boundary checks | **3 passed**; server lockfile/toolchain isolation and client packaging checks included |
| Authentication | Registration, delivered-to-test-sink verification, login, logout, generic recovery, single-use/expired reset and prior-session revocation passed |
| Authorization | Both tiers, pending/suspended/expired access, MFA/freshness, cross-user/session attacks, privilege injection, owner guards and conflicting edits passed |
| Activity and monitoring | Device ownership, event deduplication, privacy schema, stale presence, optional usage disablement, private metrics, email failures/expiry and repeatable rollups passed |
| Database resilience | Empty/unmigrated readiness, checksum/rollback/concurrent migration checks, forced connection outage and recovery passed |
| Built artifact | Real HTTP requests, restart with existing sessions, log redaction and successful SIGTERM shutdown passed |
| Backup/restore | Actual pg_dump/pg_restore into a clean database preserved user/grant/audit counts; non-empty restore target refused |
| Local Compose deployment | Provisioning, migrations/permissions, API health and worker startup passed; API bound to 127.0.0.1:3002, no published PostgreSQL port |
| Deployment configuration | Compose and Caddy validation passed; Prometheus parsed all five alert rules and passed six firing/non-firing evaluations |
| Dependency audit | Bun audit reported no vulnerabilities for the installed dependency graph at verification time |

The tests use synthetic accounts and an in-process email sink. They run a real,
isolated PostgreSQL server, not a database mock. Temporary databases and the
container are removed at test completion. API/worker production credentials are
not fixtures. The local Compose stack is separate from the disposable test stack.

The final small HTTP exercise used 100 authenticated /api/v1/me requests at
concurrency 10 against the built server: p50 **26 ms**, p95 **87 ms** in the local
Linux container run. This is a functional/load sanity check on this development
machine, not a production capacity estimate or a Bun-versus-Node/Go benchmark.

## Repairs found during implementation

The first integration run caught signup validation consuming the raw request
body before Better Auth read it. Validation now uses a clone. Real PostgreSQL
also exposed an email outbox foreign-key failure while signup was uncommitted;
email enqueueing now runs after commit. Unverified accounts can request a resend
if a process fails in the small commit-to-enqueue interval.

Session renewal now forwards the library's Set-Cookie headers. Authentication
responses strip session-token fields; dependency failures are converted to safe
service errors. Audit protection is enforced through both database permissions
and transactional application checks. Forwarded IP headers are accepted only
from configured proxy peers, and authenticated MFA attempts have an additional
per-account limit.

The pre-existing global Windows Bun **1.3.12** crashed in the PostgreSQL utility
test. An app-local, checksum-verified **1.4.2** toolchain was used afterward;
the full native Windows suite still encountered subprocess/cleanup hangs.
Linux container acceptance completed cleanly. Root test:server therefore runs
the complete Linux integration environment on Windows too. The installed Lina
app's separate Bun process and the global Bun installation were not replaced.
Native Windows full-suite acceptance is not claimed.

## Deliberate implementation choices

- Optional usage and signup are **off by default**. Email configuration is
  required before enabling signup. Production requires HTTPS and SMTP settings.
- Account status, role, tier and access source are independent. Administrative
  tier assignment currently issues manual grants; automatic beta/trial/Stripe
  grant issuance is future policy/integration work.
- Email verification is idempotent. Password-reset tokens are single-use.
  Email jobs are encrypted and delivered with retries; provider delivery is
  at least once. Successful delivery/expiry clears the secret payload.
- Recently seen means a valid session reported within three minutes. It does
  not imply human attention or an agent successfully completing work.
- Client usage cannot grant access, establish billable activity, or prove task
  completion. No terminal contents, prompts, code, audio or provider credentials
  enter the activity schema.
- Closing an account changes access state; complete erasure/anonymization is
  not implemented. Raw usage/log policy is 30 days, security 90 days, and daily
  summaries/audit 365 days. Configure equivalent retention in external logging
  and backup storage before real-user rollout.
- A local database snapshot is recorded separately from an off-VM backup.
  The GCS helper records backup success only after dump/checksum uploads succeed.
- No desktop/website/mobile runtime was migrated to Bun. Root npm entry points
  merely dispatch to the app-owned Bun tools or Docker test wrapper.

## Remaining live acceptance

These require the actual Google project/VM, approved domain/DNS, access method,
email provider/sender, backup bucket and notification destination:

1. Deploy the verified server image and private PostgreSQL configuration on the
   intended VM, retrieve server secrets using its service identity, and confirm
   permissions and runtime secret mounts.
2. Configure the HTTPS proxy and actual trusted proxy IPs, then exercise signup,
   verification, reset, MFA and account management over the public HTTPS origin.
3. Confirm real email delivery, configure monitoring/notification channels,
   and exercise the chosen alerts. Monitoring examples are not live resources.
4. Schedule off-VM backups, configure retention, and measure restoration against
   the proposed 24-hour data-loss/four-hour recovery objectives.
5. Run the CI workflow remotely and retain its evidence when this work is pushed.

The local gcloud configuration referenced an unrelated existing project. It was
not treated as authorization to deploy Lina there. No live infrastructure was
created or changed, and production verification is not claimed.

## Phase 2 handoff

Use [apps/server/README.md](../apps/server/README.md) to run the backend and the
OpenAPI contract to build account/admin screens and client HTTPS wrappers. Add
the browser-to-Electron handoff, secure local sessions and native feature checks
with their own integration tests. Add explicit, disclosed client activity events;
do not upload existing raw desktop telemetry. Review offline access and running
job preservation in that client phase. Stripe stays a later integration.

The server ownership rules in the root and app AGENTS.md files continue to apply
to every future change. All server runtime, migrations, monitoring, contracts,
tests and deployment helpers stay in apps/server.
