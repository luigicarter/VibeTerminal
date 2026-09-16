'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const {
  createSessionStore,
} = require('../../backend/account-prepared/session-store.cjs');
const {
  createAccessPolicy,
} = require('../../backend/account-prepared/access.cjs');
const {
  createRuntimeGuards,
  operationFor,
} = require('../../backend/account-prepared/runtime-guards.cjs');
const {
  createAccountTransport,
} = require('../../backend/account-prepared/transport.cjs');
const { createLoginFlow } = require('../../backend/account-prepared/login.cjs');
const { installAccountIpc } = require('../../backend/account-prepared/ipc.cjs');
const {
  createAccountController,
} = require('../../backend/account-prepared/controller.cjs');
const {
  createAccountActivity,
} = require('../../backend/account-prepared/activity.cjs');
const keys = crypto.generateKeyPairSync('ed25519'),
  issuer = 'https://accounts.example.test';
const owner = {
    userId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    deviceId: crypto.randomUUID(),
  },
  stamp = Date.now();
function token(overrides = {}) {
  const h = Buffer.from(
      JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: 'test' }),
    ).toString('base64url'),
    p = Buffer.from(
      JSON.stringify({
        iss: issuer,
        aud: 'lina-desktop',
        sub: owner.userId,
        sid: owner.sessionId,
        device: owner.deviceId,
        tier: 'orchestrator',
        features: [
          'terminals',
          'agent_modes',
          'fusion',
          'open_fusion',
          'orchestrator',
          'voice',
          'workspace',
          'git',
          'provider_settings',
        ],
        revision: 1,
        iat: Math.floor(stamp / 1000),
        exp: Math.floor(stamp / 1000) + 86400,
        ...overrides,
      }),
    ).toString('base64url');
  const input = h + '.' + p;
  return (
    input +
    '.' +
    crypto.sign(null, Buffer.from(input), keys.privateKey).toString('base64url')
  );
}
const policy = (extra = {}) =>
  createAccessPolicy({
    issuer,
    publicKeys: {
      test: keys.publicKey.export({ format: 'pem', type: 'spki' }),
    },
    now: () => stamp,
    monotonic: () => 0,
    ...extra,
  });
