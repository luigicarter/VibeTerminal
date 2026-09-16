import { beforeAll, afterAll, test, expect } from 'bun:test';
import {
  randomBytes,
  randomUUID,
  generateKeyPairSync,
  verify,
} from 'node:crypto';
import { fixture, Client, type Fixture } from './helpers';
import { preparedManifest, migratePrepared } from '../src/prepared/migrations';
import { createPreparedApp } from '../src/prepared/app';
import { createApp } from '../src/app';
import { migrationFiles } from '../src/db/migrations';
import { bootstrapOwner } from '../src/admin/service';
import { digest } from '../src/prepared/native';
import { stripeFixture } from './prepared-fixtures';
import { accessFor } from '../src/access';
import { createBilling } from '../src/prepared/billing';
import { createPreparedJobs } from '../src/prepared/jobs';
let f: Fixture,
  manifest: Awaited<ReturnType<typeof preparedManifest>>,
  service: ReturnType<typeof createPreparedApp>,
  owner: Client;
const stripe = stripeFixture(),
  keys = generateKeyPairSync('ed25519'),
  signer = {
    issuer: 'http://127.0.0.1:3002',
    keyId: 'test-v1',
    privateKey: keys.privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString(),
  };
beforeAll(async () => {
  f = await fixture();
  manifest = await preparedManifest();
  await migratePrepared(f.migrationPool, manifest.root);
  service = createPreparedApp(f.config, f.pool, {
    migrationRoot: manifest.root,
    signer,
    billing: stripe.transport,
  });
  f.service = service;
  owner = await new Client(f).signup();
  await bootstrapOwner(f.pool, owner.id);
  await owner.login();
  await owner.mfa();
});
afterAll(async () => {
  await f?.close();
  await manifest?.close();
});
async function handoff(browser: Client) {
  const native = new Client(f),
    verifier = randomBytes(32).toString('base64url'),
    state = randomBytes(32).toString('base64url');
  const start = await native.json('/api/desktop-auth/start', 'POST', {
    challenge: digest(verifier),
    state,
    callback:
      'http://127.0.0.1:55123/lina-login/' +
      randomBytes(32).toString('base64url'),
    installationId: randomUUID(),
    platform: 'windows',
    appVersion: '0.1.123',
  });
  expect(start.status).toBe(200);
  const approved = await browser.json('/api/desktop-auth/approve', 'POST', {
    attemptId: start.data.attemptId,
  });
  expect(approved.status).toBe(200);
  return {
    native,
    start: start.data,
    approved: approved.data,
    input: {
      attemptId: start.data.attemptId,
      code: approved.data.code,
      verifier,
      state,
    },
  };
}
async function paidUser(tier: 'full_access' | 'orchestrator' = 'full_access') {
  const user = await new Client(f).signup();
  expect(
    (
      await user.json('/api/v1/billing/checkout', 'POST', {
        tier,
        interval: 'month',
      })
    ).status,
  ).toBe(200);
  const customer = stripe.customers.get(user.id)!;
  stripe.snapshots.set(customer, {
    subscriptionId: 'sub_' + user.id.replaceAll('-', ''),
    status: 'active',
    tier,
    paidThrough: Math.floor(Date.now() / 1000) + 7200,
    cancelAtPeriodEnd: false,
    held: false,
    fullyRefunded: false,
  });
  await service.billing.reconcile(customer);
  return { user, customer };
}
test('default schema discovery and normal route registration remain unchanged', async () => {
  expect((await migrationFiles()).map((f) => f.name)).toEqual([
    '001_auth.sql',
    '002_accounts.sql',
  ]);
  const normal = createApp(f.config, f.pool);
  for (const path of [
    '/api/desktop-auth/start',
    '/api/v1/me/entitlement',
    '/api/v1/billing',
    '/webhooks/stripe',
  ])
    expect(normal.app.routes.some((r) => r.path === path)).toBe(false);
  expect((await owner.json('/health/ready')).status).toBe(200);
});
test('one-time handoff creates a separate library session with no JSON token or MFA inheritance', async () => {
  const h = await handoff(owner),
    reply = await h.native.json('/api/desktop-auth/exchange', 'POST', h.input);
  expect(reply.status).toBe(200);
  expect(JSON.stringify(reply.data)).not.toMatch(/token|password|cookie/i);
  const session = (
    await f.pool.query('SELECT * FROM native_sessions WHERE session_id=$1', [
      reply.data.sessionId,
    ])
  ).rows[0];
  expect(session.user_id).toBe(owner.id);
  expect(
    (
      await f.pool.query('SELECT 1 FROM session_factors WHERE session_id=$1', [
        reply.data.sessionId,
      ])
    ).rowCount,
  ).toBe(0);
  expect((await h.native.json('/api/v1/admin/users')).status).toBe(403);
  expect(
    (
      await h.native.json('/api/auth/two-factor/enable', 'POST', {
        password: owner.password,
      })
    ).status,
  ).toBe(403);
  expect(
    (await h.native.json('/api/desktop-auth/exchange', 'POST', h.input)).status,
  ).toBe(400);
});
test('PKCE, state and random code substitution fail without consuming the valid exchange', async () => {
  const h = await handoff(await new Client(f).signup());
  for (const bad of [
    { verifier: randomBytes(32).toString('base64url') },
    { state: randomBytes(32).toString('base64url') },
    { code: randomBytes(32).toString('base64url') },
  ])
    expect(
      (
        await h.native.json('/api/desktop-auth/exchange', 'POST', {
          ...h.input,
          ...bad,
        })
      ).status,
    ).toBe(400);
  expect(
    (await h.native.json('/api/desktop-auth/exchange', 'POST', h.input)).status,
  ).toBe(200);
});
test('concurrent code exchange has exactly one winner', async () => {
  const h = await handoff(await new Client(f).signup()),
    results = await Promise.all(
      [new Client(f), new Client(f)].map((c) =>
        c.json('/api/desktop-auth/exchange', 'POST', h.input),
      ),
    );
  expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
});
test('cancelled, expired and parent-revoked exchanges fail', async () => {
  for (const mode of ['cancel', 'expire', 'revoke']) {
    const user = await new Client(f).signup(),
      h = await handoff(user);
    if (mode === 'cancel')
      await h.native.json('/api/desktop-auth/cancel', 'POST', {
        attemptId: h.start.attemptId,
        cancelSecret: h.start.cancelSecret,
      });
    if (mode === 'expire')
      await f.pool.query(
        "UPDATE desktop_handoffs SET code_expires_at=now()-interval '1 second' WHERE id=$1",
        [h.start.attemptId],
      );
    if (mode === 'revoke') await user.json('/api/auth/sign-out', 'POST', {});
    expect(
      (await h.native.json('/api/desktop-auth/exchange', 'POST', h.input))
        .status,
    ).toBe(400);
  }
});
test('callbacks and cross-origin callers cannot redirect credentials', async () => {
  const client = new Client(f),
    value = {
      challenge: randomBytes(32).toString('base64url'),
      state: randomBytes(32).toString('base64url'),
      installationId: randomUUID(),
      platform: 'windows',
      appVersion: '0.1.123',
    };
  for (const callback of [
    'https://evil.example/lina-login/' + value.state,
    'http://localhost:1234/lina-login/' + value.state,
    'http://127.0.0.1:1234/lina-login/' + value.state + '?next=evil',
  ])
    expect(
      (
        await client.json('/api/desktop-auth/start', 'POST', {
          ...value,
          callback,
        })
      ).status,
    ).toBe(400);
  expect(
    (
      await client.request('/api/desktop-auth/start', 'POST', value, {
        origin: 'https://evil.example',
      })
    ).status,
  ).toBe(403);
});
test('paid activation, signed entitlement ownership and expiry obey real account state', async () => {
  const { user } = await paidUser('orchestrator'),
    h = await handoff(user),
    exchange = await h.native.json(
      '/api/desktop-auth/exchange',
      'POST',
      h.input,
    );
  expect(exchange.status).toBe(200);
  const issued = await h.native.json('/api/v1/me/entitlement', 'POST', {});
  expect(issued.status).toBe(200);
  const [header, payload, signature] = issued.data.entitlement.split('.'),
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  expect(
    verify(
      null,
      Buffer.from(header + '.' + payload),
      keys.publicKey,
      Buffer.from(signature, 'base64url'),
    ),
  ).toBe(true);
  expect(claims.sub).toBe(user.id);
  expect(claims.sid).toBe(exchange.data.sessionId);
  expect(claims.exp - claims.iat).toBeLessThanOrEqual(7200);
  await f.pool.query(
    "UPDATE account_profiles SET status='suspended' WHERE user_id=$1",
    [user.id],
  );
  expect(
    (await h.native.json('/api/v1/me/entitlement', 'POST', {})).status,
  ).toBe(403);
  expect((await user.json('/api/v1/me/entitlement', 'POST', {})).status).toBe(
    401,
  );
});
test('checkout reserves durable idempotency across lost responses and concurrent requests', async () => {
  const user = await new Client(f).signup(),
    before = stripe.checkouts.size;
  stripe.loseCheckoutResponse();
  expect(
    (
      await user.json('/api/v1/billing/checkout', 'POST', {
        tier: 'full_access',
        interval: 'year',
      })
    ).status,
  ).toBe(503);
  const replies = await Promise.all(
    [1, 2].map(() =>
      user.json('/api/v1/billing/checkout', 'POST', {
        tier: 'full_access',
        interval: 'year',
      }),
    ),
  );
  expect(replies.map((r) => r.status)).toEqual([200, 200]);
  expect(replies[0].data.url).toBe(replies[1].data.url);
  expect(stripe.checkouts.size - before).toBe(1);
  expect(
    (
      await user.json('/api/v1/billing/checkout', 'POST', {
        tier: 'orchestrator',
        interval: 'year',
      })
    ).status,
  ).toBe(409);
});
test('webhook signature, durable deduplication and current-state reconciliation', async () => {
  const { user, customer } = await paidUser(),
    event = await stripe.event(customer);
  const send = (payload = event.payload, signature = event.signature) =>
    service.app.request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': signature },
      body: payload,
    });
  expect((await send(event.payload + ' ')).status).toBe(400);
  expect((await send()).status).toBe(200);
  expect((await send()).status).toBe(200);
  expect(
    (
      await f.pool.query(
        'SELECT count(*)::int AS n FROM billing_inbox WHERE event_id=$1',
        [event.id],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    await createBilling(
      f.jobsPool,
      stripe.transport,
      f.config.PUBLIC_URL,
    ).work(),
  ).toBeGreaterThan(0);
  expect((await accessFor(f.pool, user.id)).allowed).toBe(true);
  expect((await send()).status).toBe(200);
  expect(await service.billing.work()).toBe(0);
});
test('manual grants coexist, admin edits retain paid access, lists count each user once', async () => {
  const { user, customer } = await paidUser(),
    revision = (await accessFor(f.pool, user.id)).revision;
  expect(
    (
      await owner.json('/api/v1/admin/users/' + user.id + '/access', 'PUT', {
        tier: 'orchestrator',
        expectedRevision: revision,
        reason: 'Manual evaluation',
      })
    ).status,
  ).toBe(200);
  expect((await accessFor(f.pool, user.id)).tier).toBe('orchestrator');
  const list = await owner.json(
    '/api/v1/admin/users?search=' + encodeURIComponent(user.email),
  );
  expect(list.data.users.length).toBe(1);
  const next = (await accessFor(f.pool, user.id)).revision;
  expect(
    (
      await owner.json(
        '/api/v1/admin/users/' + user.id + '/revoke-access',
        'POST',
        { expectedRevision: next, reason: 'End evaluation' },
      )
    ).status,
  ).toBe(200);
  expect((await accessFor(f.pool, user.id)).tier).toBe('full_access');
  const snapshot = stripe.snapshots.get(customer)!;
  stripe.snapshots.set(customer, { ...snapshot, fullyRefunded: true });
  await service.billing.reconcile(customer);
  expect((await accessFor(f.pool, user.id)).allowed).toBe(false);
});
test('cancellation, failed renewal, disputes and out-of-order delivery cannot invent paid time', async () => {
  const { user, customer } = await paidUser(),
    initial = stripe.snapshots.get(customer)!;
  stripe.snapshots.set(customer, {
    ...initial,
    status: 'past_due',
    cancelAtPeriodEnd: true,
  });
  await service.billing.reconcile(customer);
  expect((await accessFor(f.pool, user.id)).allowed).toBe(true);
  stripe.snapshots.set(customer, { ...initial, held: true });
  await service.billing.reconcile(customer);
  expect((await accessFor(f.pool, user.id)).allowed).toBe(false);
  stripe.snapshots.set(customer, initial);
  await service.billing.reconcile(customer);
  expect((await accessFor(f.pool, user.id)).allowed).toBe(true);
  stripe.snapshots.set(customer, {
    ...initial,
    paidThrough: Math.floor(Date.now() / 1000) - 1,
    status: 'canceled',
  });
  await service.billing.reconcile(customer, 'evt_oldpaid');
  expect((await accessFor(f.pool, user.id)).allowed).toBe(false);
});
test('payment cannot reactivate suspended/closed accounts and checkout cannot grant privileges', async () => {
  const { user, customer } = await paidUser();
  for (const status of ['suspended', 'closed']) {
    await f.pool.query(
      'UPDATE account_profiles SET status=$2 WHERE user_id=$1',
      [user.id, status],
    );
    await service.billing.reconcile(customer);
    expect((await accessFor(f.pool, user.id)).accountStatus).toBe(status);
    expect(
      (
        await user.json('/api/v1/billing/checkout', 'POST', {
          tier: 'full_access',
          interval: 'month',
        })
      ).status,
    ).toBe(403);
  }
  const pending = await new Client(f).signup();
  expect(
    (
      await pending.json('/api/v1/billing/checkout', 'POST', {
        tier: 'full_access',
        interval: 'month',
        userId: user.id,
      })
    ).status,
  ).toBe(400);
  expect((await accessFor(f.pool, pending.id)).allowed).toBe(false);
});
test('billing outage retries durably and audit records cannot be edited by runtime', async () => {
  const { customer } = await paidUser(),
    event = await stripe.event(customer);
  await service.billing.ingest(event.payload, event.signature);
  stripe.setUnavailable(true);
  expect(await service.billing.work()).toBe(0);
  stripe.setUnavailable(false);
  expect(
    (
      await f.pool.query(
        'SELECT last_error FROM billing_inbox WHERE event_id=$1',
        [event.id],
      )
    ).rows[0].last_error,
  ).toBe('reconciliation_failed');
  await f.pool.query(
    'UPDATE billing_inbox SET next_attempt_at=now() WHERE event_id=$1',
    [event.id],
  );
  expect(await service.billing.work()).toBeGreaterThan(0);
  await expect(
    f.pool.query("UPDATE billing_audit SET action='tampered'"),
  ).rejects.toThrow();
});
test('usage is opt-in per account and private event fields are rejected', async () => {
  const { user } = await paidUser(),
    h = await handoff(user),
    exchange = await h.native.json(
      '/api/desktop-auth/exchange',
      'POST',
      h.input,
    );
  const value = {
    deviceId: exchange.data.deviceId,
    events: [
      {
        eventId: randomUUID(),
        schemaVersion: 1,
        event: 'terminal.started',
        occurredAt: new Date().toISOString(),
        properties: {},
      },
    ],
  };
  expect(
    (await h.native.json('/api/v1/activity/events', 'POST', value)).status,
  ).toBe(403);
  expect(
    (await h.native.json('/api/v1/me/preferences', 'PUT', { shareUsage: true }))
      .status,
  ).toBe(200);
  expect(
    (await h.native.json('/api/v1/activity/events', 'POST', value)).status,
  ).toBe(200);
  expect(
    (
      await h.native.json('/api/v1/activity/events', 'POST', {
        ...value,
        events: [{ ...value.events[0], properties: { prompt: 'private' } }],
      })
    ).status,
  ).toBe(400);
});

