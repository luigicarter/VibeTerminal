import type { AuthScreen, AuthSubmission, Tier } from '../account/types';
import type { Change } from '../admin/model';
import { AccountError, type AccountClient, type Me } from './client';

// UI-safe async state only. Form passwords, MFA secrets and reset tokens never
// enter snapshots, persistence, errors, or logs. Inputs remain owned by forms.
export function createAuthController(
  client: AccountClient,
  onChange: () => void = () => {},
) {
  let state: {
    screen: AuthScreen;
    busy: boolean;
    error: string | null;
    me: Me | null;
  } = { screen: 'sign-in', busy: false, error: null, me: null };
  let epoch = 0,
    pending: AbortController | null = null;
  const snapshot = () => structuredClone(state);
  function cancel() {
    epoch++;
    pending?.abort();
    pending = null;
    state = { ...state, busy: false };
  }
  function navigate(screen: AuthScreen) {
    cancel();
    state = { ...state, screen, error: null };
    onChange();
  }
  async function refresh(signal?: AbortSignal) {
    const me = await client.me(signal);
    return {
      me,
      screen: (me.access.accountStatus === 'pending'
        ? 'pending'
        : me.access.accountStatus === 'suspended' ||
            me.access.accountStatus === 'closed'
          ? 'suspended'
          : !me.access.allowed
            ? 'expired'
            : state.screen) as AuthScreen,
    };
  }
  async function submit(input: AuthSubmission, resetToken?: string) {
    cancel();
    const version = epoch,
      controller = new AbortController();
    pending = controller;
    state = { ...state, busy: true, error: null };
    onChange();
    try {
      let next: Partial<typeof state> = {};
      switch (state.screen) {
        case 'sign-in': {
          const result = await client.login(
            input.email || '',
            input.password || '',
            controller.signal,
          );
          next = result.twoFactorRedirect
            ? { screen: 'mfa' }
            : await refresh(controller.signal);
          break;
        }
        case 'sign-up':
          await client.signup(
            input.name || '',
            input.email || '',
            input.password || '',
            controller.signal,
          );
          next = { screen: 'verify' };
          break;
        case 'verify':
          await client.resend(input.email || '', controller.signal);
          break;
        case 'forgot':
          await client.recover(input.email || '', controller.signal);
          next = { screen: 'reset-sent' };
          break;
        case 'reset':
          if (!resetToken) throw new AccountError('reset_link_invalid');
          await client.reset(
            resetToken,
            input.password || '',
            controller.signal,
          );
          next = { screen: 'sign-in', me: null };
          break;
        case 'mfa':
          await client.verifyMfa(input.code || '', false, controller.signal);
          next = await refresh(controller.signal);
          break;
        default:
          next = await refresh(controller.signal);
      }
      if (version === epoch) state = { ...state, ...next };
    } catch (error) {
      if (version === epoch)
        state = {
          ...state,
          error:
            error instanceof AccountError ? error.code : 'account_unavailable',
        };
    } finally {
      if (version === epoch) {
        state = { ...state, busy: false };
        pending = null;
        onChange();
      }
    }
    return snapshot();
  }
  return {
    snapshot,
    navigate,
    submit,
    cancel,
    async logout() {
      cancel();
      state = { screen: 'sign-in', busy: false, error: null, me: null };
      onChange();
      try {
        await client.logout();
      } catch {
        state.error = 'server_revocation_unconfirmed';
        onChange();
      }
    },
  };
}
export function createAdminController(
  client: AccountClient,
  onChange: () => void = () => {},
) {
  let state: {
    busy: boolean;
    error: string | null;
    users: Record<string, unknown>[];
    selected: Awaited<ReturnType<AccountClient['adminUser']>> | null;
  } = { busy: false, error: null, users: [], selected: null };
  let epoch = 0,
    pending: AbortController | null = null,
    mutating = false;
  const snapshot = () => structuredClone(state);
  async function load(
    filters: Parameters<AccountClient['adminUsers']>[0] = {},
  ) {
    const version = ++epoch;
    pending?.abort();
    pending = new AbortController();
    state = { ...state, busy: true, error: null };
    onChange();
    try {
      const reply = await client.adminUsers(filters, pending.signal);
      if (version === epoch) state.users = reply.users;
    } catch (error) {
      if (version === epoch)
        state.error =
          error instanceof AccountError ? error.code : 'account_unavailable';
    } finally {
      if (version === epoch) {
        state.busy = false;
        onChange();
      }
    }
    return snapshot();
  }
  return {
    snapshot,
    load,
    async select(id: string) {
      const version = ++epoch;
      pending?.abort();
      pending = new AbortController();
      state = { ...state, busy: true, error: null };
      onChange();
      try {
        const result = await client.adminUser(id, pending.signal);
        if (version === epoch) state.selected = result;
      } catch (error) {
        if (version === epoch)
          state.error =
            error instanceof AccountError ? error.code : 'account_unavailable';
      } finally {
        if (version === epoch) {
          state.busy = false;
          onChange();
        }
      }
      return snapshot();
    },
    async change(change: Change) {
      if (mutating) return false;
      mutating = true;
      state = { ...state, busy: true, error: null };
      onChange();
      try {
        await client.adminChange(change);
        await load();
        return true;
      } catch (error) {
        state.error =
          error instanceof AccountError ? error.code : 'account_unavailable';
        return false;
      } finally {
        mutating = false;
        state.busy = false;
        onChange();
      }
    },
    dispose() {
      epoch++;
      pending?.abort();
    },
  };
}
export function createBillingController(
  client: AccountClient,
  navigate: (url: string) => void,
) {
  let busy = false;
  async function open(
    kind: 'checkout' | 'portal',
    tier?: Tier,
    interval?: 'month' | 'year',
  ) {
    if (busy) throw new AccountError('billing_in_progress');
    busy = true;
    try {
      const reply =
        kind === 'checkout'
          ? await client.checkout(tier!, interval!)
          : await client.portal();
      const url = new URL(reply.url);
      if (
        url.protocol !== 'https:' ||
        url.hostname !==
          (kind === 'checkout'
            ? 'checkout.stripe.com'
            : 'billing.stripe.com') ||
        url.port ||
        url.username ||
        url.password
      )
        throw new AccountError('billing_url_invalid');
      navigate(url.href);
    } finally {
      busy = false;
    }
  }
  return {
    status: () => client.billing(),
    checkout: (tier: Tier, interval: 'month' | 'year') =>
      open('checkout', tier, interval),
    portal: () => open('portal'),
  };
}
export function createDesktopApprovalController(
  client: AccountClient,
  navigate: (url: string) => void,
) {
  return {
    inspect: (id: string) => client.desktopAttempt(id),
    async approve(id: string) {
      const reply = await client.approveDesktop(id),
        url = new URL(reply.callbackUrl);
      if (
        url.protocol !== 'http:' ||
        url.hostname !== '127.0.0.1' ||
        Number(url.port) < 1024 ||
        url.username ||
        url.password ||
        url.hash ||
        !/^\/lina-login\/[A-Za-z0-9_-]{43}$/.test(url.pathname) ||
        url.searchParams.get('attempt') !== id ||
        url.searchParams.get('code') !== reply.code ||
        url.searchParams.get('state') !== reply.state
      )
        throw new AccountError('callback_invalid');
      navigate(url.href);
      return { code: reply.code, expiresIn: reply.expiresIn };
    },
  };
}
