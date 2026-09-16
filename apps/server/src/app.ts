import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { Config } from './config';
import { createAuth, type Auth } from './auth';
import { migrationStatus } from './db/migrations';
import { accessFor } from './access';
import { changeAccount } from './admin/service';
import {
  registerDevice,
  heartbeat,
  ingest,
  deviceSchema,
  eventsSchema,
} from './activity';
import { body, HttpError, page, uuid } from './http';
import { log, Metrics } from './monitoring/log';

type Identity = {
  user: {
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
    role: string;
    twoFactorEnabled?: boolean;
  };
  session: { id: string; createdAt: Date; expiresAt: Date };
};
export type Env = {
  Bindings: { peerIp?: string };
  Variables: { requestId: string; identity: Identity };
};
const baseChange = {
  expectedRevision: z.number().int().min(0),
  reason: z.string().trim().min(3).max(500),
};
const tierChange = z.strictObject({
  ...baseChange,
  tier: z.enum(['full_access', 'orchestrator']),
  expiresAt: z.iso.datetime().nullable().optional(),
});
const authPaths = new Set([
  '/sign-up/email',
  '/sign-in/email',
  '/sign-out',
  '/get-session',
  '/verify-email',
  '/send-verification-email',
  '/request-password-reset',
  '/reset-password',
  '/change-password',
  '/two-factor/enable',
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
  '/two-factor/disable',
  '/two-factor/generate-backup-codes',
  '/two-factor/get-totp-uri',
]);
const signupSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  email: z.email().max(254),
  password: z.string().min(12).max(128),
  callbackURL: z.url().optional(),
});
function scrubTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubTokens);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !['token', 'sessionToken', 'password'].includes(key))
        .map(([key, v]) => [key, scrubTokens(v)]),
    );
  return value;
}
export function createApp(
  config: Config,
  pool: Pool,
  options: { auth?: Auth; migrationRoot?: URL } = {},
) {
  let instance: ReturnType<typeof createAuth> | undefined = options.auth;
  const getAuth = () => (instance ??= createAuth(config, pool));
  const app = new Hono<Env>(),
    metrics = new Metrics();
  app.use('*', secureHeaders());
  app.use('*', async (c, next) => {
    const requestId = randomUUID(),
      start = performance.now();
    c.set('requestId', requestId);
    c.header('X-Request-Id', requestId);
    c.header('Cache-Control', 'no-store');
    await next();
    const durationMs = Math.round(performance.now() - start);
    metrics.record(c.res.status, durationMs);
    log(c.res.status >= 500 ? 'error' : 'info', 'http_request', {
      requestId,
      route: c.req.routePath || 'unmatched',
      status: c.res.status,
      durationMs,
    });
  });
  app.use(
    '*',
    bodyLimit({
      maxSize: 32768,
      onError: (c) =>
        c.json(
          { error: { code: 'body_too_large', requestId: c.get('requestId') } },
          413,
        ),
    }),
  );
  app.onError((error, c) => {
    const known = error instanceof HttpError;
    if (!known)
      log('error', 'request_dependency_error', {
        requestId: c.get('requestId'),
      });
    return c.json(
      {
        error: {
          code: known ? error.code : 'service_unavailable',
          requestId: c.get('requestId'),
        },
      },
      (known ? error.status : 503) as 400,
    );
  });
  app.notFound((c) =>
    c.json(
      { error: { code: 'not_found', requestId: c.get('requestId') } },
      404,
    ),
  );
  app.get('/health/live', (c) =>
    c.json({ status: 'live', service: 'lina-account-server' }),
  );
  app.get('/health/ready', async (c) => {
    try {
      const state = await migrationStatus(pool, options.migrationRoot);
      return c.json(
        {
          status: state.ready ? 'ready' : 'not_ready',
          ...(state.ready ? {} : { code: 'schema_not_ready' }),
        },
        state.ready ? 200 : 503,
      );
    } catch {
      return c.json({ status: 'not_ready', code: 'database_unavailable' }, 503);
    }
  });
  app.get('/internal/metrics', async (c) => {
    const got = Buffer.from(c.req.header('authorization') || ''),
      want = Buffer.from('Bearer ' + config.METRICS_TOKEN);
    if (got.length !== want.length || !timingSafeEqual(got, want))
      throw new HttpError(401, 'monitoring_auth_required');
    const jobs = await pool.query(
      'SELECT name,extract(epoch FROM last_success_at)::float AS last FROM job_status',
    );
    const pending = await pool.query(
      'SELECT count(*)::int AS n,coalesce(extract(epoch FROM now()-min(created_at)),0)::float AS age FROM email_outbox WHERE processed_at IS NULL',
    );
    const lines = jobs.rows
      .filter((j) => ['retention', 'email', 'backup'].includes(j.name))
      .map(
        (j) => `lina_job_last_success_seconds{job="${j.name}"} ${j.last || 0}`,
      )
      .join('\n');
    return c.text(
      metrics.text() +
        `lina_db_pool_total ${pool.totalCount}\nlina_db_pool_waiting ${pool.waitingCount}\nlina_email_pending ${pending.rows[0].n}\nlina_email_oldest_seconds ${pending.rows[0].age}\n` +
        lines +
        '\n',
    );
  });
  app.use('/api/*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && !config.origins.includes(origin))
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
    if (!['GET', 'HEAD'].includes(c.req.method) && !origin)
      throw new HttpError(403, 'origin_required');
    const peer = c.env?.peerIp || 'unknown';
    const forwarded = c.req.header('x-real-ip');
    const ip =
      config.proxyIps.includes(peer) && forwarded && isIP(forwarded)
        ? forwarded
        : peer;
    const scope = c.req.path.startsWith('/api/auth/') ? 'auth' : 'api';
    const max = scope === 'auth' ? 40 : 300;
    const key = createHash('sha256')
      .update(scope + ':' + ip + ':' + Math.floor(Date.now() / 60000))
      .digest('hex');
    const limit = await pool.query(
      "INSERT INTO rate_limits(key,count,expires_at) VALUES($1,1,now()+interval '2 minutes') ON CONFLICT(key) DO UPDATE SET count=rate_limits.count+1 RETURNING count",
      [key],
    );
    if (limit.rows[0].count > max) {
      c.header('Retry-After', '60');
      throw new HttpError(429, 'rate_limited');
    }
    await next();
  });
  app.all('/api/auth/*', async (c) => {
    const path = c.req.path.slice('/api/auth'.length);
    if (
      !authPaths.has(path) &&
      !/^\/reset-password\/[a-zA-Z0-9_-]+$/.test(path)
    )
      throw new HttpError(404, 'auth_endpoint_not_available');
    if (path === '/sign-up/email') {
      const input = await c.req.raw
        .clone()
        .json()
        .catch(() => {
          throw new HttpError(400, 'invalid_json');
        });
      if (!signupSchema.safeParse(input).success)
        throw new HttpError(400, 'invalid_input');
    }
    const current = [
      '/sign-out',
      '/two-factor/verify-totp',
      '/two-factor/verify-backup-code',
      '/two-factor/disable',
    ].includes(path)
      ? await getAuth().api.getSession({ headers: c.req.raw.headers })
      : null;
    if (
      current &&
      ['/two-factor/verify-totp', '/two-factor/verify-backup-code'].includes(
        path,
      )
    ) {
      const key = `factor:${current.user.id}:${Math.floor(Date.now() / 300000)}`;
      const attempts = await pool.query(
        "INSERT INTO rate_limits(key,count,expires_at) VALUES($1,1,now()+interval '6 minutes') ON CONFLICT(key) DO UPDATE SET count=rate_limits.count+1 RETURNING count",
        [key],
      );
      if (attempts.rows[0].count > 10)
        throw new HttpError(429, 'factor_rate_limited');
    }
    if (['/two-factor/disable', '/two-factor/enable'].includes(path)) {
      if (path === '/two-factor/disable' && current?.user.role !== 'member')
        throw new HttpError(403, 'privileged_account_requires_mfa');
    }
    const response = await getAuth().handler(c.req.raw);
    if (response.status >= 500) throw new HttpError(503, 'service_unavailable');
    if (path === '/sign-out' && response.ok && current)
      await pool.query(
        "INSERT INTO security_events(user_id,event) VALUES($1,'logged_out')",
        [current.user.id],
      );
    const copy = response.headers
      .get('content-type')
      ?.includes('application/json')
      ? await response
          .clone()
          .json()
          .catch(() => null)
      : null;
    if (path === '/sign-in/email') {
      const userId =
        response.ok && copy?.user?.id && !copy?.twoFactorRedirect
          ? copy.user.id
          : null;
      const event = !response.ok
        ? 'login_failed'
        : copy?.twoFactorRedirect
          ? 'login_challenge'
          : 'login_succeeded';
      await pool.query(
        'INSERT INTO security_events(user_id,event) VALUES($1,$2)',
        [userId, event],
      );
      if (userId)
        await pool.query(
          'UPDATE account_profiles SET last_login_at=now() WHERE user_id=$1',
          [userId],
        );
    }
    if (copy) {
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      return new Response(JSON.stringify(scrubTokens(copy)), {
        status: response.status,
        headers,
      });
    }
    return response;
  });
  app.use('/api/v1/*', async (c, next) => {
    const { response: session, headers } = await getAuth().api.getSession({
      headers: c.req.raw.headers,
      returnHeaders: true,
    });
    for (const cookie of headers.getSetCookie())
      c.header('Set-Cookie', cookie, { append: true });
    if (!session) throw new HttpError(401, 'session_invalid');
    c.set('identity', session as Identity);
    await next();
  });
  app.get('/api/v1/me', async (c) => {
    const { user } = c.get('identity');
    return c.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerified,
        role: user.role,
        twoFactorEnabled: !!user.twoFactorEnabled,
      },
      access: await accessFor(pool, user.id),
    });
  });
  app.get('/api/v1/me/access', async (c) =>
    c.json(await accessFor(pool, c.get('identity').user.id)),
  );
  async function sessions(userId: string) {
    return (
      await pool.query(
        'SELECT s.id,s."createdAt" AS created_at,s."expiresAt" AS expires_at,d.id AS device_id,d.platform,d.app_version,sd.last_seen_at,(sd.last_seen_at>now()-interval \'3 minutes\') AS recently_seen FROM session s LEFT JOIN session_devices sd ON sd.session_id=s.id LEFT JOIN devices d ON d.id=sd.device_id WHERE s."userId"=$1 AND s."expiresAt">now() ORDER BY s."createdAt" DESC',
        [userId],
      )
    ).rows;
  }
  app.get('/api/v1/me/sessions', async (c) =>
    c.json({ sessions: await sessions(c.get('identity').user.id) }),
  );
  app.delete('/api/v1/me/sessions/:id', async (c) => {
    const { user, session } = c.get('identity');
    if (Date.now() - new Date(session.createdAt).getTime() > 300000)
      throw new HttpError(403, 'recent_login_required');
    const result = await pool.query(
      'DELETE FROM session WHERE id=$1 AND "userId"=$2 RETURNING id',
      [uuid(c.req.param('id')), user.id],
    );
    if (!result.rowCount) throw new HttpError(404, 'session_not_found');
    await pool.query(
      "INSERT INTO security_events(user_id,event) VALUES($1,'session_revoked')",
      [user.id],
    );
    return c.json({ ok: true });
  });
  async function requireProduct(userId: string) {
    const access = await accessFor(pool, userId);
    if (!access.allowed) throw new HttpError(403, access.reason!);
    return access;
  }
  app.use('/api/v1/activity/*', async (c, next) => {
    const { user, session } = c.get('identity');
    await requireProduct(user.id);
    const key = `usage:${session.id}:${Math.floor(Date.now() / 60000)}`;
    const n = await pool.query(
      "INSERT INTO rate_limits(key,count,expires_at) VALUES($1,1,now()+interval '2 minutes') ON CONFLICT(key) DO UPDATE SET count=rate_limits.count+1 RETURNING count",
      [key],
    );
    if (n.rows[0].count > 30) throw new HttpError(429, 'rate_limited');
    await next();
  });
  app.post('/api/v1/devices/register', async (c) => {
    const { user, session } = c.get('identity');
    await requireProduct(user.id);
    return c.json(
      await registerDevice(
        pool,
        user.id,
        session.id,
        await body(c, deviceSchema),
      ),
    );
  });
  app.post('/api/v1/activity/heartbeat', async (c) => {
    const { user, session } = c.get('identity'),
      input = await body(c, z.strictObject({ deviceId: z.uuid() }));
    return c.json(await heartbeat(pool, user.id, session.id, input.deviceId));
  });
  app.post('/api/v1/activity/events', async (c) => {
    if (!config.USAGE_ENABLED)
      throw new HttpError(403, 'usage_collection_disabled');
    const { user, session } = c.get('identity');
    return c.json(
      await ingest(pool, user.id, session.id, await body(c, eventsSchema)),
    );
  });
  app.use('/api/v1/admin/*', async (c, next) => {
    const { user, session } = c.get('identity');
    const result = await pool.query(
      'SELECT u.role,u."twoFactorEnabled",p.status,f.verified_at FROM "user" u JOIN account_profiles p ON p.user_id=u.id LEFT JOIN session_factors f ON f.session_id=$2 WHERE u.id=$1',
      [user.id, session.id],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.status !== 'active' ||
      !['owner', 'admin'].includes(row.role)
    )
      throw new HttpError(403, 'admin_required');
    if (!row.twoFactorEnabled || !row.verified_at)
      throw new HttpError(403, 'mfa_required');
    if (
      !['GET', 'HEAD'].includes(c.req.method) &&
      (Date.now() - new Date(session.createdAt).getTime() > 300000 ||
        Date.now() - row.verified_at.getTime() > 300000)
    )
      throw new HttpError(403, 'recent_login_required');
    await next();
  });
  app.get('/api/v1/admin/users', async (c) => {
    const { limit, offset } = page(c),
      search = c.req.query('search') || '',
      status = c.req.query('status') || '',
      tier = c.req.query('tier') || '';
    if (
      search.length > 100 ||
      (status &&
        !['pending', 'active', 'suspended', 'closed'].includes(status)) ||
      (tier && !['full_access', 'orchestrator'].includes(tier))
    )
      throw new HttpError(400, 'invalid_filter');
    const result = await pool.query(
      `SELECT u.id,u.email,u.name,u.role,u."emailVerified",p.status,p.revision,p.last_login_at,
      g.plan_id AS assigned_tier,g.source,g.expires_at,(SELECT max(last_seen_at) FROM devices WHERE user_id=u.id) AS last_seen_at
      FROM "user" u JOIN account_profiles p ON p.user_id=u.id LEFT JOIN LATERAL (
        SELECT ag.* FROM access_grants ag JOIN plans plan ON plan.id=ag.plan_id
        WHERE ag.user_id=u.id AND ag.revoked_at IS NULL AND ag.starts_at<=now() AND (ag.expires_at IS NULL OR ag.expires_at>now())
        ORDER BY plan.rank DESC,ag.expires_at DESC NULLS FIRST,ag.id LIMIT 1
      ) g ON true
      WHERE ($1='' OR position(lower($1) in lower(u.email))>0) AND ($2='' OR p.status=$2) AND ($3='' OR g.plan_id=$3)
      ORDER BY u."createdAt" DESC,u.id LIMIT $4 OFFSET $5`,
      [search, status, tier, limit, offset],
    );
    return c.json({ users: result.rows, limit, offset });
  });
  app.get('/api/v1/admin/users/:id', async (c) => {
    const id = uuid(c.req.param('id'));
    const user = await pool.query(
      'SELECT u.id,u.email,u.name,u.role,u."emailVerified",p.* FROM "user" u JOIN account_profiles p ON p.user_id=u.id WHERE u.id=$1',
      [id],
    );
    if (!user.rowCount) throw new HttpError(404, 'account_not_found');
    return c.json({
      user: user.rows[0],
      access: await accessFor(pool, id),
      sessions: await sessions(id),
      grants: (
        await pool.query(
          'SELECT * FROM access_grants WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',
          [id],
        )
      ).rows,
    });
  });
  for (const [method, action] of [
    ['post', 'approve'],
    ['put', 'access'],
    ['patch', 'status'],
    ['post', 'revoke-access'],
    ['post', 'revoke-sessions'],
    ['patch', 'role'],
  ] as const) {
    app[method]('/api/v1/admin/users/:id/' + action, async (c) => {
      const input = await body(
        c,
        action === 'approve' || action === 'access'
          ? tierChange
          : action === 'status'
            ? z.strictObject({
                ...baseChange,
                status: z.enum(['pending', 'active', 'suspended', 'closed']),
              })
            : action === 'role'
              ? z.strictObject({
                  ...baseChange,
                  role: z.enum(['member', 'admin', 'owner']),
                })
              : z.strictObject(baseChange),
      );
      return c.json(
        await changeAccount(
          pool,
          c.get('identity').user.id,
          uuid(c.req.param('id')!),
          action,
          input,
          c.get('requestId'),
          c.get('identity').session.id,
        ),
      );
    });
  }
  app.get('/api/v1/admin/users/:id/activity', async (c) => {
    const id = uuid(c.req.param('id')),
      { limit, offset } = page(c);
    const events = await pool.query(
      `SELECT * FROM (
      SELECT id,event,created_at AS time,'server_observed' AS source FROM security_events WHERE user_id=$1
      UNION ALL SELECT id,event,received_at AS time,'client_reported' AS source FROM activity_events WHERE user_id=$1
      ) e ORDER BY time DESC,id LIMIT $2 OFFSET $3`,
      [id, limit, offset],
    );
    return c.json({
      events: events.rows,
      limit,
      offset,
      daily: (
        await pool.query(
          'SELECT day,event,count FROM activity_daily WHERE user_id=$1 ORDER BY day DESC,event LIMIT 100',
          [id],
        )
      ).rows,
    });
  });
  app.get('/api/v1/admin/overview', async (c) => {
    const accounts = await pool.query(
      'SELECT status,count(*)::int AS count FROM account_profiles GROUP BY status',
    );
    const tiers = await pool.query(
      `SELECT chosen.plan_id,count(*)::int AS count FROM account_profiles p JOIN "user" u ON u.id=p.user_id
        JOIN LATERAL (SELECT g.plan_id FROM access_grants g JOIN plans plan ON plan.id=g.plan_id
          WHERE g.user_id=p.user_id AND g.revoked_at IS NULL AND g.starts_at<=now() AND (g.expires_at IS NULL OR g.expires_at>now())
          ORDER BY plan.rank DESC,g.expires_at DESC NULLS FIRST,g.id LIMIT 1) chosen ON true
        WHERE p.status='active' AND u."emailVerified" GROUP BY chosen.plan_id`,
    );
    const recent = await pool.query(
      `SELECT count(DISTINCT sd.user_id)::int AS count FROM session_devices sd JOIN session s ON s.id=sd.session_id WHERE sd.last_seen_at>now()-interval '3 minutes' AND s."expiresAt">now()`,
    );
    const failures = await pool.query(
      "SELECT count(*)::int AS count FROM security_events WHERE event='login_failed' AND created_at>now()-interval '24 hours'",
    );
    return c.json({
      accounts: accounts.rows,
      tiers: tiers.rows,
      recentlySeen: recent.rows[0].count,
      loginFailures24h: failures.rows[0].count,
      usageSource: 'client_reported',
    });
  });
  app.get('/api/v1/admin/audit', async (c) => {
    const { limit, offset } = page(c);
    return c.json({
      events: (
        await pool.query(
          'SELECT * FROM admin_audit_events ORDER BY created_at DESC,id LIMIT $1 OFFSET $2',
          [limit, offset],
        )
      ).rows,
      limit,
      offset,
    });
  });
  return {
    app,
    get auth() {
      return getAuth();
    },
    metrics,
  };
}
