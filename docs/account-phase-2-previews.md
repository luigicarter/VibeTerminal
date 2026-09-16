# Phase 2 account interfaces — disconnected previews

September 13, 2026.

**Subsequent preparation:** [account paid readiness](account-paid-readiness.md)
records the separate tested clients/native/backend modules. This document remains
the historical preview acceptance record; these original previews are still
disconnected and have not been converted to real authentication.

The user requested the phase-2 interfaces to be built **without wiring them yet**,
and clarified that **administration must be a web interface, not part of the
desktop application**. These constraints remain in effect for subsequent work.

## Delivered surfaces

| Surface | Source | Local preview |
| --- | --- | --- |
| Desktop personal account | apps/desktop/frontend/account | http://127.0.0.1:5185/ |
| Web account and sign-in | apps/website/frontend/src/account | http://127.0.0.1:5186/account-preview.html |
| Web administration | apps/website/frontend/src/admin | http://127.0.0.1:5186/ or /admin-preview.html |

The desktop contains no administrator controls, roles, routes, or links. The
administration view has its own browser entry point and access-state previews.
Client presentation code stays with the app that owns it; server logic remains
in apps/server and was not changed for this work.

## What can be reviewed

Desktop: sign-in and account creation entry actions, waiting for the browser,
manual sign-in code, interrupted sign-in, verification, pending approval,
suspension, expiry, offline grace/expired grace, both plan presentations, signed-in
devices, session revocation confirmation, sign-out and an optional usage toggle.
The offline grace date is an example scenario, not a finalized product policy.

Web account: registration, sign-in, password visibility, verification/resend,
password recovery, reset confirmation, six-digit MFA, approval/access denial and
connection states, plus personal plan details, devices and a privacy preference.

Web administration: sign-in, MFA challenge/enrollment/recovery-code views, access
denied/loading/error states, account overview, search and status/plan filters,
account details, approval/tier/expiry forms, suspension/reactivation/closure,
reopening, grant/session revocation, activity provenance and audit history.
Mock changes require a reason and respect sample revisions, email verification,
and the last-owner rule. Errors stay visible in the form instead of discarding
the user's draft. These are fixture behaviors, not security enforcement.

Use the preview control bar to select scenarios, simulate errors, or reset sample
data. Admin changes affect only an in-memory sample directory. Names and emails
are fictitious; email addresses use example.test. MFA setup keys/recovery codes
are demonstration values and must never be used for real accounts. The preview
accepts example form inputs without authenticating anyone.

## Isolation boundary

- The normal desktop App, startup entry, Settings dialog, preload and native
  backend do not import these account modules.
- The normal website App/router and marketing API do not mount these screens.
  The standalone HTML files are dev-preview entry points only.
- Preview builds write into app-owned .tmp/account-preview directories, not the
  normal dist directories. The normal production builds omit the preview UI.
- No auth SDK, API URL, fetch/HTTP client, IPC call, protocol handler, secure
  session store, browser storage or activity emitter has been connected.
- No credentials, preference changes, sessions or mock records are persisted by
  the preview code. Reload/reset restores the fixtures. Browser sign-in and
  email delivery are simulated; no browser OAuth flow or real email is sent.
- Presentation helpers such as accessSummary and applyPreviewChange must not be
  used as native/server authorization when integration begins.
- The phase-1 Docker backend containers remain stopped. The only new running
  services are the two local Vite preview servers.
- No site was published, no server database changed, and no installed desktop
  application was replaced.

## Commands

From the repository root:

```powershell
npm run preview:account:desktop
npm run preview:account:web
```

Each command starts only its own standalone preview on 5185 or 5186. The normal
desktop development port 5173 and website port 5174 retain their existing role.
The web preview's root opens administration; the account preview is a separate
page, not an admin link inside the desktop.

```powershell
npm run build:account-preview:desktop
npm run build:account-preview:web
npm run test:account-previews
```

The app-specific scripts and configs are owned by the desktop and website apps.
Root scripts only forward commands. No dependencies or package-manager choices
were changed for these previews.

## Verification

- Both standalone preview builds and their TypeScript checks passed.
- Normal desktop and website production builds passed.
- **11 state/boundary tests passed**: 4 desktop and 7 web. They cover plan/access
  presentation, protected running-work messaging, fixture mutation/auditing,
  verification/stale edit/owner guard failures, revocation semantics, and absence
  of account-network/storage/IPC operations or production imports.
- The web admin preview was opened for user review. Browser interaction,
  screenshot and responsive visual QA were not performed in this task; automated
  verification was at the model, source-boundary and build levels.
- The Sites build helper encountered an npm-path problem on Windows; the
  repository's normal npm build completed successfully instead.

## Later integration

When the user asks to wire the interfaces, connect view callbacks to the verified
server contract, add asynchronous request/loading/cancellation handling, and
replace every preview session and fixture record with authoritative responses.
Keep preview composition roots separate and out of production entry points.

Desktop integration still needs browser callback/PKCE handling, secure session
persistence, main-process access checks for all launch/control paths, and the
agreed offline/running-work policy. Activity emission must be explicit and follow
the agreed collection settings. Those mechanisms are not implemented by these
presentation previews.

Administration remains web-only, with backend role/MFA enforcement. Do not add
admin navigation or account-management IPC to the desktop during wiring. Real
Google deployment and email/monitoring setup retain the separate outstanding
requirements in the [phase 1 record](server-phase-1-implementation.md). Billing
remains a later phase.
