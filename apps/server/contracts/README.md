# Account API contract

The generated OpenAPI contract in this folder describes the server-owned API.
Authentication endpoints are provided by Better Auth 1.7.4, restricted to the
allowlist in `src/app.ts`. Public clients use HTTPS and session cookies; server
code, database credentials, and authentication tokens from session listings are
not part of the client contract.
