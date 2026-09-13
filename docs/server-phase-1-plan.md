# Phase 1: Lina account backend

September 12, 2026. **Implemented locally with Bun + TypeScript.** See the
[verification record](server-phase-1-implementation.md) for completed checks and
the remaining live Google VM/email/monitoring acceptance. This document retains
the phase requirements; it is not itself a claim of live deployment.

Phase 1 means the complete backend foundation requested by Ahmed: **database,
login/session APIs, account types and statuses, and activity/server monitoring**.
The steps below are work packages within this phase. Login screens, an admin
dashboard, desktop integration, and payments follow afterward.

The [architecture plan](login-access-plan-2026-09-12.md) defines the wider design.
This document defines what to build first, where it belongs, and its acceptance
checks. It is the implementation entry point for this phase.

## Target result

Through an API client, Ahmed can create and verify a test account, sign in,
approve the user, assign Full Access or Orchestrator, inspect account/session
activity, suspend/reactivate access, and revoke sessions. The service persists
these changes in PostgreSQL, records privileged changes, reports real database
health, and can be deployed independently to the Google VM.

There is one account service and one database. Other applications communicate
with it over HTTPS. Client-reported usage is explicitly identified as such.

## Directory contract

All runtime implementation and server-specific resources stay in **apps/server/**:

| Location | Work in this phase |
| --- | --- |
| package.json, bun.lock, .bun-version, tsconfig.json | Independent Bun dependencies, build and commands |
| src/config | Environment validation and secret loading boundary |
| src/app.ts, src/server.ts | HTTP composition, startup and shutdown |
| src/db, migrations | Connection pool, transactions, versioned schema changes |
| src/auth | Authentication library, email adapter, session/MFA policy |
| src/accounts, src/access, src/admin | Profiles, approval, grants, authorization, management APIs |
| src/devices, src/activity | Session/device ownership, presence, event intake and queries |
| src/monitoring, src/jobs | Health, redacted logs/metrics, retention and delivery jobs |
| contracts | OpenAPI contract, error codes and activity schemas |
| tests | Isolated PostgreSQL/API fixtures and tests |
| scripts | Migration, owner bootstrap, API smoke and backup/restore helpers |
| deploy | Container build, Compose, reverse-proxy example and VM instructions |
| README.md, AGENTS.md, .env.example, .gitignore | Setup, ownership and safe configuration documentation |

Only command forwarding in root package.json/scripts, repository boundary checks,
.github/workflows/server.yml, and engineering documentation live outside this
directory. Do not put account-server code in apps/website/backend or
apps/desktop/backend. Follow the root and app AGENTS.md guides when adding files.
Do not create empty placeholder modules for later features.

## Step 1 — Independent server and database connection

Create a Bun + TypeScript ES-module service with Hono and PostgreSQL.
Install and lock its dependencies locally to apps/server. Development listens
on 127.0.0.1:3002; container networking may bind internally to 0.0.0.0 while the
host exposes only the configured HTTPS proxy. Keep the existing website API
on port 3001.

Configuration must validate required values and ranges before accepting work.
Load only the server's explicit configuration, never implicitly the repository's
root .env. Separate runtime database credentials from migration credentials.
Do not print either connection string. Use a bounded pool, acquisition/query
timeouts, error handling for idle connections, and orderly pool shutdown;
[node-postgres documents the pool lifecycle](https://node-postgres.com/features/pooling).

Start with two routes:

- GET /health/live: 200 while the process is running, independent of PostgreSQL.
- GET /health/ready: 200 only when a real bounded database query succeeds and
  the expected migrations are present; otherwise 503 with a safe reason code.

Readiness must recover after a database restart. Liveness alone never means
the account service works. Configuration errors terminate startup; transient
database loss keeps readiness false and protected operations unavailable.

**Acceptance:** install/typecheck/build independently; connect to isolated real
PostgreSQL; demonstrate readiness 503 before migration, 200 after migration,
503 during database loss, and recovery to 200. Verify no database URL/password
appears in logs or responses. Clean shutdown releases connections.

## Step 2 — Schema and migration foundation

Use checked-in, ordered migrations and a migration ledger with file checksums.
Acquire a migration lock and apply each migration transactionally. Re-running
the command is a no-op; changing an already-applied migration fails explicitly.
The runtime database role cannot create/drop schema. The migration command uses
its own credentials and closes its connections afterward.

Create the schema in dependency order:

1. Pinned authentication-library tables: users, credentials/provider links,
   sessions, verification/recovery records, and configured MFA records.
2. Account profiles and plans: account status/revision and exactly two seeded
   tiers, full_access and orchestrator.
3. Access grants and administrative audit: validity, source, issuer, revocation,
   reason, and versioned account changes.
4. Devices and session bindings: owned installation identifiers and last seen.
5. Security/activity records and background work: typed events, deduplication,
   daily summaries, and durable email/retention job state.

Use foreign keys, validity constraints, indexes for user/event timelines, and a
unique normalized login email. Keep one authoritative administrative-role field
in the auth schema. Authentication and application profile creation must be
atomic or safely reconciled; a missing profile always denies product access.
Never promote a signup or grant access to repair incomplete profile creation.

**Acceptance:** empty database migrates; repeated migration is safe; a failed
migration rolls back; two simultaneous migration runs cannot race; invalid
references/duplicate identities fail; seeded tier IDs stay stable across runs;
account records survive server and database restarts.

## Step 3 — Login and session APIs

Use Better Auth rather than implementing password hashing and session formats.
Pin and verify its integration when coding. Its [Hono guide](https://better-auth.com/docs/integrations/hono)
mounts the raw Web Request handler; validation must not consume that request's
body before authentication reads it.

Expose the library's /api/auth/* contract for signup, verification/resend,
email/password login, password recovery/reset, logout, and renewal. Require
verification before granting normal authenticated app access. New accounts are
members with pending approval and no tier grant. Return the same safe recovery
response whether an email exists or not. Only allowlisted profile fields can
be supplied by clients; role, account status and grant fields are server-owned.

Implement transactional email through an adapter and durable retry handling.
Tests use a local email sink with disposable addresses. Production configuration
must identify a real provider/sender; a logged link is not successful delivery.
Recovery material is short-lived and single-use; email verification is idempotent.
Both are excluded
from application, proxy and job-error logs. Restrict and expire sensitive email
job payloads; workers reject stale verification/reset jobs.

Proposed session policy: seven-day session validity, renewal no more than daily,
with recent authentication within five minutes plus MFA for admin mutations.
The [auth session documentation](https://better-auth.com/docs/concepts/session-management)
describes these configurable primitives; test actual chosen behavior. Protected
APIs validate the current database session and account status, without a cache
that permits revoked sessions. Password-reset completion revokes old sessions.
Browser cookies are secure/HTTP-only in production with trusted-origin/CSRF
checks; secrets never enter client responses.

Add safe own-account endpoints: GET /api/v1/me, GET /api/v1/me/sessions,
and DELETE /api/v1/me/sessions/:id. Session listings use opaque IDs, not tokens.
Apply rate limits to auth/recovery requests and test behavior behind the intended
proxy so spoofed forwarding headers cannot defeat limits.

**Acceptance:** API-only signup → email verification → login → read own account
→ logout works; wrong passwords, unverified login, expired/reused reset links,
revoked sessions, malicious signup fields, and another user's session ID fail.
Complete a reset and prove previous sessions cannot access protected APIs.

## Step 4 — Account types, approval and administration

Keep these separate:

| Field | Values |
| --- | --- |
| Product tier | Full Access, Orchestrator |
| Account status | pending, active, suspended, closed |
| Administrative role | member, admin, owner |
| Access source | manual, beta, trial; payments later |
| Access validity | Starts at, expires at, revoked at |

Full Access enables all terminals/agent modes and workspace tools. Orchestrator
adds the workspace Orchestrator and its voice/task coordination. Administrative
roles do not grant a product tier. Signup does not create a third/free tier.

Use one service function to evaluate access from a valid session, verification,
active account and current grants. Suspension/closure overrides grants. Compute
expiry using server UTC time. A user without product access can read a limited
account-status response; that does not permit product operations.

Provide protected administrator APIs to list/filter users, approve and assign
a tier, change tier/expiry, suspend/reactivate/close, revoke grants/sessions, and
read the audit trail. Approval and initial grant are one transaction. Every
mutation records its actor/reason and a safe before/after snapshot in the same
transaction. Use an expected revision to reject stale concurrent edits.

Bootstrap the first owner through a controlled CLI targeting a verified user.
Require owner authority to promote roles; protect the last owner against
demotion/suspension/closure. Require MFA and recent login for online privileged
mutations. Built-in auth-plugin administrative routes must not bypass these
rules or auditing. The initial CLI/API client replaces an admin dashboard for
testing this phase.

GET /api/v1/me/access returns the effective tier, allowed feature keys, grant
expiry, access revision, server time and a stable denial code. 401 indicates an
invalid session; 403 a known access denial; 409 a stale administrative revision;
429 a rate limit; 503 a service failure. Database failure must not masquerade
as an expired or suspended account.

**Acceptance:** an owner approves two users with different tiers; access responses
match each tier; downgrade, expiry and suspension immediately affect online API
checks; ordinary users cannot modify privileges or inspect another account;
concurrent edits conflict safely and audits remain complete.

## Step 5 — Account activity and backend monitoring

Implement three clearly identified streams:

| Stream | Initial records |
| --- | --- |
| Server-observed account activity | Login outcomes, verification/reset completion, session revocation, account/tier changes |
| Client-reported activity | Device/app version, last heartbeat, optional terminal/agent/Orchestrator feature events |
| Operational health | Request latency/error counts, pool/database errors, process resources, email/retention/backup job outcomes |

Provide authenticated device registration, heartbeat and batched event endpoints;
bind user/session/device ownership on the server. Reject events from accounts
without product access. Allowlist typed event fields, cap batches at 50 events/
32 KiB, rate-limit intake, deduplicate retries, and make daily aggregation
idempotent. Product usage never determines permissions, invoices, or proof of
an agent completing work.

Proposed presence: one heartbeat per minute; show recently seen for three
minutes, otherwise a last-seen timestamp. Store current presence instead of
permanent minute-by-minute records. Missing heartbeats neither revoke access
nor prove a person/agent is inactive.

Expose protected overview/timeline endpoints for counts by account status/tier,
recently seen users, last login, authentication failures and feature counts.
Distinguish login, presence and feature-based activity; deduplicate users across
devices. Before desktop integration, populate only synthetic test events and
label this verification boundary explicitly.

Collect no terminal output, prompts, code, file paths, repository names, audio,
provider secrets or auth/recovery tokens. Redact sensitive URLs/headers/bodies
from operational logs. Optional feature usage remains configurable separately
from account/security records and must be disclosed when clients are connected.

Proposed retention: raw usage/logs 30 days, security events 90 days, summaries
and administrator audit 12 months. Prune expired sessions/verification records
and bounded deduplication markers. Use job locking and monitored failures.
Defer hard account deletion until erasure/anonymization and backup expiry have
defined behavior; closed is initially an access state.

**Acceptance:** retries count once, spoofed ownership/private fields fail,
presence ages correctly, retention and rollups can rerun safely, secrets do not
appear in logs, and unavailable usage collection does not break valid login.
Detailed metrics and activity endpoints cannot be read anonymously.

## Step 6 — Reproducible checks and Google VM deployment

Add server-owned scripts for development, typecheck/build, unit/integration tests,
migrate/status, owner bootstrap and API smoke checks. Root npm commands forward
into apps/server. CI installs only the server package, builds it, and runs the
database/API suite against disposable PostgreSQL. Test app boundaries separately
so the server never becomes an installer/frontend dependency.

Provide a multi-stage container build, health checks, persistent database volume,
and explicit migration-before-service startup. Compose can wait on health and
successful one-shot dependencies; see [Docker's startup-order documentation](https://docs.docker.com/compose/how-tos/startup-order/).
Application readiness still performs its own real checks after deployment.

The proxy routes /api/auth/* and /api/v1/* to apps/server:3002; marketing traffic
continues to apps/website:3001. Expose HTTPS publicly while database and service
ports remain private. Staging and production use separate identities, secrets
and data. No live Google project/domain or database has been verified so far.

Configure safe server/VM logs, private metrics, alerts for unavailability,
database errors, email job backlog and failed/overdue backups. Schedule consistent
daily PostgreSQL backups outside the VM; restore one into an empty database and
rerun the smoke flow. Initial recovery targets are 24 hours maximum data loss
and four hours to restore, subject to the measured restore exercise. Preserve
a prior server artifact and compatible schema for rollback.

**Acceptance:** isolated local/CI tests pass; container restart retains data;
HTTPS staging runs the account flow with delivered email; database is unreachable
publicly; alert failure injection and backup restoration succeed. Local success
is recorded separately from actual Google VM verification.

## End-to-end completion checklist

Before starting the login screens, demonstrate and record:

1. Fresh database → migrations → healthy, independently running server.
2. Register → verify email → sign in → pending account with no product grant.
3. Owner approves → Full Access is returned by the access API.
4. Owner upgrades → Orchestrator is returned; downgrade is reflected correctly.
5. Submit a device/heartbeat/event → protected activity API shows the right user.
6. Retry an event → no duplicate count; attempt another user's ID → rejection.
7. Suspend or expire access → product APIs deny it while limited status remains
   readable; revoke session → authenticated APIs reject that session.
8. Reset password → old sessions fail; ordinary members cannot call admin APIs.
9. Restart/restore → accounts, grants and audit records remain consistent.
10. Google VM HTTPS/email/monitoring checks have real evidence, or are explicitly
    recorded as pending. Pending deployment means phase 1 is not fully complete.

## Inputs and the next boundary

Local implementation can begin using isolated PostgreSQL and an email sink.
Google deployment later requires the project/VM, domain/DNS, deployment access,
email provider/sender and alert destination. Missing production inputs should
not prevent local implementation and API testing.

Manual approval, activity scope, retention and session limits above are proposed
defaults. Keep them explicit/configurable. Do not silently enable public signup,
real-user activity collection, or live billing as part of a local test run.

After this phase: client login screens and secure sessions, account/admin UI,
desktop feature enforcement, real client events, offline-access policy, and
eventually Stripe. Existing installations will not become login-only from
backend deployment alone.

This document describes the intended phase. Source, migrations, tests and local
container deployment now exist; the [implementation record](server-phase-1-implementation.md)
separately states local evidence and the unverified live deployment requirements.
