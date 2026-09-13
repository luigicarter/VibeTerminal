# Lina account backend plan

September 12, 2026. **Bun + TypeScript backend implemented and locally verified.**
See the [phase 1 implementation record](server-phase-1-implementation.md). Live
Google VM/email/monitoring acceptance is pending; client screens are a later phase.

## Scope

The [phase 1 implementation plan](server-phase-1-plan.md) turns this architecture
into ordered backend work packages and acceptance checks. In that plan, phase 1
means the full database/login/accounts/activity backend before client screens.

Build an independent backend for database connections, identities, login/session APIs, approval and tier management, account activity, and server monitoring. Host it on a Google Cloud Compute Engine Linux VM. Prove its APIs and database behavior before creating login screens, account pages, or an admin dashboard. Payments follow later.

The existing [pricing source](../apps/website/frontend/src/sections/PricingSection.tsx) defines **Full Access** and **Orchestrator**. The [website API](../apps/website/backend/src/app.ts) serves marketing-related endpoints and a JSON-file waitlist; it has no Lina identity service. Existing desktop provider logins remain separate from Lina login.

The proposed monitoring scope includes account/security events and basic feature counts. This remains a configurable default pending the user's monitoring preference. No activity collection is implemented by this planning change.

## Independent folder and ownership

~~~text
apps/
  desktop/                   Electron workspace and local agent runtime
  website/                   Marketing frontend and existing public API
  mobile/                    Mobile app
  server/                    Dedicated Lina account backend
    AGENTS.md                Ownership and implementation boundaries
    README.md                Status; setup instructions when implemented
    package.json             Planned: server-only dependencies/scripts
    bun.lock                 Independent Bun dependency lockfile
    .bun-version             Pinned server runtime
    src/
      app.ts                 HTTP composition without listening side effects
      server.ts              Startup, readiness, and graceful shutdown
      config/                Validated configuration and secrets
      db/                    PostgreSQL pool, queries, transactions
      auth/                  Authentication integration and session policy
      accounts/              Approval, suspension, closure, profiles
      access/                Two-tier catalog, grants, access evaluation
      devices/               Session-linked installations and presence
      activity/              Validated event intake and summaries
      admin/                 Protected management APIs
      monitoring/            Health, metrics, redacted structured logging
      jobs/                  Retention, aggregation, email retries
    migrations/              Versioned auth/application schema changes
    contracts/               OpenAPI specification and event schemas
    tests/                   API, database, security, deployment checks
    scripts/                 Migrate, bootstrap owner, backup/restore checks
    deploy/                  Dockerfile, Compose, VM/proxy configuration
    .env.example             Names and safe example values only
~~~

The executable service, migrations, contracts, tests and deployment tooling now live here. This is one backend service with internal modules.

The server owns its dependencies, lockfile, build output, migrations, secrets, tests, and release artifact. Desktop/website/mobile consume its HTTPS API; they must not import server runtime code, connect to PostgreSQL, or bundle backend dependencies. The server imports no Electron or frontend runtime. OpenAPI defines the boundary; generated client types can come later.

Keep releases, statistics, and waitlist/news signup in apps/website/backend. A waitlist address is not an account or verification. The ignored root backend/ path is a desktop compatibility junction, not this service's location.

During implementation, add setup:server, dev:server, build:server, test:server, and start:server root scripts; extend scripts/run-app.cjs and repository boundary tests; add independent .github/workflows/server.yml. Server checks must not require React or native desktop dependencies. Existing release workflows remain independent.

## Stack and connection layout

Use Bun 1.4.2, TypeScript with ES modules, Hono, PostgreSQL, and a bounded pg connection pool. Dependencies are pinned in bun.lock. Use parameterized queries and reviewed, versioned SQL migrations. Apply migrations under a deployment lock with a separate migration role, not inside requests or competing API startups.

