# Lina account and paid-access readiness

September 13, 2026 (verification extends into September 14 UTC).
**Implemented as disconnected preparation. Product wiring is not authorized.**

## Baseline and decisions

The phase-1 backend and phase-2 fixture interfaces already exist. Their historical
40 server tests and 11 preview tests are recorded in
[phase 1](server-phase-1-implementation.md) and
[phase 2](account-phase-2-previews.md); those counts are not new verification.

This stage prepares Lina login/session storage, native access controls, website
account/admin controllers, and Stripe billing. AI-provider credentials are outside
scope. Administration remains web-only. Existing previews remain fixtures.

Confirmed policy: Full Access and Orchestrator, monthly/yearly subscriptions;
verified self-service paid signup; no trials or plan switching; cancellation at
renewal; five-minute online refresh; signed offline access capped at 24 hours and
session/grant expiry. Denial preserves running processes and viewing/copy/export/
stop, but blocks input and new work. Optional usage is off by default.

## Implementation status

| Area | Status |
| --- | --- |
| Normal app, website, previews and server startup | Remain disconnected |
| Prepared database/API and native handoff | Implemented; isolated PostgreSQL/API verification |
| Native encrypted sessions, IPC and entitlement policy | Implemented; native Windows/Chromium verification |
| Web controllers and billing preparation | Implemented; local HTTP and simulated Stripe verification |
| Isolated integration/security checks | Results below; no production-security guarantee |
| Live Stripe, email, hosting, operational acceptance | Not enabled; later work |

No production database, credentials, installed profile, public service or payment
account may be used by these tests. Prepared migration SQL stays outside normal
migration discovery. Prepared routes and IPC require explicit test composition;
an environment flag cannot enable them in the normal app.

## What is prepared

- `apps/server/src/prepared`: explicit app factory, browser approval and PKCE
  exchange, Ed25519 entitlements, preferences, checkout/portal operations,
  signature-verified webhook intake, reconciliation and explicit worker ticks.
  The ordinary app factory gained dependency-injection seams, not registration
  of the new endpoints. Native sessions cannot use admin or MFA-management APIs.
- `apps/server/migrations/prepared/003_paid_preparation.sql`: additive handoff,
  native-session, preference, billing and audit tables; separate manual/Stripe
  grant uniqueness and system-issued grant provenance. The temporary test
  manifest combines unchanged base migrations with this SQL. Ordinary migration
  discovery still sees only `001_auth.sql` and `002_accounts.sql`.
- Existing account administration now replaces/revokes only non-Stripe grants;
  suspension/closure still overrides all sources. Lists and counts use one
  highest valid grant per user, avoiding duplicate rows when sources coexist.
- `apps/desktop/backend/account-prepared`: injected transport, browser/loopback
  login, encrypted session store, random persistent installation identity, access
  policy, runtime guard inventory, strict IPC installer and opt-in activity
  adapter. The renderer adapter is separately under `frontend/account-prepared`.
- `apps/website/frontend/src/account-prepared`: typed account/admin clients,
  asynchronous controllers, validated billing navigation and explicit desktop
  approval. Its dedicated test HTML/Vite entry is separate from both production
  and the original mock previews.
- [Prepared API contract](../apps/server/contracts/prepared/README.md): additive,
  explicitly unmounted OpenAPI and wire/lifecycle notes. It does not replace or
  silently enlarge the normal API contract.

The native guard inventory covers PTY launch/input, Fusion/Open Fusion controls,
Orchestrator send/enqueue/retry/dispatch, voice, provider-setting mutations, and
explicit internal restore/queue/warm-spare operations. Unknown operations fail
closed. These are callable guard adapters, **not enforcement in the running
product**: later wiring must use them at the actual execution points, including
internal calls that bypass IPC. Turning listening off and stopping work remain
allowed after expiry; arbitrary terminal input does not.

## Security behavior and findings

