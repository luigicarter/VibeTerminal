# Website application

This directory owns the Lina marketing site, public documentation, pricing page,
and website API. It keeps its own npm workspaces (`frontend`, `backend`) and
lockfile. Run `npm run dev` here, or root `npm run dev:website`.

Development uses port 5174 for the frontend and port 3001 for the API; desktop
development uses 5173. Production builds and serves through this app's backend.

Do not import desktop runtime code into the site. Local screenshot tools may
target `../desktop`. Shared branding is sourced from `../../packages/brand` and
synchronized before builds. Website engineering notes live in this app's docs;
public user-guide content lives in `frontend/src/docs`.

Respect the root directory ownership rules and `../../docs/repository-layout.md`.
The hosted account server belongs in `../server`; do not add identity storage,
account/tier policy, migrations, or centralized activity ingestion to this app's
marketing backend. Future account/admin screens belong in this frontend and use
the account server's HTTPS API. Keep server-only dependencies and credentials
out of the website client.

Account UI now lives in `frontend/src/account`; administration lives in
`frontend/src/admin`. The user requested disconnected previews only. Keep their
standalone HTML/Vite preview entries out of the normal site router and server
connections until integration is requested. Administration must remain a web
interface, with no desktop admin controls or links. See
`../../docs/account-phase-2-previews.md` for commands and verification boundaries.

Typed clients/controllers in `frontend/src/account-prepared` and the separate
account-prepared harness are preparation only. They must remain absent from
normal and preview entry graphs. Dedicated tests may connect the harness to a
disposable local account backend; this does not authorize product wiring.
Current evidence and remaining security gates are in
`../../docs/account-paid-readiness.md`.
