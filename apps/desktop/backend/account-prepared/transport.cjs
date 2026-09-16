'use strict';
class AccountError extends Error {
  constructor(code, status = 0) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
function createAccountTransport({
  origin,
  fetch: fetcher,
  allowLoopback = false,
}) {
  const base = new URL(origin);
  if (
    base.href !== base.origin + '/' ||
    base.username ||
    base.password ||
    (base.protocol !== 'https:' &&
      !(
        allowLoopback &&
        base.protocol === 'http:' &&
        base.hostname === '127.0.0.1'
      )) ||
    typeof fetcher !== 'function'
  )
    throw Error('account_origin_invalid');
  let cookie = '',
    credentialEpoch = 0;
  const sessionName =
    base.protocol === 'https:'
      ? '__Secure-better-auth.session_token'
      : 'better-auth.session_token';
  function validateCookie(value) {
    if (
      (value && !value.startsWith(sessionName + '=')) ||
      /[\r\n;]/.test(value) ||
      value.length > 4096
    )
      throw Error('session_cookie_invalid');
  }
  function setCookie(value) {
    validateCookie(value);
    cookie = value;
    credentialEpoch++;
  }
  const allowed = (method, path) =>
    (method === 'POST' &&
      [
        '/api/desktop-auth/start',
        '/api/desktop-auth/cancel',
        '/api/desktop-auth/exchange',
        '/api/auth/sign-out',
        '/api/v1/me/entitlement',
        '/api/v1/billing/checkout',
        '/api/v1/billing/portal',
        '/api/v1/activity/heartbeat',
        '/api/v1/activity/events',
      ].includes(path)) ||
    (method === 'GET' &&
      [
        '/api/v1/me',
        '/api/v1/me/access',
        '/api/v1/me/sessions',
        '/api/v1/me/preferences',
        '/api/v1/billing',
      ].includes(path)) ||
    (method === 'PUT' && path === '/api/v1/me/preferences') ||
    (method === 'DELETE' &&
      /^\/api\/v1\/me\/sessions\/[0-9a-f-]{36}$/.test(path));
  async function request(method, path, value, signal) {
    if (!allowed(method, path)) throw new AccountError('operation_not_allowed');
    const requestEpoch = credentialEpoch;
    let response;
    try {
      response = await fetcher(base.origin + path, {
        method,
        redirect: 'error',
        credentials: 'omit',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
          : AbortSignal.timeout(10000),
        headers: {
          Origin: base.origin,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(value === undefined
            ? {}
            : { 'Content-Type': 'application/json' }),
        },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      });
    } catch {
      throw new AccountError(
        signal?.aborted ? 'request_cancelled' : 'connection_unavailable',
      );
    }
    if (response.url && new URL(response.url).origin !== base.origin)
      throw new AccountError('response_origin_invalid');
    if (
      signal?.aborted ||
      (requestEpoch !== credentialEpoch && path !== '/api/auth/sign-out')
    )
      throw new AccountError('request_cancelled');
    for (const line of path === '/api/auth/sign-out'
      ? []
      : response.headers.getSetCookie?.() || []) {
      const pair = line.split(';')[0];
      if (pair.startsWith(sessionName + '=')) {
        const value = pair.endsWith('=') ? '' : pair;
        validateCookie(value);
        cookie = value;
      }
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new AccountError('response_invalid', response.status);
    }
    if (!response.ok) {
      const code = /^[a-z_]{1,80}$/.test(data?.error?.code)
        ? data.error.code
        : 'account_request_failed';
      throw new AccountError(code, response.status);
    }
    return data;
  }
  return {
    request,
    setCookie,
    cookie: () => cookie,
    clear: () => {
      cookie = '';
      credentialEpoch++;
    },
    origin: base.origin,
  };
}
module.exports = { createAccountTransport, AccountError };
