import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { randomUUID, createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createApp, type Env } from '../app';
import { createAuth } from '../auth';
import type { Config } from '../config';
import { body, HttpError, uuid } from '../http';
import {
  nativePlugin,
  startSchema,
  startHandoff,
  approveHandoff,
  cancelHandoff,
} from './native';
import { issueEntitlement, type LeaseSigner } from './entitlements';
import {
  createBilling,
  checkoutSchema,
  type BillingTransport,
} from './billing';
import { log } from '../monitoring/log';

// No default origin, secret, DB, worker, listener, or auto-enable environment flag.
export function createPreparedApp(
  config: Config,
  pool: Pool,
  options: {
    migrationRoot: URL;
    signer: LeaseSigner;
    billing?: BillingTransport;
  },
) {
  const auth = createAuth(config, pool, [nativePlugin(pool)]);
  const base = createApp(config, pool, {
    auth,
    migrationRoot: options.migrationRoot,
  });
  const billing = createBilling(pool, options.billing, config.PUBLIC_URL);
  if (
    options.signer.issuer !== config.PUBLIC_URL ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(options.signer.keyId)
  )
    throw new Error('Invalid entitlement issuer configuration');
  const app = new Hono<Env>();
  app.use('*', secureHeaders());
  app.use('*', async (c, next) => {
    c.set('requestId', randomUUID());
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    await next();
  });
  app.onError((error, c) => {
    log('error', 'prepared_request_failed', { requestId: c.get('requestId') });
    return c.json(
      {
        error: {
          code: error instanceof HttpError ? error.code : 'service_unavailable',
          requestId: c.get('requestId'),
        },
      },
      (error instanceof HttpError ? error.status : 503) as 400,
    );
  });
  app.use(
    '*',
    bodyLimit({
      maxSize: 1048576,
      onError: (c) => c.json({ error: { code: 'body_too_large' } }, 413),
    }),
  );
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 32768,
      onError: (c) => c.json({ error: { code: 'body_too_large' } }, 413),
    }),
  );
  async function identity(headers: Headers) {
    const result = await auth.api.getSession({ headers });
    if (!result) throw new HttpError(401, 'session_invalid');
    return result;
  }
  const isNative = async (sessionId: string) =>
    !!(
      await pool.query('SELECT 1 FROM native_sessions WHERE session_id=$1', [
        sessionId,
      ])
    ).rowCount;
  app.use('/api/*', async (c, next) => {
    const origin = c.req.header('origin');
    if (
      (origin && !config.origins.includes(origin)) ||
      (!['GET', 'HEAD'].includes(c.req.method) && !origin)
    )
      throw new HttpError(403, 'origin_not_allowed');
    if (origin) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Credentials', 'true');
      c.header('Vary', 'Origin');
    }
    if (c.req.method === 'OPTIONS') {
      c.header(
        'Access-Control-Allow-Methods',
        'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      );
      c.header('Access-Control-Allow-Headers', 'Content-Type');
      return c.body(null, 204);
    }
    const peer = c.env?.peerIp || 'unknown',
      forwarded = c.req.header('x-real-ip');
    const ip =
      config.proxyIps.includes(peer) && forwarded && isIP(forwarded)
        ? forwarded
        : peer;
    const key = createHash('sha256')
      .update(`prepared:${ip}:${Math.floor(Date.now() / 60000)}`)
      .digest('hex');
    const count = (
      await pool.query(
        "INSERT INTO rate_limits(key,count,expires_at) VALUES($1,1,now()+interval '2 minutes') ON CONFLICT(key) DO UPDATE SET count=rate_limits.count+1 RETURNING count",
        [key],
      )
    ).rows[0].count;
    if (count > 120) throw new HttpError(429, 'rate_limited');
    const { response: session, headers: renewal } = await auth.api.getSession({
      headers: c.req.raw.headers,
      returnHeaders: true,
    });
    if (session && (await isNative(session.session.id))) {
      const path = c.req.path;
      if (
        path.startsWith('/api/v1/admin/') ||
        (path.startsWith('/api/auth/') &&
          !['/api/auth/get-session', '/api/auth/sign-out'].includes(path))
      )
        throw new HttpError(403, 'browser_required');
    }
    await next();
    // Returning the delegated base Response replaces pre-next context headers.
    // Merge renewal after delegation, without overriding a route's logout cookie.
    const renewedCookies = renewal.getSetCookie(),
      responseHeaders = new Headers(c.res.headers);
    for (const cookie of renewedCookies) {
      const name = cookie.slice(0, cookie.indexOf('='));
      if (
        !responseHeaders
          .getSetCookie()
          .some((value) => value.startsWith(name + '='))
      )
        responseHeaders.append('Set-Cookie', cookie);
    }
    if (renewedCookies.length)
      c.res = new Response(c.res.body, {
        status: c.res.status,
        statusText: c.res.statusText,
        headers: responseHeaders,
      });
  });
  app.post('/api/desktop-auth/start', async (c) =>
    c.json(
      await startHandoff(pool, await body(c, startSchema), config.PUBLIC_URL),
    ),
  );
  app.get('/api/desktop-auth/attempts/:id', async (c) => {
    const session = await identity(c.req.raw.headers);
    if (await isNative(session.session.id))
      throw new HttpError(403, 'browser_required');
    const row = (
      await pool.query(
        `SELECT platform,app_version AS "appVersion",expires_at AS "expiresAt" FROM desktop_handoffs
      WHERE id=$1 AND expires_at>now() AND consumed_at IS NULL AND cancelled_at IS NULL`,
        [uuid(c.req.param('id'))],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, 'attempt_unavailable');
    return c.json(row);
  });
  app.post('/api/desktop-auth/approve', async (c) => {
    const session = await identity(c.req.raw.headers),
      input = await body(c, z.strictObject({ attemptId: z.uuid() }));
    return c.json(
      await approveHandoff(pool, input.attemptId, session.session.id),
    );
  });
  app.post('/api/desktop-auth/cancel', async (c) => {
    const input = await body(
      c,
      z.strictObject({
        attemptId: z.uuid(),
        cancelSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      }),
    );
    return c.json(
      await cancelHandoff(pool, input.attemptId, input.cancelSecret),
    );
  });
  app.post('/api/desktop-auth/exchange', (c) => {
    const url = new URL(c.req.url);
    url.pathname = '/api/auth/lina-desktop/exchange';
    return auth.handler(new Request(url, c.req.raw));
  });
  app.post('/api/v1/me/entitlement', async (c) => {
    const current = await identity(c.req.raw.headers);
    return c.json(
      await issueEntitlement(pool, current.session.id, options.signer),
    );
  });
  app.get('/api/v1/me/preferences', async (c) => {
    const current = await identity(c.req.raw.headers),
      row = (
        await pool.query(
          'SELECT share_usage FROM account_preferences WHERE user_id=$1',
          [current.user.id],
        )
      ).rows[0];
    return c.json({ shareUsage: row?.share_usage || false });
  });
  app.put('/api/v1/me/preferences', async (c) => {
    const current = await identity(c.req.raw.headers),
      input = await body(c, z.strictObject({ shareUsage: z.boolean() }));
    await pool.query(
      'INSERT INTO account_preferences(user_id,share_usage) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET share_usage=$2',
      [current.user.id, input.shareUsage],
    );
    return c.json(input);
  });
  app.use('/api/v1/activity/events', async (c, next) => {
    const current = await identity(c.req.raw.headers),
      row = (
        await pool.query(
          'SELECT share_usage FROM account_preferences WHERE user_id=$1',
          [current.user.id],
        )
      ).rows[0];
    if (!row?.share_usage) throw new HttpError(403, 'usage_not_consented');
    await next();
  });
  app.get('/api/v1/billing', async (c) =>
    c.json(await billing.status((await identity(c.req.raw.headers)).user.id)),
  );
  app.post('/api/v1/billing/checkout', async (c) =>
    c.json(
      await billing.checkout(
        (await identity(c.req.raw.headers)).user.id,
        await body(c, checkoutSchema),
      ),
    ),
  );
  app.post('/api/v1/billing/portal', async (c) =>
    c.json(await billing.portal((await identity(c.req.raw.headers)).user.id)),
  );
  // Signature authentication, deliberately outside browser-cookie/Origin routes.
  app.post('/webhooks/stripe', async (c) =>
    c.json(
      await billing.ingest(
        await c.req.text(),
        c.req.header('stripe-signature') || '',
      ),
    ),
  );
  app.get('/internal/metrics', async (c) => {
    const response = await base.app.fetch(c.req.raw, c.env);
    if (response.status !== 200) return response;
    const counts = (
      await pool.query(`SELECT count(*)::int AS pending,coalesce(extract(epoch FROM now()-min(received_at)),0)::float AS age,
      count(*) FILTER(WHERE attempts>0)::int AS failed FROM billing_inbox WHERE processed_at IS NULL`)
    ).rows[0];
    return c.text(
      (await response.text()) +
        `lina_billing_pending ${counts.pending}\nlina_billing_oldest_seconds ${counts.age}\nlina_billing_retrying ${counts.failed}\n`,
    );
  });
  app.all('*', (c) => base.app.fetch(c.req.raw, c.env));
  return { app, auth, billing, metrics: base.metrics };
}
