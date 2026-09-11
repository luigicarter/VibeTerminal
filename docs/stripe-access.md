# Stripe Access Record

Verified on September 10, 2026.

This Lina Terminal workspace has authenticated access to Stripe through a
user-provided restricted live-mode API key. All 11 read-access checks below
returned HTTP 200. This records access available to local development tooling;
the checks did not implement or deploy application login, billing, or licensing.

## Credential location

- Local file: `.env` in the project root.
- Environment variable: `STRIPE_SECRET_KEY`.
- Key type: restricted.
- Stripe environment: **live**, with access to real account data.
- Git protection: `.gitignore` ignores `.env` and `.env.*`, with an exception
  for `.env.example`. The root `.env` was confirmed ignored and untracked.

The credential value is intentionally absent from this document. The earlier
`.tmp/stripe.env` setup template is not the active credential location.
Other checkouts and deployed services do not automatically receive this local
file or its credentials.

## Verified access

The verification used authenticated GET requests to `https://api.stripe.com`.
Each list request used `limit=1`. Only resource names, HTTP status, and access
results were reported; credentials and returned customer data were not printed.

| Resource | Endpoint | Result |
| --- | --- | --- |
| Products | `/v1/products` | HTTP 200; read confirmed |
| Prices | `/v1/prices` | HTTP 200; read confirmed |
| Customers | `/v1/customers` | HTTP 200; read confirmed |
| Checkout Sessions | `/v1/checkout/sessions` | HTTP 200; read confirmed |
| Subscriptions | `/v1/subscriptions` | HTTP 200; read confirmed |
| Billing Portal configurations | `/v1/billing_portal/configurations` | HTTP 200; read confirmed |
| Webhook Endpoints | `/v1/webhook_endpoints` | HTTP 200; read confirmed |
| Invoices | `/v1/invoices` | HTTP 200; read confirmed |
| Payment Intents | `/v1/payment_intents` | HTTP 200; read confirmed |
| Charges | `/v1/charges` | HTTP 200; read confirmed |
| Events | `/v1/events` | HTTP 200; read confirmed |

## Verification limits

Write permissions remain unverified. Successful list requests do not establish
permission to create products or prices, configure checkout or webhooks, manage
subscriptions, issue refunds, or perform other mutations. No Stripe records
were created, changed, or deleted, and no payments were initiated by these checks.

This is a dated access record. Key rotation, revocation, or permission changes
can invalidate it. Recheck relevant access when continuing integration work.
Payment-flow tests need a separately configured sandbox key; the verified key
is live. Authentication, hosting, and database access are separate from Stripe.

## Credential handling

Load the key locally without printing `.env` or the key value. Keep credentials
out of source control, documentation, logs, screenshots, and chat. A deployed
billing service should obtain its key from server-side secret storage. Do not
embed the key in the Electron app, preload, renderer, installer, or a `VITE_`
environment variable.

For Stripe's current key management instructions, see
[API keys](https://docs.stripe.com/keys) and
[restricted API keys](https://docs.stripe.com/keys/restricted-api-keys).