test('prepared middleware forwards renewed cookies instead of consuming renewal silently', async () => {
  const { user } = await paidUser(),
    h = await handoff(user),
    reply = await h.native.json('/api/desktop-auth/exchange', 'POST', h.input);
  await f.pool.query(
    `UPDATE session SET "updatedAt"=now()-interval '2 days',"expiresAt"=now()+interval '4 days' WHERE id=$1`,
    [reply.data.sessionId],
  );
  const response = await h.native.request('/api/v1/me');
  expect(response.status).toBe(200);
  expect(
    response.headers
      .getSetCookie()
      .some((c) => c.startsWith('better-auth.session_token=')),
  ).toBe(true);
});
test('revoking a native session blocks later entitlement issuance', async () => {
  const { user } = await paidUser(),
    h = await handoff(user),
    reply = await h.native.json('/api/desktop-auth/exchange', 'POST', h.input);
  expect(
    (await user.json('/api/v1/me/sessions/' + reply.data.sessionId, 'DELETE'))
      .status,
  ).toBe(200);
  expect(
    (await h.native.json('/api/v1/me/entitlement', 'POST', {})).status,
  ).toBe(401);
});
test('MFA evidence is required for approval, and expired MFA browser sessions cannot authorize', async () => {
  const browser = await new Client(f).signup();
  await browser.mfa();
  const h = await handoff(browser);
  await f.pool.query(
    'DELETE FROM session_factors WHERE session_id=(SELECT browser_session_id FROM desktop_handoffs WHERE id=$1)',
    [h.start.attemptId],
  );
  expect(
    (await h.native.json('/api/desktop-auth/exchange', 'POST', h.input)).status,
  ).toBe(401);
});
test('worker sweep repairs a missed webhook and metrics remain bearer protected', async () => {
  const { user, customer } = await paidUser(),
    old = stripe.snapshots.get(customer)!;
  stripe.snapshots.set(customer, { ...old, fullyRefunded: true });
  await f.pool.query(
    "UPDATE billing_accounts SET updated_at=now()-interval '10 minutes' WHERE user_id=$1",
    [user.id],
  );
  const worker = createPreparedJobs(
    f.jobsPool,
    createBilling(f.jobsPool, stripe.transport, f.config.PUBLIC_URL),
  );
  const result = await worker.tick();
  expect((result.reconciled || 0) > 0).toBe(true);
  expect((await accessFor(f.pool, user.id)).allowed).toBe(false);
  expect((await service.app.request('/internal/metrics')).status).toBe(401);
  const response = await service.app.request('/internal/metrics', {
    headers: { authorization: 'Bearer ' + f.config.METRICS_TOKEN },
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('lina_billing_pending');
});
