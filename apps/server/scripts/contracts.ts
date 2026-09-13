import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { deviceSchema, eventsSchema } from '../src/activity';
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: 'object', properties, required });
const text = { type: 'string' },
  id = { type: 'string', format: 'uuid' },
  time = { type: 'string', format: 'date-time' },
  nullableTime = { anyOf: [time, { type: 'null' }] };
const status = {
    type: 'string',
    enum: ['pending', 'active', 'suspended', 'closed'],
  },
  tier = { type: 'string', enum: ['full_access', 'orchestrator'] },
  role = { type: 'string', enum: ['member', 'admin', 'owner'] };
const access = object({
  allowed: { type: 'boolean' },
  reason: { type: ['string', 'null'] },
  tier: { anyOf: [tier, { type: 'null' }] },
  features: { type: 'array', items: text },
  expiresAt: nullableTime,
  revision: { type: 'integer' },
  accountStatus: text,
  serverTime: time,
});
const user = object({
  id,
  email: { type: 'string', format: 'email' },
  name: text,
  emailVerified: { type: 'boolean' },
  role,
  twoFactorEnabled: { type: 'boolean' },
});
const change = object({
  expectedRevision: { type: 'integer', minimum: 0 },
  reason: { type: 'string', minLength: 3, maxLength: 500 },
});
const assignment = {
  ...object({ ...change.properties, tier, expiresAt: nullableTime }, [
    'expectedRevision',
    'reason',
    'tier',
  ]),
  additionalProperties: false,
};
const anyObject = { type: 'object', additionalProperties: true };
const session = object({
  id,
  created_at: time,
  expires_at: time,
  device_id: { anyOf: [id, { type: 'null' }] },
  platform: { type: ['string', 'null'] },
  app_version: { type: ['string', 'null'] },
  last_seen_at: nullableTime,
  recently_seen: { type: ['boolean', 'null'] },
});
const json = (schema: unknown) => ({ 'application/json': { schema } });
const paths: Record<string, any> = {};
function endpoint(
  path: string,
  method: string,
  summary: string,
  request?: unknown,
  response: unknown = anyObject,
  admin = false,
  anonymous = false,
) {
  const parameters = path.includes('{id}')
    ? [{ name: 'id', in: 'path', required: true, schema: id }]
    : [];
  const operation: any = {
    summary,
    tags: [
      admin
        ? 'Administration'
        : path.startsWith('/api/auth')
          ? 'Authentication'
          : path.includes('activity')
            ? 'Activity'
            : 'Accounts',
    ],
    parameters,
    security: anonymous
      ? []
      : [{ sessionCookie: [] }, { developmentSessionCookie: [] }],
    responses: {
      '200': { description: 'Successful response', content: json(response) },
      ...Object.fromEntries(
        [400, 401, 403, 404, 409, 413, 429, 503].map((code) => [
          code,
          {
            description:
              'See stable error code; authentication library errors retain their own 4xx codes.',
            content: json(anyObject),
          },
        ]),
      ),
    },
  };
  if (request)
    operation.requestBody = { required: true, content: json(request) };
  if (admin)
    operation.description =
      'Requires an active admin/owner account and verified MFA on this session. Mutations require session creation and MFA within five minutes. Role changes and changes to privileged users require owner authority.';
  (paths[path] ??= {})[method] = operation;
}
endpoint(
  '/api/v1/me',
  'get',
  'Read your identity and access',
  undefined,
  object({ user, access }),
);
endpoint(
  '/api/v1/me/access',
  'get',
  'Read effective server-authorized product access',
  undefined,
  access,
);
endpoint(
  '/api/v1/me/sessions',
  'get',
  'List your sanitized sessions',
  undefined,
  object({ sessions: { type: 'array', items: session } }),
);
endpoint(
  '/api/v1/me/sessions/{id}',
  'delete',
  'Revoke an owned session with recent authentication',
);
endpoint(
  '/api/v1/devices/register',
  'post',
  'Bind this session to an installation',
  z.toJSONSchema(deviceSchema),
  object({ deviceId: id }),
);
endpoint(
  '/api/v1/activity/heartbeat',
  'post',
  'Record current connectivity',
  object({ deviceId: id }),
  object({ lastSeenAt: time }),
);
endpoint(
  '/api/v1/activity/events',
  'post',
  'Submit allowlisted client-reported usage',
  z.toJSONSchema(eventsSchema),
  object({
    accepted: { type: 'integer' },
    duplicates: { type: 'integer' },
    source: { const: 'client_reported' },
  }),
);
endpoint(
  '/api/v1/admin/users',
  'get',
  'Search accounts by email, status and assigned tier',
  undefined,
  object({
    users: { type: 'array', items: anyObject },
    limit: { type: 'integer' },
    offset: { type: 'integer' },
  }),
  true,
);
paths['/api/v1/admin/users'].get.parameters = [
  { name: 'search', in: 'query', schema: { type: 'string', maxLength: 100 } },
  { name: 'status', in: 'query', schema: status },
  { name: 'tier', in: 'query', schema: tier },
];
endpoint(
  '/api/v1/admin/users/{id}',
  'get',
  'Read account details, effective access, grants and sessions',
  undefined,
  object({
    user: anyObject,
    access,
    sessions: { type: 'array', items: session },
    grants: { type: 'array', items: anyObject },
  }),
  true,
);
endpoint(
  '/api/v1/admin/users/{id}/approve',
  'post',
  'Approve a pending verified user and assign their tier',
  assignment,
  anyObject,
  true,
);
endpoint(
  '/api/v1/admin/users/{id}/access',
  'put',
  'Replace an administrative tier assignment',
  assignment,
  anyObject,
  true,
);
endpoint(
  '/api/v1/admin/users/{id}/status',
  'patch',
  'Suspend, reactivate, close, or reopen through allowed transitions',
  { ...object({ ...change.properties, status }), additionalProperties: false },
  anyObject,
  true,
);
endpoint(
  '/api/v1/admin/users/{id}/role',
  'patch',
  'Change role; revokes existing sessions',
  { ...object({ ...change.properties, role }), additionalProperties: false },
  anyObject,
  true,
);
for (const action of ['revoke-access', 'revoke-sessions'])
  endpoint(
    '/api/v1/admin/users/{id}/' + action,
    'post',
    action,
    { ...change, additionalProperties: false },
    anyObject,
    true,
  );