test('leases require authentic signatures, correct identity, tier and bounded lifetime', () => {
  for (const changes of [
    { sub: crypto.randomUUID() },
    { sid: crypto.randomUUID() },
    { device: crypto.randomUUID() },
    { aud: 'web' },
    { iss: 'https://evil.test' },
    { exp: Math.floor(stamp / 1000) + 86401 },
    { iat: Math.floor(stamp / 1000) + 100 },
    { exp: Math.floor(stamp / 1000) - 1 },
    { tier: 'full_access', features: ['orchestrator'] },
  ])
    assert.throws(() => policy().accept(token(changes), owner));
  const p = policy();
  p.accept(token(), { ...owner, cookie: 'SECRET' });
  assert.doesNotMatch(JSON.stringify(p.snapshot()), /SECRET|cookie/);
  p.assert('orchestrator.start');
  assert.throws(() => p.accept(token().slice(0, -5) + 'AAAAA', owner));
  assert.throws(() => p.assert('terminal.launch'));
});
test('all prepared runtime operations check entitlement and safe controls remain available', () => {
  const p = policy(),
    guards = createRuntimeGuards(p);
  let calls = 0;
  for (const [channel, action] of Object.entries(operationFor)) {
    if (['view', 'copy', 'export', 'stop', 'resize'].includes(action))
      guards.invoke(channel, () => calls++);
    else assert.throws(() => guards.invoke(channel, () => calls++));
  }
  p.accept(token(), owner);
  for (const channel of Object.keys(operationFor))
    guards.invoke(channel, () => calls++);
  assert(calls > Object.keys(operationFor).length);
  assert.throws(() => guards.invoke('unknown:operation', () => {}));
});
test('queued work rechecks denial, expiry, account changes and feature downgrade', async () => {
  let time = stamp;
  const p = policy({ now: () => time }),
    guards = createRuntimeGuards(p);
  p.accept(token(), owner);
  const run = guards.queue('terminal:create', () => 42);
  p.accept(token({ exp: Math.floor(stamp / 1000) + 3600 }), owner);
  assert.equal(await run(), 42);
  const blocked = guards.queue('terminal:create', () => 42);
  p.clear('account_suspended');
  await assert.rejects(blocked);
  p.accept(token(), owner);
  const expire = guards.queue('terminal:input', () => 42);
  time += 86400001;
  await assert.rejects(expire);
  assert.doesNotThrow(() => p.assert('stop'));
});
test('clock rollback and persisted time rollback require online recovery', () => {
  let time = stamp,
    mono = 0;
  const p = policy({ now: () => time, monotonic: () => mono });
  p.accept(token(), owner);
  mono = 20000;
  time += 1000;
  assert.throws(() => p.assert('terminal.input'), /clock_changed/);
  assert.throws(
    () => policy().accept(token(), owner, stamp + 60000),
    /clock_changed/,
  );
});
test('session store uses encryption, refuses plaintext fallback, handles corruption and clears disk', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lina-account-store-')),
    file = path.join(dir, 'session');
  const key = crypto.randomBytes(32),
    storage = {
      isEncryptionAvailable: () => true,
      encryptString(value) {
        const iv = crypto.randomBytes(12),
          c = crypto.createCipheriv('aes-256-gcm', key, iv),
          encrypted = Buffer.concat([c.update(value), c.final()]);
        return Buffer.concat([iv, c.getAuthTag(), encrypted]);
      },
      decryptString(value) {
        const d = crypto.createDecipheriv(
          'aes-256-gcm',
          key,
          value.subarray(0, 12),
        );
        d.setAuthTag(value.subarray(12, 28));
        return Buffer.concat([
          d.update(value.subarray(28)),
          d.final(),
        ]).toString();
      },
    };
  const record = {
    version: 1,
    cookie: '__Secure-better-auth.session_token=synthetic_secret',
    ...owner,
  };
  try {
    const store = createSessionStore({ file, secureStorage: storage });
    await store.save(record);
    assert(
      !(await fs.readFile(file)).includes(Buffer.from('synthetic_secret')),
    );
    assert.deepEqual(
      await createSessionStore({ file, secureStorage: storage }).load(),
      record,
    );
    await fs.writeFile(file, 'corrupt');
    await assert.rejects(
      createSessionStore({ file, secureStorage: storage }).load(),
      /unreadable/,
    );
    await store.clear();
    await assert.rejects(fs.access(file));
    const memory = createSessionStore({
      file,
      secureStorage: {
        ...storage,
        getSelectedStorageBackend: () => 'basic_text',
      },
      platform: 'linux',
    });
    assert.equal(memory.mode(), 'memory-only');
    await memory.save(record);
    await assert.rejects(fs.access(file));
    assert.deepEqual(await memory.load(), record);
    await memory.clear();
    assert.equal(await memory.load(), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test('native transport restricts destinations, operations, redirects and exposed error messages', async () => {
  let sent;
  const transport = createAccountTransport({
    origin: issuer,
    fetch: async (url, options) => {
      sent = { url, options };
      return Response.json(
        { error: { code: 'safe_failure', message: 'secret upstream' } },
        { status: 403 },
      );
    },
  });
  transport.setCookie('__Secure-better-auth.session_token=synthetic');
  await assert.rejects(
    transport.request('GET', '/api/v1/me'),
    (error) =>
      error.code === 'safe_failure' && !error.message.includes('secret'),
  );
  assert.equal(sent.options.redirect, 'error');
  assert.equal(
    sent.options.headers.Cookie,
    '__Secure-better-auth.session_token=synthetic',
  );
  await assert.rejects(transport.request('GET', '/api/v1/admin/users'));
  assert.throws(() => transport.setCookie('bad\r\nCookie:leak'));
  assert.throws(() =>
    createAccountTransport({
      origin: 'http://evil.test',
      fetch: async () => {},
    }),
  );
});
test('IPC accepts only the intended main frame and strict narrow payloads', async () => {
  const handlers = new Map(),
    frame = { url: 'file:///fixture.html' },
    contents = { mainFrame: frame },
    window = { webContents: contents, isDestroyed: () => false },
    seen = [];
  const controller = {
    snapshot: () => ({ signedIn: true }),
    setUsage: (value) => seen.push(value),
  };
  const dispose = installAccountIpc({
    ipcMain: {
      handle: (k, v) => handlers.set(k, v),
      removeHandler: (k) => handlers.delete(k),
    },
    controller,
    getWindow: () => window,
    trustedRendererUrl: frame.url,
  });
  const allowed = { sender: contents, senderFrame: frame };
  assert.deepEqual(await handlers.get('account-prepared:status')(allowed), {
    signedIn: true,
  });
  await assert.rejects(
    handlers.get('account-prepared:status')({
      sender: contents,
      senderFrame: {},
    }),
    /forbidden/,
  );
  await assert.rejects(
    handlers.get('account-prepared:usage')(allowed, {
      enabled: true,
      userId: 'other',
    }),
    /invalid/,
  );
  await handlers.get('account-prepared:usage')(allowed, { enabled: false });
  assert.deepEqual(seen, [false]);
  dispose();
  assert.equal(handlers.size, 0);
});
test('real loopback callback binds state and exchanges once, with no custom protocol registration', async () => {
  let start,
    exchanges = 0,
    complete;
  const finished = new Promise((r) => (complete = r)),
    id = crypto.randomUUID(),
    code = crypto.randomBytes(32).toString('base64url');
  const transport = {
    origin: issuer,
    clear() {},
    async request(method, path, value) {
      if (path.endsWith('/start')) {
        start = value;
        return {
          attemptId: id,
          cancelSecret: code,
          authorizationUrl:
            issuer + '/account/desktop-authorization?attempt=' + id,
        };
      }
      if (path.endsWith('/exchange')) {
        exchanges++;
        assert.equal(
          crypto
            .createHash('sha256')
            .update(value.verifier)
            .digest('base64url'),
          start.challenge,
        );
        return owner;
      }
      return { ok: true };
    },
  };
  const flow = createLoginFlow({
    transport,
    openBrowser: async () => {},
    installationId: crypto.randomUUID(),
    platform: 'windows',
    appVersion: '0.1.123',
    onSession: async () => complete(),
  });
  try {
    await flow.start();
    let callback = new URL(start.callback);
    callback.search = new URLSearchParams({
      attempt: id,
      code,
      state: 'wrong',
    });
    assert.equal((await fetch(callback)).status, 400);
    assert.equal(exchanges, 0);
    callback.search = new URLSearchParams({
      attempt: id,
      code,
      state: start.state,
    });
    assert.equal((await fetch(callback)).status, 200);
    await finished;
    assert.equal(exchanges, 1);
    await assert.rejects(async () => flow.submitCode(code));
  } finally {
    await flow.cancel();
  }
});
test('logout clears offline credentials during server outage and startup performs no automatic timers', async () => {
  let saved = {
      version: 1,
      cookie: '__Secure-better-auth.session_token=synthetic',
      ...owner,
      entitlement: token(),
      observedTime: stamp,
    },
    clear = 0,
    cookie = '';
  const transport = {
    origin: issuer,
    setCookie: (v) => (cookie = v),
    cookie: () => cookie,
    clear: () => (cookie = ''),
    async request() {
      throw Object.assign(Error('connection_unavailable'), {
        code: 'connection_unavailable',
      });
    },
  };
  const controller = createAccountController({
    transport,
    store: {
      load: async () => saved,
      save: async (v) => (saved = v),
      clear: async () => {
        clear++;
        saved = null;
      },
      mode: () => 'encrypted',
    },
    policy: policy(),
    openBrowser: async () => {},
    installationId: crypto.randomUUID(),
    platform: 'windows',
    appVersion: '0.1.123',
    now: () => stamp,
  });
  assert.equal(clear, 0);
  await controller.initialize();
  assert.equal(controller.snapshot().access.allowed, true);
  const result = await controller.logout();
  assert.equal(result.serverRevoked, false);
  assert.equal(result.signedIn, false);
  assert.equal(result.access.allowed, false);
  assert.equal(saved, null);
  assert.equal(cookie, '');
  await controller.dispose();
});
test('activity is inert by default and refuses private fields before transport', async () => {
  let calls = 0;
  const activity = createAccountActivity({
    transport: { request: async () => calls++ },
    getDeviceId: () => owner.deviceId,
    isAllowed: () => true,
  });
  await activity.heartbeat();
  await activity.events([{ prompt: 'secret' }]);
  assert.equal(calls, 0);
  activity.setUsage(true);
  await activity.events([{ prompt: 'secret' }]);
  assert.equal(calls, 0);
});

test('late responses cannot restore credentials after sign-out or account switching', async () => {
  let finish;
  const transport = createAccountTransport({
    origin: issuer,
    fetch: () => new Promise((r) => (finish = r)),
  });
  transport.setCookie('__Secure-better-auth.session_token=old');
  const request = transport.request('GET', '/api/v1/me');
  transport.clear();
  finish(
    Response.json(
      { user: {} },
      {
        headers: {
          'Set-Cookie':
            '__Secure-better-auth.session_token=oldrenewed; HttpOnly; Secure',
        },
      },
    ),
  );
  await assert.rejects(request, (error) => error.code === 'request_cancelled');
  assert.equal(transport.cookie(), '');
});
test('trusted frame navigation cannot retain IPC access and stopping voice remains available', async () => {
  const handlers = new Map(),
    frame = { url: 'file:///account.html' },
    contents = { mainFrame: frame },
    window = { webContents: contents, isDestroyed: () => false };
  installAccountIpc({
    ipcMain: { handle: (k, v) => handlers.set(k, v) },
    controller: { snapshot: () => ({}) },
    getWindow: () => window,
    trustedRendererUrl: frame.url,
  });
  frame.url = 'https://evil.example';
  await assert.rejects(
    handlers.get('account-prepared:status')({
      sender: contents,
      senderFrame: frame,
    }),
    /forbidden/,
  );
  const guards = createRuntimeGuards(policy());
  assert.doesNotThrow(() =>
    guards.invoke('voice:listening', () => {}, { enabled: false }),
  );
  assert.throws(() =>
    guards.invoke('voice:listening', () => {}, { enabled: true }),
  );
});

test('installation identity is stable across competing initialization and preserves corrupt files', async () => {
  const {
    createInstallationStore,
  } = require('../../backend/account-prepared/installation.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lina-installation-')),
    file = path.join(dir, 'id');
  try {
    const stores = [
      createInstallationStore(file),
      createInstallationStore(file),
    ];
    const ids = await Promise.all(stores.map((s) => s.loadOrCreate()));
    assert.equal(ids[0], ids[1]);
    assert.equal(await createInstallationStore(file).loadOrCreate(), ids[0]);
    await fs.writeFile(file, 'corrupt');
    await assert.rejects(stores[0].loadOrCreate(), /invalid/);
    assert.equal(await fs.readFile(file, 'utf8'), 'corrupt');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('failure after code exchange closes the attempt and exposes a safe recoverable state', async () => {
  const id = crypto.randomUUID(),
    code = crypto.randomBytes(32).toString('base64url');
  const flow = createLoginFlow({
    transport: {
      origin: issuer,
      clear() {},
      async request(method, route) {
        return route.endsWith('/start')
          ? {
              attemptId: id,
              cancelSecret: code,
              authorizationUrl:
                issuer + '/account/desktop-authorization?attempt=' + id,
            }
          : owner;
      },
    },
    openBrowser: async () => {},
    installationId: crypto.randomUUID(),
    platform: 'windows',
    appVersion: '0.1.123',
    onSession: async () => {
      throw Error('account_store_write_failed');
    },
  });
  try {
    await flow.start();
    await assert.rejects(flow.submitCode(code), /account_store_write_failed/);
    assert.equal(flow.waiting(), false);
    assert.equal(flow.error(), 'account_store_write_failed');
  } finally {
    await flow.cancel();
  }
});
