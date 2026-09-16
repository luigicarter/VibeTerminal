import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { startSchema, exchangeSchema } from '../src/prepared/native';
import { checkoutSchema } from '../src/prepared/billing';
import { serverRoot } from '../src/paths';
const paths: Record<string, unknown> = {};
function route(
  path: string,
  method: string,
  summary: string,
  schema?: z.ZodType,
  security: unknown[] = [{ sessionCookie: [] }],
) {
  const operation = {
    summary,
    ...(path.includes('{id}')
      ? {
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
        }
      : {}),
    security,
    'x-lina-prepared': true,
    ...(schema
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: z.toJSONSchema(schema) } },
          },
        }
      : {}),
    responses: {
      '200': {
        description: 'Success; never includes raw session tokens in JSON',
      },
      '400': { description: 'Invalid input or exchange' },
      '401': { description: 'Invalid session' },
      '403': { description: 'Access, Origin or MFA denied' },
      '409': { description: 'Conflicting state' },
      '429': { description: 'Rate limited' },
      '503': { description: 'Dependency unavailable or billing unconfigured' },
    },
  };
  paths[path] = { ...((paths[path] as object) || {}), [method]: operation };
}
route(
  '/api/desktop-auth/start',
  'post',
  'Start a 10-minute browser authorization attempt',
  startSchema,
  [],
);
route(
  '/api/desktop-auth/attempts/{id}',
  'get',
  'Inspect an attempt before explicit browser approval',
);
route(
  '/api/desktop-auth/approve',
  'post',
  'Approve and issue a 60-second single-use PKCE-bound code',
  z.strictObject({ attemptId: z.uuid() }),
);
route(
  '/api/desktop-auth/cancel',
  'post',
  'Cancel using the attempt-scoped secret',
  z.strictObject({ attemptId: z.uuid(), cancelSecret: z.string() }),
  [],
);
route(
  '/api/desktop-auth/exchange',
  'post',
  'Exchange once for a separate HTTP-only native session cookie',
  exchangeSchema,
  [],
);
route(
  '/api/v1/me/entitlement',
  'post',
  'Issue a device/session/user-bound Ed25519 entitlement; at most 24 hours',
);
route('/api/v1/me/preferences', 'get', 'Read own optional-usage preference');
route(
  '/api/v1/me/preferences',
  'put',
  'Update own optional-usage preference',
  z.strictObject({ shareUsage: z.boolean() }),
);
route('/api/v1/billing', 'get', 'Read own billing state');
route(
  '/api/v1/billing/checkout',
  'post',
  'Create or reuse a checkout; prices are resolved server-side',
  checkoutSchema,
);
route(
  '/api/v1/billing/portal',
  'post',
  'Create own restricted customer-portal session',
);
paths['/webhooks/stripe'] = {
  post: {
    summary:
      'Verify raw Stripe signature, persist event identity, then acknowledge',
    'x-lina-prepared': true,
    security: [{ stripeSignature: [] }],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object' } } },
    },
    responses: {
      '200': { description: 'Durably accepted or ignored supported envelope' },
      '400': { description: 'Invalid signature or live-mode event' },
      '503': { description: 'Database unavailable' },
    },
  },
};
const output = {
  openapi: '3.1.0',
  info: {
    title: 'Lina prepared account additions — UNMOUNTED',
    version: '0.1.0',
    description:
      'Combined with the existing account contract only in dedicated test composition. Normal startup exposes none of these additions.',
  },
  paths,
  components: {
    securitySchemes: {
      sessionCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: '__Secure-better-auth.session_token',
      },
      stripeSignature: {
        type: 'apiKey',
        in: 'header',
        name: 'Stripe-Signature',
      },
    },
  },
  'x-lina-prepared': true,
  'x-lina-policy': {
    refreshSeconds: 300,
    maximumOfflineSeconds: 86400,
    normalStartup: false,
    livePayments: false,
  },
};
await mkdir(join(serverRoot, 'contracts/prepared'), { recursive: true });
await writeFile(
  join(serverRoot, 'contracts/prepared/openapi.json'),
  JSON.stringify(output, null, 2) + '\n',
);
