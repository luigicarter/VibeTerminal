import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAccountClient,
  AccountError,
} from '../frontend/src/account-prepared/client.ts';
import {
  createAuthController,
  createAdminController,
  createBillingController,
  createDesktopApprovalController,
} from '../frontend/src/account-prepared/controllers.ts';
const origin = 'https://accounts.example.test';
test('web transport preserves HTTP-only cookie handling and has no storage or caller-supplied destination', async () => {
  const requests = [];
  const client = createAccountClient({
    origin,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return Response.json({});
    },
  });
  assert.equal(requests.length, 0);
  await client.login('example@example.test', 'synthetic-password');
  assert.equal(requests[0].options.credentials, 'include');
  assert.equal(requests[0].options.redirect, 'error');
  assert(!('Cookie' in requests[0].options.headers));
  await client.recover('example@example.test');
  assert.equal(
    JSON.parse(requests[1].options.body).redirectTo,
    origin + '/account/reset',
  );
  assert.throws(() =>
    createAccountClient({ origin: 'http://evil.test', fetch: async () => {} }),
  );
});
test('auth controllers discard stale replies and retain no passwords in snapshots', async () => {
  let release;
  const client = {
    login: () => new Promise((r) => (release = r)),
    me: async () => ({
      user: { id: 'test' },
      access: { allowed: true, accountStatus: 'active' },
    }),
  };
  const controller = createAuthController(client);
  const pending = controller.submit({
    email: 'fixture@example.test',
    password: 'synthetic-secret',
  });
  controller.navigate('forgot');
  release({});
  await pending;
  assert.equal(controller.snapshot().screen, 'forgot');
  assert.doesNotMatch(
    JSON.stringify(controller.snapshot()),
    /synthetic-secret|fixture@example/,
  );
});
test('server error text is never reflected and MFA is a distinct state', async () => {
  const client = createAccountClient({
    origin,
    fetch: async () =>
      Response.json(
        { error: { code: 'login_failed', message: 'private-secret' } },
        { status: 401 },
      ),
  });
  const controller = createAuthController(client);
  await controller.submit({
    email: 'fixture@example.test',
    password: 'secret',
  });
  assert.equal(controller.snapshot().error, 'login_failed');
  assert.doesNotMatch(JSON.stringify(controller.snapshot()), /private-secret/);
  const mfa = createAuthController({
    login: async () => ({ twoFactorRedirect: true }),
  });
  await mfa.submit({ email: 'a', password: 'b' });
  assert.equal(mfa.snapshot().screen, 'mfa');
});
test('admin actions translate to privileged API shapes with revision and preserve draft failures', async () => {
  const calls = [],
    userId = '11111111-1111-4111-8111-111111111111';
  const client = createAccountClient({
    origin,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return Response.json(
        { error: { code: 'revision_conflict' } },
        { status: 409 },
      );
    },
  });
  const controller = createAdminController(client),
    change = {
      userId,
      action: 'suspend',
      expectedRevision: 7,
      reason: 'Account review',
    };
  const before = structuredClone(change);
  assert.equal(await controller.change(change), false);
  assert.deepEqual(change, before);
  assert.equal(controller.snapshot().error, 'revision_conflict');
  assert.equal(
    calls[0].url,
    origin + '/api/v1/admin/users/' + userId + '/status',
  );
  assert.equal(calls[0].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    expectedRevision: 7,
    reason: 'Account review',
    status: 'suspended',
  });
});
test('billing navigation refuses attacker URLs and duplicate checkout clicks', async () => {
  let release;
  const navigations = [],
    controller = createBillingController(
      { checkout: () => new Promise((r) => (release = r)) },
      (url) => navigations.push(url),
    );
  const pending = controller.checkout('full_access', 'month');
  await assert.rejects(
    controller.checkout('full_access', 'month'),
    /billing_in_progress/,
  );
  release({ url: 'https://evil.test/checkout' });
  await assert.rejects(pending, /billing_url_invalid/);
  assert.equal(navigations.length, 0);
  const good = createBillingController(
    {
      portal: async () => ({
        url: 'https://billing.stripe.com/p/session/test',
      }),
    },
    (url) => navigations.push(url),
  );
  await good.portal();
  assert.equal(navigations.length, 1);
});
test('desktop approval requires explicit action and a validated loopback callback', async () => {
  let called = 0;
  const id = '11111111-1111-4111-8111-111111111111';
  const controller = createDesktopApprovalController(
    {
      desktopAttempt: async () => ({ platform: 'windows' }),
      approveDesktop: async () => {
        called++;
        return { callbackUrl: 'https://evil.test/', code: 'x', state: 'y' };
      },
    },
    () => assert.fail('must not navigate'),
  );
  await controller.inspect(id);
  assert.equal(called, 0);
  await assert.rejects(controller.approve(id), /callback_invalid/);
  assert.equal(called, 1);
});
