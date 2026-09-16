# Lina account server

Dedicated home for Lina's account backend, separate from the desktop, website,
and mobile applications.

**Status: implemented and locally verified.** Bun 1.4.2 + TypeScript, Hono,
Better Auth 1.7.4, and PostgreSQL. Google VM deployment and real email/alert
delivery remain pending the production configuration.

**Later preparation is now separate:** `src/prepared` contains disconnected
desktop login, signed access and billing modules. Normal startup and migrations
do not enable them. See [paid readiness](../../docs/account-paid-readiness.md)
for the current implementation, security findings, test commands and launch gates.

Read the [implementation and verification record](../../docs/server-phase-1-implementation.md)
and [phase 1 plan](../../docs/server-phase-1-plan.md). Login screens and client
integration are the next development phase; this service currently provides APIs.

The [backend plan](../../docs/login-access-plan-2026-09-12.md) defines:

- PostgreSQL connections, migrations, and account storage.
- Login, verification, recovery, sessions, and protected management APIs.
- Full Access and Orchestrator tiers, approval, grants, and suspension.
- Account activity, session presence, basic usage intake, and server monitoring.
- Google Cloud VM deployment, secrets, backups, and recovery acceptance.

This app owns its package.json/bun.lock, source, migrations, contracts, tests,
and deployment configuration. Other apps consume its
HTTPS API without importing server runtime code or database credentials.
The existing `apps/website/backend` remains responsible for marketing APIs.

## Development and verification

From the repository root:

```powershell
npm run setup:server
npm run build:server
npm run test:server
```

Build/setup use the Bun version in `.bun-version`. The runner accepts `LINA_BUN`
as an explicit executable override. Tests require Docker and build an isolated
Linux Bun/PostgreSQL image; no production credentials or host database are used.
The test database listens only inside its disposable container. This is the
acceptance path on Windows as well as Linux; native Bun/Windows PostgreSQL
subprocess cleanup showed a crash/hang during investigation.

Inside this directory, use `bun run typecheck`, `bun run format:check`, and
`bun run contracts` for their individual checks. Direct `bun test` requires an
explicit disposable loopback PostgreSQL fixture and a built artifact; normally
use the Docker test command above. `npm run dev:server` starts the source server
only after local configuration and database roles/migrations exist.

## Local container setup

Create app-owned secrets once (exclusive writes prevent accidental rotation):

```powershell
node ../../scripts/run-app.cjs server secrets:create
```

Create ignored `data/server.env` with:

```dotenv
NODE_ENV=development
PUBLIC_URL=http://127.0.0.1:3002
EMAIL_MODE=disabled
SIGNUP_ENABLED=false
USAGE_ENABLED=false
```

Then, from this directory:

```powershell
docker compose -f deploy/compose.yaml build
docker compose -f deploy/compose.yaml --profile setup run --rm provision
docker compose -f deploy/compose.yaml up -d api jobs
```

`http://127.0.0.1:3002/health/ready` returns readiness based on the real database
and migration checksums. PostgreSQL has no published host port. The deployment
uses separate `lina_app`, `lina_migrator`, and `lina_jobs` roles. The schema owner
applies permissions after migrations. Existing credentials are never rotated by
provisioning. Use `docker compose -f deploy/compose.yaml stop` to stop this stack
while retaining its database volume. Do not remove the volume to perform updates.

## Login, account management, and API contract

Configure SMTP and a sender before enabling signup. For production, use HTTPS,
`NODE_ENV=production`, and `EMAIL_MODE=smtp`; fill `data/secrets/smtp-password`
from the selected provider. Populate production secret files from Secret Manager
through the VM service identity and restrict filesystem access. Verify container
read permissions for its non-root Bun user; never commit files under `data/`.

All mutating API requests require an exact trusted `Origin` header, including
command-line clients. The public HTTPS origin supplies `/api/auth/*` and
`/api/v1/*`; see [OpenAPI](contracts/openapi.json). The auth allowlist excludes
generic role/admin routes and raw session-list/token endpoints. Cookies are
HTTP-only and secure in production. The local development cookie is named
`better-auth.session_token`; production adds the `__Secure-` prefix.

New users verify their email and await manual approval. Bootstrap the first owner
by verified user ID using `bun run owner:bootstrap -- <uuid>` (or invoke
`scripts/owner.ts <uuid>` in the API container). That user must sign in again,
enroll TOTP, and verify a code before using admin APIs. Administrative mutations
require login/MFA within five minutes. Other admins/owners are appointed through
the owner-only role endpoint. Roles and account tiers are independent.

Use `/api/v1/admin/users` and per-user approve/access/status/revoke endpoints to
manage accounts. Account changes require `expectedRevision` and `reason` and
write an audit record transactionally. Closing an account disables access;
it is not a completed privacy-erasure workflow. Reopening returns to pending.

The worker retries encrypted verification/reset email jobs and expires their
payloads. Signup commits before the after-commit email job is queued; a crash in
that small interval leaves an unverified account that can request a resend.
Email verification is idempotent; password-reset tokens are single-use and reset
completion revokes old sessions. Delivery is at least once; the stable message
ID helps providers identify duplicate retries.

## Monitoring and deployment

Activity APIs accept documented feature events, never terminal text or prompts.
`USAGE_ENABLED` controls optional event collection separately from authentication
and device presence. No desktop/mobile client emits these events yet.

`/internal/metrics` requires the separate monitoring bearer token. Keep it off the
public proxy. `deploy/prometheus.example.yaml` and `deploy/alerts.yaml` describe
scraping/alerts; connect them to the selected monitoring service and destination.
They are configuration artifacts, not a deployed notification channel.

`deploy/Caddyfile.example` forwards account routes to this service and marketing
traffic to the existing website. Set `TRUSTED_PROXY_IPS` to actual proxy peer IPs;
forwarded headers from all other callers are ignored. Avoid raw URL logging,
which could capture verification/reset links.

The `jobs` service handles retention and email delivery. Raw usage is retained
30 days, security events 90 days, daily summaries/audit 365 days; expired auth
records are pruned. Email errors retain safe codes rather than provider messages.

For a local snapshot, run `bun run backup` with PostgreSQL 17+ client tools
available (`PG_BIN` can select their directory). A snapshot alone does not update
the off-VM backup metric. On the VM, configure `BACKUP_BUCKET` and schedule
`deploy/backup-to-gcs.sh`; only successful dump/checksum uploads record that
backup success. Configure bucket retention/access and monitoring separately.
The initial script targets the default `lina_accounts` database.

`RESTORE_DATABASE_URL` must identify an empty, dedicated database owned by the
migration role. `bun run restore:check -- <dump-path>` restores, verifies migration
checksums, reinstates runtime permissions, and reports record counts. Existing
non-empty targets are refused. Exercise restoration before live launch.

All server work stays here. Root scripts/CI only coordinate it; no server runtime
or secrets belong in the desktop, website, or mobile bundles.
