import type { Tier, AccountStatus } from '../account/types';
import type { Change } from '../admin/model';

export interface Access {
  allowed: boolean;
  reason: string | null;
  tier: Tier | null;
  features: string[];
  expiresAt: string | null;
  revision: number;
  accountStatus: AccountStatus;
  serverTime: string;
}
export interface Me {
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    role: 'member' | 'admin' | 'owner';
    twoFactorEnabled: boolean;
  };
  access: Access;
}
export interface LoginResult {
  twoFactorRedirect?: boolean;
  user?: Me['user'];
}
export interface Session {
  id: string;
  created_at: string;
  expires_at: string;
  device_id: string | null;
  platform: string | null;
  app_version: string | null;
  last_seen_at: string | null;
  recently_seen: boolean | null;
}
export class AccountError extends Error {
  constructor(
    public code: string,
    public status = 0,
  ) {
    super(code);
  }
}
const identifier = (value: string) => {
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new AccountError('invalid_id');
  return value;
};
// Explicit injected fetch/origin: constructing/importing this client does nothing.
export function createAccountClient(options: {
  origin: string;
  fetch: typeof fetch;
  allowLoopback?: boolean;
}) {
  const origin = new URL(options.origin);
  if (
    origin.href !== origin.origin + '/' ||
    origin.username ||
    origin.password ||
    (origin.protocol !== 'https:' &&
      !(
        options.allowLoopback &&
        origin.protocol === 'http:' &&
        origin.hostname === '127.0.0.1'
      ))
  )
    throw new AccountError('origin_invalid');
  async function request<T>(
    method: string,
    path: string,
    value?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;
    try {
      response = await options.fetch(origin.origin + path, {
        method,
        credentials: 'include',
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
          : AbortSignal.timeout(10000),
        headers:
          value === undefined ? {} : { 'Content-Type': 'application/json' },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      });
    } catch {
      throw new AccountError(
        signal?.aborted ? 'request_cancelled' : 'connection_unavailable',
      );
    }
    if (response.url && new URL(response.url).origin !== origin.origin)
      throw new AccountError('response_origin_invalid');
    let body;
    try {
      body = await response.json();
    } catch {
      throw new AccountError('response_invalid', response.status);
    }
    if (!response.ok)
      throw new AccountError(
        /^[a-z_]{1,80}$/.test(body?.error?.code)
          ? body.error.code
          : 'account_request_failed',
        response.status,
      );
    return body as T;
  }
  const auth = <T = unknown>(
    path: string,
    value: unknown,
    signal?: AbortSignal,
  ) => request<T>('POST', '/api/auth/' + path, value, signal);
  return {
    login: (email: string, password: string, signal?: AbortSignal) =>
      auth<LoginResult>('sign-in/email', { email, password }, signal),
    signup: (
      name: string,
      email: string,
      password: string,
      signal?: AbortSignal,
    ) => auth<LoginResult>('sign-up/email', { name, email, password }, signal),
    resend: (email: string, signal?: AbortSignal) =>
      auth('send-verification-email', { email }, signal),
    recover: (email: string, signal?: AbortSignal) =>
      auth(
        'request-password-reset',
        { email, redirectTo: origin.origin + '/account/reset' },
        signal,
      ),
    reset: (token: string, newPassword: string, signal?: AbortSignal) =>
      auth('reset-password', { token, newPassword }, signal),
    verifyMfa: (code: string, backup = false, signal?: AbortSignal) =>
      auth(
        backup ? 'two-factor/verify-backup-code' : 'two-factor/verify-totp',
        { code },
        signal,
      ),
    enableMfa: (password: string, signal?: AbortSignal) =>
      auth<{ totpURI: string; backupCodes: string[] }>(
        'two-factor/enable',
        { password },
        signal,
      ),
    disableMfa: (password: string, signal?: AbortSignal) =>
      auth('two-factor/disable', { password }, signal),
    regenerateBackupCodes: (password: string, signal?: AbortSignal) =>
      auth<{ backupCodes: string[] }>(
        'two-factor/generate-backup-codes',
        { password },
        signal,
      ),
    changePassword: (
      currentPassword: string,
      newPassword: string,
      signal?: AbortSignal,
    ) =>
      auth(
        'change-password',
        { currentPassword, newPassword, revokeOtherSessions: true },
        signal,
      ),
    logout: (signal?: AbortSignal) => auth('sign-out', {}, signal),
    me: (signal?: AbortSignal) =>
      request<Me>('GET', '/api/v1/me', undefined, signal),
    sessions: (signal?: AbortSignal) =>
      request<{ sessions: Session[] }>(
        'GET',
        '/api/v1/me/sessions',
        undefined,
        signal,
      ),
    revoke: (id: string, signal?: AbortSignal) =>
      request(
        'DELETE',
        '/api/v1/me/sessions/' + identifier(id),
        undefined,
        signal,
      ),
    preferences: (signal?: AbortSignal) =>
      request<{ shareUsage: boolean }>(
        'GET',
        '/api/v1/me/preferences',
        undefined,
        signal,
      ),
    setUsage: (shareUsage: boolean, signal?: AbortSignal) =>
      request<{ shareUsage: boolean }>(
        'PUT',
        '/api/v1/me/preferences',
        { shareUsage },
        signal,
      ),
    billing: (signal?: AbortSignal) =>
      request<{
        configured: boolean;
        status: string;
        paidThrough: string | null;
        cancelAtPeriodEnd: boolean;
      }>('GET', '/api/v1/billing', undefined, signal),
    checkout: (tier: Tier, interval: 'month' | 'year', signal?: AbortSignal) =>
      request<{ url: string }>(
        'POST',
        '/api/v1/billing/checkout',
        { tier, interval },
        signal,
      ),
    portal: (signal?: AbortSignal) =>
      request<{ url: string }>('POST', '/api/v1/billing/portal', {}, signal),
    desktopAttempt: (id: string, signal?: AbortSignal) =>
      request<{ platform: string; appVersion: string; expiresAt: string }>(
        'GET',
        '/api/desktop-auth/attempts/' + identifier(id),
        undefined,
        signal,
      ),
    approveDesktop: (attemptId: string, signal?: AbortSignal) =>
      request<{
        callbackUrl: string;
        code: string;
        state: string;
        attemptId: string;
        expiresIn: number;
      }>(
        'POST',
        '/api/desktop-auth/approve',
        { attemptId: identifier(attemptId) },
        signal,
      ),
    adminUsers: (
      filters: {
        search?: string;
        status?: AccountStatus;
        tier?: Tier;
        limit?: number;
        offset?: number;
      } = {},
      signal?: AbortSignal,
    ) =>
      request<{
        users: Record<string, unknown>[];
        limit: number;
        offset: number;
      }>(
        'GET',
        '/api/v1/admin/users?' +
          new URLSearchParams(
            Object.entries(filters).map(([k, v]) => [k, String(v)]),
          ),
        undefined,
        signal,
      ),
    adminUser: (id: string, signal?: AbortSignal) =>
      request<{
        user: Record<string, unknown>;
        access: Access;
        sessions: Session[];
        grants: Record<string, unknown>[];
      }>('GET', '/api/v1/admin/users/' + identifier(id), undefined, signal),
    adminOverview: (signal?: AbortSignal) =>
      request<Record<string, unknown>>(
        'GET',
        '/api/v1/admin/overview',
        undefined,
        signal,
      ),
    adminAudit: (signal?: AbortSignal) =>
      request<{ events: Record<string, unknown>[] }>(
        'GET',
        '/api/v1/admin/audit',
        undefined,
        signal,
      ),
    adminActivity: (id: string, offset = 0, signal?: AbortSignal) =>
      request<Record<string, unknown>>(
        'GET',
        `/api/v1/admin/users/${identifier(id)}/activity?offset=${offset}`,
        undefined,
        signal,
      ),
    adminChange: (change: Change, signal?: AbortSignal) => {
      const statuses: Partial<Record<Change['action'], AccountStatus>> = {
        suspend: 'suspended',
        reactivate: 'active',
        close: 'closed',
        reopen: 'pending',
      };
      const status = statuses[change.action],
        action = status ? 'status' : change.action;
      const value = {
        expectedRevision: change.expectedRevision,
        reason: change.reason,
        ...(status ? { status } : {}),
        ...(['approve', 'access'].includes(action)
          ? { tier: change.tier, expiresAt: change.expiresAt }
          : {}),
      };
      return request(
        'access' === action ? 'PUT' : status ? 'PATCH' : 'POST',
        `/api/v1/admin/users/${identifier(change.userId)}/${action}`,
        value,
        signal,
      );
    },
    adminRole: (
      userId: string,
      role: 'member' | 'admin' | 'owner',
      expectedRevision: number,
      reason: string,
      signal?: AbortSignal,
    ) =>
      request(
        'PATCH',
        `/api/v1/admin/users/${identifier(userId)}/role`,
        { role, expectedRevision, reason },
        signal,
      ),
  };
}
export type AccountClient = ReturnType<typeof createAccountClient>;