Use **Better Auth 1.7.4** for authentication primitives. Its [Hono integration](https://better-auth.com/docs/integrations/hono) accepts raw Web Requests, and its [PostgreSQL adapter](https://better-auth.com/docs/adapters/postgresql) supports this database. The pinned schema and server integration have been tested locally; review and version all future schema changes.

~~~mermaid
flowchart LR
    Clients["Desktop / website / mobile, later"] -->|HTTPS| Proxy
    subgraph VM["Google Cloud VM"]
        Proxy["HTTPS reverse proxy"] -->|"/api/auth/* and /api/v1/*"| Server["apps/server :3002"]
        Proxy -->|"Marketing pages and existing API"| Site["apps/website :3001"]
        Server --> DB[("PostgreSQL; private connection")]
    end
    Server --> Email["Transactional email provider"]
    Server --> Monitoring["Restricted logs and monitoring"]
    DB --> Backups["Backup storage outside VM"]
~~~

Proposed development port: **3002**; website API remains 3001. Share a public HTTPS origin through explicit proxy routing while keeping separate services and artifacts. Route account prefixes before the marketing fallback. Add matching website Vite proxies when integrating clients. Login redirects use the configured public URL, not internal VM addresses.

Use Compose for the server and PostgreSQL, persistent volumes, restart policy, and health checks. Document integration with the VM's existing site/proxy deployment; no particular live configuration was inspected. PostgreSQL and service ports remain private.

Validate database URL, public base URL, trusted origins, auth secret, email settings, and environment at startup. Configure bounded pool/query timeouts and graceful shutdown. Use Google Secret Manager through a restricted VM identity for production credentials. Keep staging databases, email settings, and sessions separate. Missing dependencies return service errors and deny protected operations; they must not silently grant access or suspend accounts.

## Account types and rules

| Concept | Values | Meaning |
| --- | --- | --- |
| Tier | full_access, orchestrator | Product features |
| Account status | pending, active, suspended, closed | Administrative standing |
| Email verification | Auth emailVerified boolean; timestamped security event | Email ownership |
| Admin role | member, admin, owner | Service-management permission |
| Grant source | manual, beta, trial; stripe later | Why access exists |
| Grant validity | Start, expiry, revocation | When access is valid |
| Session state | Valid, expired, revoked | Whether a login is usable |

Full Access includes all terminals/agent modes, Fusion/Open Fusion, workspace/Git tools, and provider settings. Orchestrator adds workspace-wide routing, its text/voice controls, and Orchestrator dashboard/history. AI-provider accounts and usage stay separate. Admin role does not imply a product tier.

**Proposed onboarding default:** signup creates a pending member with no grant. Verification proves email ownership. An administrator approves and assigns either tier in one transaction. Automatic beta approval can later be configured without introducing a third tier.

App access requires a valid session, verified email, active account, and a valid grant. Use server UTC time with exclusive expiry. Suspension/closure overrides every grant. Authenticated users without product access may inspect their own limited account status. Ordinary suspension does not prevent restricted account/support sign-in; authentication-wide bans are separate security actions.

Only the server controls status, roles, grants, and tiers. Allowlist editable profile fields. Replace administrative assignments transactionally and keep history. If future subscription/manual grants overlap, choose the highest valid tier deterministically and show all contributing grants to admins. Suspension blocks every source.

## Database model

| Table/group | Data and constraints |
| --- | --- |
| Auth user/account/session/verification/MFA tables | Library-managed identity, password hashes, provider links, sessions, verification/recovery; unique normalized email |
| account_profiles | One per user; status, approval/suspension/closure metadata, safe reason code, access revision |
| plans | Exactly the two stable tier IDs and feature definitions; seeded migration |
| access_grants | User/plan, source, validity, issuer, reason, revocation; prevent concurrent administrative assignments |
| devices | Random installation ID scoped to user, optional label, platform/app version, first/last seen; no hardware fingerprint |
| session_devices | Owned auth-session/device relationship and current heartbeat |
| security_events | Server-authored login/logout/failure, verification, recovery, revocation; safe codes and server timestamp |
| activity_events | User/session/device, client event ID, schema version, allowlisted name/fields, client and received timestamps |
| activity_daily | Rebuildable UTC user/date/feature summaries with source/schema version |
| admin_audit_events | Actor/target/action, allowlisted before/after, reason, request ID, time; append-only in normal app operation |
| job_outbox | Durable email/background work, idempotency key, retry time, attempts and processing state |

Use foreign keys, validity constraints, and indexes for identity lookup, current grants/sessions, user event timelines and admin history. One canonical auth role field is authoritative; do not duplicate administrative roles in profiles. Access changes and audit records commit together. Reject conflicting administrator revisions or serialize changes with row locks.

Use the library's credential/session lifecycle rather than custom password/token formats. Its [session documentation](https://better-auth.com/docs/concepts/session-management) describes expiry, renewal and revocation. Set duration explicitly, validate authoritative sessions on protected calls, and avoid caches that outlive revocation. Session listings expose opaque IDs, never authentication tokens. Password-reset completion revokes existing sessions.

Defer billing migrations until payments: customer/subscription mappings plus a deduplicated webhook inbox. Preserve their future relationships to user IDs and grants. No payment fields should be accepted during signup.

## APIs before screens

Use library endpoints under /api/auth/* for signup, email/password sign-in, verification/resend, recovery, logout and renewal. Require verified email and implement rate limits, secure HTTP-only cookies, CSRF/origin checks, and enumeration-resistant recovery responses. Apply the same authorization, MFA and audit policy to all exposed library admin operations.

| Endpoint | Purpose |
| --- | --- |
| GET /api/v1/me | Safe own identity, verification, status, effective access |
| GET /api/v1/me/access | Tier, feature keys, expiry, revision, denial code, server time |
| GET /api/v1/me/sessions | Safe own sessions/devices and last seen |
| DELETE /api/v1/me/sessions/:id | Revoke an owned session; recent auth for sensitive operations |
| POST /api/v1/devices/register | Bind installation to authenticated user/session |
| POST /api/v1/activity/heartbeat | Update authenticated presence using server time |
| POST /api/v1/activity/events | Small validated batch of client usage |
| GET /api/v1/admin/users | Paginated/filterable users, status, tier, source, last login/seen |
| GET /api/v1/admin/users/:id | Account, grants, safe sessions and activity summary |
| POST /api/v1/admin/users/:id/approve | Approve and assign tier atomically |
| PATCH /api/v1/admin/users/:id/status | Allowed suspend/reactivate/close transitions |
| PUT /api/v1/admin/users/:id/access | Assign/change tier or expiry with audit |
| POST /api/v1/admin/users/:id/revoke-access | Revoke administrative grants |
| POST /api/v1/admin/users/:id/revoke-sessions | Revoke selected/all sessions |
| GET /api/v1/admin/users/:id/activity | Paginated timeline with server/client provenance |
| GET /api/v1/admin/overview | Counts by status/tier, recently seen users, recent auth failures |
| GET /api/v1/admin/audit | Paginated privileged-change history |
| GET /health/live and /health/ready | Process liveness versus database/migration readiness |

Use stable errors plus request IDs: 401 invalid session, 403 authenticated denial, 409 conflicting revision, 429 throttled, 503 dependency failure. Distinguish awaiting verification/approval, suspended, no grant and expired. Enforce object ownership server-side; never use payload user IDs as event attribution. Pending/suspended users cannot submit product-usage events.

Bootstrap the first owner with a server CLI targeting a verified identity; public signup always creates a member. Require recent authentication and MFA for online admin mutations. Only owners promote roles, and the last owner cannot be removed or suspended. Until UI exists, verify with the CLI and API test client. Production signup/recovery cannot be called operational without configured email; tests use an isolated email sink.

## Activity monitoring

| Stream | Collect | Interpretation |
| --- | --- | --- |
| Account/security | Login success/failure, verification, recovery, session revocation, approval, suspension, tier changes | Server-observed |
| App presence/usage | Last heartbeat, platform/version, terminal/agent mode used, Orchestrator request start/outcome | Client-reported; approximate support/product information |
| Server operations | Request counts/latency/errors, database and VM health, email failures, job/backup outcomes | Measured server health |

Propose one heartbeat per minute while running, with jitter/backoff. Label sessions **recently seen** within three minutes; otherwise show the last timestamp. This reflects connectivity, not human attention or task progress. A missed heartbeat never revokes access or proves inactivity. Update current presence instead of appending permanent heartbeat events. Keep access checks independent from optional usage intake.

Usage events accept only documented typed fields: feature enum, app version, bounded duration and safe outcome/error code. Limit batches to 50 events/32 KiB and apply per-session/IP quotas. Derive ownership from auth; validate device binding, timestamps and payload size; reject unknown fields. Deduplicate with unique user/client-event IDs and bounded replay markers. Aggregate only accepted, deduplicated events. Client telemetry must never authorize access, establish billable usage, or prove AI-task success.

Terminal contents, prompts, code, file paths, repository names, audio, provider credentials, cookies and auth/recovery tokens are outside the schema. Redact request bodies and sensitive URL/query values in application and proxy logs. If security IP/user-agent metadata is retained, restrict it to security records and a short retention window; exclude it from product analytics. Disclose collection when clients are integrated, with optional usage collection configurable separately from necessary account/security records.

Proposed retention: raw usage/operational logs **30 days**, security events **90 days**, daily summaries and admin audit **12 months**. Clean expired auth/recovery records and stale deduplication markers on schedule. Retention and aggregation jobs are idempotent, bounded, and monitored. State whether active-user metrics measure login, presence or feature activity; heartbeat alone is not daily product activity. Deduplicate users across devices.

Define deletion/anonymization across raw data, summaries, auth/session metadata and backup expiry before account deletion is offered. Initially, account closure is a reversible access state, not a promise of complete erasure.

Until client integration, monitoring APIs are tested with synthetic accounts/events; they do not observe real desktop usage. Usage ingestion failures must not interrupt terminals or invalidate otherwise valid access.

## Server health and recovery

Use structured JSON logs with request ID, route template, status, latency and safe error code. Keep user/email/device IDs out of metric labels; user investigations belong in protected admin queries. Detailed metrics remain private or require monitoring credentials. Public health responses contain no database or account details.

Collect VM logs/metrics through Google's [Ops Agent](https://docs.cloud.google.com/stackdriver/docs/solutions/agents/ops-agent) and Cloud Monitoring/Logging, with redaction, retention and access controls. Track availability, p95 latency, 5xx rate, database pool waits/timeouts, CPU/RAM/disk, auth-failure spikes, oldest pending email job, and backup/cleanup outcomes.

Initial proposed alerts: readiness unavailable for two minutes; sustained DB failures; 5xx above 5% over five minutes with a minimum traffic threshold; disk above 80%; daily backup overdue by 26 hours. Tune in staging and configure an alert destination before public rollout.

Run daily consistent PostgreSQL backups to restricted storage outside the VM; prove a restore into an empty database. Initial recovery objectives: at most 24 hours lost data and four hours to restore, unproven until exercised. Retain compatible migrations and the previous server artifact for deployment rollback. One VM is a single failure point; review managed PostgreSQL and tighter recovery before paid launch.

## Backend work packages and acceptance

These are work packages within the first backend phase, detailed in the
[phase 1 plan](server-phase-1-plan.md).

| Package | Work | Completion evidence |
| --- | --- | --- |
| 1. Isolated scaffold | Bun package/lockfile, TypeScript/Hono, config, health, Compose, CI/root forwarding | Server installs/builds/tests independently; existing apps need no server dependencies |
| 2. Database and auth | Pool, migrations, identity, verification/reset/sessions, owner bootstrap | Empty database migrates; restart preserves records; API auth tests pass using PostgreSQL/email sink; expired/revoked sessions fail |
| 3. Accounts and tiers | Profiles, plans, grants, policy, protected admin and audit | Approve/assign both tiers; expiry/downgrade/suspension/concurrent edits work; member and cross-user attacks fail |
| 4. Activity and operations | Presence/events, summaries/retention, logs/metrics, email retries | Events deduplicate; invalid/private fields fail; stale presence is accurate; monitoring failure does not break login |
| 5. VM validation | Staging, HTTPS routes, secrets, real email, alerts, backup/restore | API suite works over HTTPS; DB stays private; restart/restore pass; missing dependencies fail safely |

**Then begin screens and client integration.** The backend is ready when its API contract passes all five packages on staging without depending on an admin dashboard or desktop login page. Use command-line/API clients during verification; mocked tests alone do not establish a working database or VM.

Focused tests cover migration repeatability/uniqueness, secret redaction, verification/reset abuse, session revocation, cross-account access, MFA/role escalation, last-owner protection, conflicting grant edits, expiry boundaries, event replay/quotas, rollup deduplication, retention, proxy routes, restarts, and restore. Use isolated fixtures, never production users or the existing live Stripe key.

## Later work and required inputs

After backend acceptance, implement browser-to-Electron login, secure session persistence, login/account/admin screens, main-process feature enforcement and explicit desktop activity events. Test Electron library/Windows callback compatibility then. Never upload the desktop's existing raw terminal telemetry wholesale.

Five-minute online access refresh and up to 24 hours of signed offline access remain proposed client policies, requiring separate tests for revocation delay, time changes and preserving running jobs. Backend work alone cannot force login in older or modified desktop builds.

Billing later maps Stripe prices to existing tiers, verifies/deduplicates webhooks, reconciles subscription state and adjusts grants. Prices and billing intervals do not change identity or admin roles.

Deployment needs Google project/VM, region, domain/DNS, secrets/deployment access, email provider/sender, and alert destination. Before client rollout, settle manual/automatic approval, activity defaults, retention and offline policy. Proposed defaults make the design concrete without claiming user approval of every policy.

The backend now has local source/container/database acceptance, recorded in
[phase 1 implementation](server-phase-1-implementation.md). This architecture
document does not establish live Google deployment, real email/alert delivery,
desktop login integration, or collection of real users' desktop activity.
