# Prepared additions — not mounted

Generate with `bun run contracts:prepared`. Combine this OpenAPI document with
the existing account contract only when explicitly composing the test service.
Neither normal startup nor an environment flag mounts these routes.

The desktop handoff returns an attempt ID, cancellation secret and an exact
same-origin browser URL. Approval returns a one-time, PKCE-bound code, state and
exact loopback callback. Exchange sets a separate Better Auth HTTP-only session
cookie and returns only `userId`, `sessionId` and `deviceId`. Native sessions
cannot use admin or MFA-management APIs. Protected calls use authoritative
database sessions, and renewal cookies must be forwarded.

Entitlements use compact EdDSA JWS: header `typ=JWT`, `alg=EdDSA`, trusted `kid`;
claims `iss`, `aud=lina-desktop`, `sub`, `sid`, `device`, `tier`, `features`,
`revision`, `iat`, `exp`. They are offline product-access evidence, not API login
credentials. Expiry is bounded by 24 hours, the session and the selected grant.

Checkout takes only tier and interval; prices and Stripe customer identity are
server-controlled. Returns contain an allowlisted hosted URL. Billing status
contains `configured`, `status`, `paidThrough`, `cancelAtPeriodEnd`. Redirects do
not prove payment. Webhooks verify the untouched body with the official Stripe
SDK, acknowledge after durable intake, and reconcile current provider state.
Prepared Stripe configuration accepts test keys only.

The [readiness record](../../../../docs/account-paid-readiness.md) describes the
security acceptance and explicit remaining launch work.