Browser handoffs have random state, PKCE S256, exact temporary loopback callbacks,
a ten-minute attempt lifetime and a sixty-second one-use code. Codes are stored
hashed, consumed transactionally and bound to the authorizing browser session.
The native session is separately created through Better Auth; browser MFA
privileges are not copied. Cancellation, replay, wrong verifiers, expired codes
and invalid/revoked browser sessions are covered by tests. Manual entry uses the
same verifier-bound code, never a reusable bearer token.

Web sessions remain HTTP-only cookies. Native session cookies stay in the main
process and are encrypted with Electron safeStorage. Unavailable encryption or
Linux `basic_text` selects memory-only storage, never plaintext persistence.
The random installation ID is non-secret and independent of logout. Store
construction does no I/O; the host must explicitly initialize it. Use a dedicated
account subdirectory under app userData when wiring these adapters later.

IPC checks the exact owning webContents, main frame, trusted renderer URL and
allowlisted payload. Renderer snapshots omit session cookies and signed lease
material. Authenticated transport is limited to named account operations and a
fixed origin, refuses redirects, and fences late credential responses after
logout/account changes. Optional usage rejects private/unknown fields before
transport as well as on the server.

Offline access requires an authentic user/session/device-bound entitlement.
Expiry is the minimum of 24 hours, session expiry and grant expiry. Online checks
run only if the host explicitly starts the five-minute timer. Connectivity or
503 dependency failures may retain a valid lease; explicit denial/revocation
clears it. Clock rollback requires online recovery. Stop/view/copy/export remain
available and already running processes are not killed. Queued work rechecks
access at execution. Old verification keys may be retained during signing-key
rotation for outstanding leases; the client never accepts keys embedded in a
token. Offline revocation can consequently take up to the remaining lease time.

Stripe SDK **22.6.2**, API **2026-08-26.dahlia**, is server-only and accepts
explicit test configuration. The shipped preparation refuses live keys/events;
tests make no external Stripe calls. Four server-owned tier/interval price
mappings and a restricted portal configuration are required. Actual prices,
currencies and IDs remain unset. Only verified payment state grants access;
redirects, customer-supplied IDs and checkout initiation cannot do so.

Checkout reservations commit before provider calls and retry the same idempotency
key after a lost response. Current Stripe subscription state is checked to avoid
duplicates when webhooks lag. Billing reconciliation serializes snapshots per
customer, writes append-only audit records and cannot reactivate suspended or
closed accounts. Previously closed/reopened accounts require review. Manual
grants coexist with paid grants; their highest valid tier wins.

Cancellation preserves paid-through access. Failed renewal grants no extra time.
Full refunds invalidate the affected paid period; partial refunds retain it;
disputes hold the affected paid grant until resolution. The adapter is deliberately
bounded to the simple one-subscription/card-payment model; unsupported records,
multiple current subscriptions or pagination beyond the supported bound fail
for investigation rather than invent access. Plan switching/trials remain off.

The worker is an explicit `tick()` factory: durable event retry, a cursor-based
missed-webhook sweep, expired handoff cleanup, 30-day processed-event retention
and 365-day billing audit retention. No normal worker starts it. Prepared billing
metrics retain bearer protection; prepared alert rules are examples, not a live
monitoring setup.

Repairs found by tests/review:

1. Concurrent checkout stages acquired profile/billing locks in opposite order;
   the fixed order and durable reservation are regression-tested.
2. Bun's Stripe crypto provider requires asynchronous signature verification;
   the adapter and fixtures now use the official asynchronous methods.
3. A delegated Hono response discarded renewal headers set before delegation;
   renewal cookies now merge afterward without overriding logout cookies.
4. Late transport responses could restore an old session cookie; credential
   generations now reject stale responses. IPC also rejects a trusted frame
   after it navigates to another URL.
5. Optional usage initially relied on server rejection; the native adapter now
   validates its privacy schema before transmitting anything.