endpoint(
  '/api/v1/admin/users/{id}/activity',
  'get',
  'Read server/client event provenance and daily summaries',
  undefined,
  anyObject,
  true,
);
endpoint(
  '/api/v1/admin/overview',
  'get',
  'Count accounts, current tiers and recently connected users',
  undefined,
  anyObject,
  true,
);
endpoint(
  '/api/v1/admin/audit',
  'get',
  'Read privileged change history',
  undefined,
  anyObject,
  true,
);
for (const path of [
  '/api/v1/admin/users',
  '/api/v1/admin/users/{id}/activity',
  '/api/v1/admin/audit',
])
  paths[path].get.parameters.push(
    {
      name: 'limit',
      in: 'query',
      schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
    },
    {
      name: 'offset',
      in: 'query',
      schema: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
    },
  );
const credentials = object({
  email: { type: 'string', format: 'email' },
  password: { type: 'string', minLength: 12, maxLength: 128 },
});
endpoint(
  '/api/auth/sign-up/email',
  'post',
  'Register a pending member; requires enabled signup and email delivery',
  {
    ...object(
      {
        ...credentials.properties,
        name: { type: 'string', minLength: 1, maxLength: 80 },
        callbackURL: { type: 'string', format: 'uri' },
      },
      ['email', 'password', 'name'],
    ),
    additionalProperties: false,
  },
  anyObject,
  false,
  true,
);
endpoint(
  '/api/auth/sign-in/email',
  'post',
  'Sign in, or receive a two-factor challenge',
  credentials,
  anyObject,
  false,
  true,
);
endpoint(
  '/api/auth/get-session',
  'get',
  'Read/renew a session; token fields are stripped',
  undefined,
  anyObject,
  false,
  true,
);
endpoint('/api/auth/sign-out', 'post', 'End the current session', anyObject);
endpoint(
  '/api/auth/send-verification-email',
  'post',
  'Request verification email without account enumeration',
  object({ email: { type: 'string', format: 'email' } }),
  anyObject,
  false,
  true,
);
endpoint(
  '/api/auth/request-password-reset',
  'post',
  'Request a reset email without account enumeration',
  object(
    {
      email: { type: 'string', format: 'email' },
      redirectTo: { type: 'string', format: 'uri' },
    },
    ['email'],
  ),
  anyObject,
  false,
  true,
);
endpoint(
  '/api/auth/reset-password',
  'post',
  'Use a single-use reset token; revokes prior sessions',
  object({
    token: text,
    newPassword: { type: 'string', minLength: 12, maxLength: 128 },
  }),
  anyObject,
  false,
  true,
);
endpoint(
  '/api/auth/change-password',
  'post',
  'Change password after current-password verification',
  object(
    {
      currentPassword: text,
      newPassword: { type: 'string', minLength: 12, maxLength: 128 },
      revokeOtherSessions: { type: 'boolean' },
    },
    ['currentPassword', 'newPassword'],
  ),
);
endpoint(
  '/api/auth/two-factor/enable',
  'post',
  'Begin TOTP enrollment; returns secret and backup codes to this user',
  object({ password: text }),
);
for (const method of ['verify-totp', 'verify-backup-code'])
  endpoint(
    '/api/auth/two-factor/' + method,
    'post',
    'Verify MFA challenge and establish session-bound factor evidence',
    object({ code: text }),
    anyObject,
    false,
    true,
  );
endpoint(
  '/api/auth/two-factor/disable',
  'post',
  'Disable MFA for a member account; privileged accounts cannot disable it',
  object({ password: text }),
);
for (const path of ['/health/live', '/health/ready'])
  endpoint(
    path,
    'get',
    path.endsWith('live')
      ? 'Process liveness'
      : 'Actual database and migration readiness',
    undefined,
    anyObject,
    false,
    true,
  );
paths['/health/ready'].get.responses['503'].description =
  'Database unavailable or migration state differs from this release';
const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Lina account API',
    version: '0.1.0',
    description:
      'Bun + TypeScript account service. All mutating API calls require an exact trusted Origin header, including CLI clients. Session cookies are HTTP-only. This contract contains no server credentials. Email verification links and reset callbacks are handled by Better Auth 1.7.4; use links from email as opaque values.',
  },
  servers: [
    {
      url: 'http://127.0.0.1:3002',
      description: 'Local development; configure HTTPS in production',
    },
  ],
  components: {
    securitySchemes: {
      sessionCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: '__Secure-better-auth.session_token',
      },
      developmentSessionCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: 'better-auth.session_token',
      },
    },
  },
  paths,
};
await writeFile(
  new URL('../contracts/openapi.json', import.meta.url),
  JSON.stringify(spec, null, 2) + '\n',
);
console.log('Account OpenAPI contract generated.');
