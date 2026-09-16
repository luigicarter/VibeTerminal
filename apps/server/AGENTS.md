# Account server

This directory owns the implemented Lina account backend. See `README.md` and
`../../docs/server-phase-1-implementation.md` for commands, acceptance evidence,
and the pending live Google VM/email/monitoring boundary.

Account/payment preparation is in `src/prepared`, with SQL in
`migrations/prepared` and its separate contract in `contracts/prepared`.
Normal startup, migration discovery and the normal worker must not enable it.
Only explicit disposable test composition mounts these modules. Keep the
prepared SQL manifest separate and preserve existing migration checksums.
See `../../docs/account-paid-readiness.md` before later wiring or live billing.

The user selected Bun + TypeScript. Use Hono, Better Auth and PostgreSQL here;
keep `.bun-version`, packageManager, Bun lockfile and container versions aligned.
Do not create a server package-lock.json or move this service to Node/Go as a
routine refactor. Other apps keep their existing npm/Node toolchains.

Use `../../docs/server-phase-1-plan.md` as the implementation entry point. Phase 1
covers the complete backend foundation; its numbered steps are work packages,
and do not authorize building client screens or billing as part of that phase.

Run root `npm run test:server` for the complete Linux Bun/PostgreSQL suite, which
matches VM deployment. Preserve real database, auth/MFA, cross-user authorization,
outage, built-artifact, and restore coverage. Never replace these with mocked-only
tests or use a production database as a fixture. Keep source formatted with this
app's formatter and regenerate the OpenAPI contract when changing the API.

## Boundaries

- Respect the root `AGENTS.md` directory rules and the canonical ownership map
  in `../../docs/repository-layout.md` before creating or moving files.
- Put account authentication, PostgreSQL access, migrations, account/tier policy,
  activity intake, administration APIs, monitoring, and server deployment here.
- Keep this app's package, dependency lockfile, tests, and build output local.
  Add root forwarding and independent CI when scaffolded.
- Keep migrations in `migrations/`, API contracts in `contracts/`, operational
  helpers in `scripts/`, and VM/container configuration in `deploy/`. Root CI
  and command forwarding may invoke these app-owned files.
- Do not import desktop, website, or mobile runtime code. Those apps use HTTPS
  contracts; they must not receive server dependencies or database credentials.
- Leave marketing releases/statistics/waitlist APIs in `../website/backend`.
  Do not use the root `backend/` desktop compatibility junction for this service.
- Engineering plans stay in root `docs`; API contracts belong in `contracts/`
  when implemented. Login screens and the admin dashboard are a later phase.

## Data and access

- Preserve two product tiers: Full Access and Orchestrator. Account status,
  administrative role, session state, and grant source are separate.
- Derive caller identity from validated sessions. Role/tier/status changes are
  privileged server operations with transactionally recorded audit events.
- Activity intake accepts only the documented schema. Do not ingest terminal
  output, prompts, code, paths, audio, provider secrets, or auth/recovery tokens.
- Distinguish client-reported usage from server-observed security events.
  Usage does not establish authorization, billable activity, or task success.
- Keep secrets and runtime data out of source, logs, fixtures, and client builds.
- Verify migrations and APIs against isolated PostgreSQL/test identities;
  document live VM, email, and restore checks separately from mocked tests.