6. A local failure after code exchange could leave the browser flow waiting;
   consumed attempts now close and expose a safe, recoverable error state.

References: [native browser login](https://www.rfc-editor.org/rfc/rfc8252),
[Electron storage limitations](https://www.electronjs.org/docs/latest/api/safe-storage),
[Stripe webhook delivery/signatures](https://docs.stripe.com/webhooks).

## Acceptance evidence

Run from the repository root:

```powershell
npm run test:account-prepared
npm run smoke:account-prepared
npm run test:account-previews
node scripts/run-app.cjs server contracts:prepared
```

The preparation checks comprise **3 isolation checks, 14 native unit/security
tests, 6 web controller tests and 62 server tests** (85 total). The
server suite retains the original real PostgreSQL/auth/MFA/outage/HTTP-restart/
backup-restore checks and adds native/billing/privacy/worker/SDK scenarios.
The original **11 preview tests** remain separate.

The dedicated smoke builds only its test web entry, starts a disposable Docker
fixture with synthetic users/email/payments, and runs hidden Chromium/Electron
windows in an isolated profile. It proves browser cookie/MFA behavior, native
PKCE callback, real Windows encryption, credential-free renderer IPC, native
session recovery in a second Electron process, service reconstruction,
suspension and logout. It stops/removes its container and deletes its temporary
fixture-control configuration. The remaining profile contains synthetic QA
artifacts, never an installed user's data.

Normal desktop/website builds and preview builds passed. The website HTTP/docs
tests and three repository-boundary tests passed. One website concurrent-waitlist
assertion failed while builds ran; the isolated rerun after builds passed. Its
cause was not established and is not attributed to the account code.

The normal server Docker image was built and inspected: prepared source, SQL,
contracts and generator are absent, and only the two base migrations remain.
Scans of both normal frontend bundles found no prepared entry-point markers.
Native packaging explicitly excludes `backend/account-prepared/**`; a new
installer was not built. Prometheus `promtool` validated both prepared alert
rules, without loading them into a running monitoring service.

Local evidence is under `apps/server/.tmp/account-prepared-final-gate.log`,
`apps/server/.tmp/account-prepared-runtime-build.log`, and
`apps/desktop/.tmp/account-prepared-smoke.log`. The successful eight-check
Chromium/Windows run also wrote per-process result JSON under
`apps/desktop/.tmp/account-prepared-smoke/lina-account-prepared-smoke-2710fbef3a45`.
These are ignored verification artifacts, not source or deployment credentials.

Server formatting and normal/prepared contract generation are checked. The
normal OpenAPI remains unchanged. Added CI definitions run prepared client checks
and prepared server-contract checks; those remote workflow runs have not been
performed by this task.

Dependency audits: server **0 findings**; desktop **0 findings** after updating
the existing onnxruntime-node transitive `adm-zip` from 0.6.0 to 0.6.1. Compatible
website updates repaired five affected dependency entries, including every high
severity finding. **Two moderate entries remain: Express 4.22.2 and its qs
6.15.3 dependency.** The latter is covered by
[GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx) and
[GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g).
The current npm resolver did not apply a tested override, so that ineffective
override was removed. Do not call the website dependency audit clean; resolving
this chain is a launch gate, without silently changing Express major versions.

Local Stripe simulation is not live Stripe acceptance. Tests do not establish
resistance to a modified desktop binary or malware running as the same OS user.
No OS-default-browser launcher acceptance, packaged installer account flow,
macOS Keychain or Linux keyring acceptance is claimed. Existing fixture UI
components remain disconnected; final screen composition, async form lifecycle,
responsive/visual QA and accessibility acceptance belong to later wiring.

## Later launch work

Product wiring; real Stripe sandbox acceptance and approved prices/currencies/IDs;
Google hosting and DNS; secret provisioning; real email; monitoring/alerts;
off-machine backup/restore; platform/package acceptance. None is enabled by this
preparation stage.
