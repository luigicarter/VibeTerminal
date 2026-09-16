'use strict';
const { createLoginFlow } = require('./login.cjs');
function createAccountController({
  transport,
  store,
  policy,
  openBrowser,
  installationId,
  platform,
  appVersion,
  now = Date.now,
}) {
  let record = null,
    account = null,
    timer = null,
    generation = 0,
    error = null,
    refreshing = null;
  function snapshot() {
    return {
      signedIn: !!record,
      waiting: login.waiting(),
      account: account
        ? {
            name: account.user.name,
            email: account.user.email,
            verified: account.user.emailVerified,
            access: account.access,
          }
        : null,
      access: policy.snapshot(),
      persistence: store.mode(),
      error: login.error() || error,
    };
  }
  async function persist() {
    if (record)
      await store.save({
        ...record,
        observedTime: policy.snapshot().highWater,
      });
  }
  async function refresh() {
    if (!record) return snapshot();
    if (refreshing?.generation === generation) return refreshing.promise;
    const version = generation;
    const promise = (async () => {
      try {
        const me = await transport.request('GET', '/api/v1/me');
        if (version !== generation) return snapshot();
        account = me;
        if (!me.access.allowed) {
          policy.clear(me.access.reason);
          record.entitlement = null;
          await persist();
          return snapshot();
        }
        const reply = await transport.request(
          'POST',
          '/api/v1/me/entitlement',
          {},
        );
        if (version !== generation) return snapshot();
        policy.accept(reply.entitlement, record, record.observedTime || 0);
        record.entitlement = reply.entitlement;
        record.cookie = transport.cookie();
        error = null;
        await persist();
      } catch (cause) {
        if (version !== generation) return snapshot();
        error = cause.code || 'account_unavailable';
        if (cause.status === 401 || cause.status === 403) {
          policy.clear(error);
          record.entitlement = null;
          if (cause.status === 401) {
            record = null;
            account = null;
            transport.clear();
            generation++;
            await store.clear();
          } else await persist();
        } else if (
          cause.code !== 'connection_unavailable' &&
          !(cause.status === 503 && cause.code === 'service_unavailable')
        ) {
          policy.clear(error);
          record.entitlement = null;
          await persist();
        }
      }
      return snapshot();
    })();
    refreshing = { generation: version, promise };
    try {
      return await promise;
    } finally {
      if (refreshing?.promise === promise) refreshing = null;
    }
  }
  const login = createLoginFlow({
    transport,
    openBrowser,
    installationId,
    platform,
    appVersion,
    onSession: async (result) => {
      generation++;
      policy.clear('login_refresh_required');
      account = null;
      record = {
        version: 1,
        cookie: transport.cookie(),
        userId: result.userId,
        sessionId: result.sessionId,
        deviceId: result.deviceId,
        entitlement: null,
        observedTime: now(),
      };
      await persist();
      await refresh();
    },
  });
  async function initialize() {
    try {
      record = await store.load();
      if (record) {
        transport.setCookie(record.cookie);
        if (record.entitlement) {
          try {
            policy.accept(record.entitlement, record, record.observedTime || 0);
          } catch {
            record.entitlement = null;
          }
        }
        await refresh();
      }
    } catch {
      policy.clear('account_store_unreadable');
      error = 'account_store_unreadable';
      record = null;
      transport.clear();
    }
    return snapshot();
  }
  async function logout() {
    generation++;
    policy.clear('signed_out');
    account = null;
    error = null;
    await login.cancel();
    const revocation = transport.request('POST', '/api/auth/sign-out', {}).then(
      () => true,
      () => false,
    );
    record = null;
    try {
      await store.clear();
    } finally {
      transport.clear();
    }
    const revoked = await revocation;
    if (!revoked) error = 'server_revocation_unconfirmed';
    return { ...snapshot(), serverRevoked: revoked };
  }
  async function beginLogin() {
    await logout();
    return login.start();
  }
  async function billing(kind, input) {
    const reply = await transport.request(
      'POST',
      kind === 'checkout'
        ? '/api/v1/billing/checkout'
        : '/api/v1/billing/portal',
      input || {},
    );
    const url = new URL(reply.url),
      host = kind === 'checkout' ? 'checkout.stripe.com' : 'billing.stripe.com';
    if (
      url.protocol !== 'https:' ||
      url.hostname !== host ||
      url.port ||
      url.username ||
      url.password
    )
      throw Error('billing_url_invalid');
    await openBrowser(url.href);
    return { opened: true };
  }
  return {
    initialize,
    snapshot,
    refresh,
    startLogin: beginLogin,
    cancelLogin: login.cancel,
    submitCode: login.submitCode,
    logout,
    sessions: () => transport.request('GET', '/api/v1/me/sessions'),
    revokeSession: async (id) => {
      await transport.request('DELETE', '/api/v1/me/sessions/' + id);
      if (record?.sessionId === id) await logout();
      return { ok: true };
    },
    preferences: () => transport.request('GET', '/api/v1/me/preferences'),
    setUsage: (shareUsage) =>
      transport.request('PUT', '/api/v1/me/preferences', { shareUsage }),
    billingStatus: () => transport.request('GET', '/api/v1/billing'),
    checkout: (input) => billing('checkout', input),
    portal: () => billing('portal'),
    startRefresh() {
      if (!timer) {
        timer = setInterval(() => void refresh().catch(() => {}), 300000);
        timer.unref();
      }
    },
    async dispose() {
      if (timer) clearInterval(timer);
      timer = null;
      generation++;
      await login.cancel();
    },
  };
}
module.exports = { createAccountController };
