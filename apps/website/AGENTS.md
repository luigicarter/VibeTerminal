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
