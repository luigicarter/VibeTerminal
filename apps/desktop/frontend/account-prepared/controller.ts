import type {
  AccountAction,
  AccountPresentation,
  AccountScreen,
} from '../account/types';
export interface AccountBridge {
  status(): Promise<{
    signedIn: boolean;
    waiting: boolean;
    error: string | null;
    account: {
      name: string;
      email: string;
      verified: boolean;
      access: {
        allowed: boolean;
        reason: string | null;
        tier: 'full_access' | 'orchestrator' | null;
        expiresAt: string | null;
      };
    } | null;
    access: {
      allowed: boolean;
      expiresAt: string | null;
      identity: { sessionId: string } | null;
    };
    persistence: string;
  }>;
  login(): Promise<unknown>;
  cancel(): Promise<unknown>;
  code(input: { code: string }): Promise<unknown>;
  refresh(): Promise<unknown>;
  logout(): Promise<unknown>;
  revoke(input: { id: string }): Promise<unknown>;
  usage(input: { enabled: boolean }): Promise<unknown>;
  sessions(): Promise<{
    sessions: {
      id: string;
      platform: string | null;
      last_seen_at: string | null;
    }[];
  }>;
  preferences(): Promise<{ shareUsage: boolean }>;
}
// Inject a narrow bridge in a dedicated harness; the production preload does not expose it.
export function createAccountViewController(bridge: AccountBridge) {
  let version = 0;
  return {
    async read(): Promise<{
      screen: AccountScreen;
      account: AccountPresentation;
      error: string | null;
    }> {
      const state = await bridge.status(),
        value = state.account,
        reason = value?.access.reason;
      const [sessions, preferences] = state.signedIn
        ? await Promise.all([
            bridge.sessions().catch(() => ({ sessions: [] })),
            bridge.preferences().catch(() => ({ shareUsage: false })),
          ])
        : [{ sessions: [] }, { shareUsage: false }];
      const screen: AccountScreen = state.waiting
        ? 'browser'
        : !state.signedIn
          ? 'welcome'
          : !value
            ? 'browser-error'
            : !value.verified
              ? 'verify'
              : reason === 'account_pending'
                ? 'pending'
                : ['account_suspended', 'account_closed'].includes(reason || '')
                  ? 'suspended'
                  : !state.access.allowed
                    ? state.error === 'connection_unavailable'
                      ? 'offline-expired'
                      : 'expired'
                    : 'account';
      return {
        screen,
        error: state.error,
        account: {
          name: value?.name || '',
          email: value?.email || '',
          tier: value?.access.tier || 'full_access',
          verified: value?.verified || false,
          expiresAt: value?.access.expiresAt || null,
          offline: state.error === 'connection_unavailable',
          graceEndsAt: state.access.expiresAt,
          devices: sessions.sessions.map((s) => ({
            id: s.id,
            name: s.platform || 'Device',
            platform: s.platform || 'unknown',
            seen: s.last_seen_at || 'Not reported',
            current: s.id === state.access.identity?.sessionId,
          })),
          shareUsage: preferences.shareUsage,
        },
      };
    },
    async act(action: AccountAction) {
      const current = ++version;
      switch (action.type) {
        case 'start-login':
          await bridge.login();
          break;
        case 'cancel-login':
          await bridge.cancel();
          break;
        case 'submit-code':
          await bridge.code({ code: action.code });
          break;
        case 'retry':
          await bridge.refresh();
          break;
        case 'sign-out':
          await bridge.logout();
          break;
        case 'revoke-device':
          await bridge.revoke({ id: action.id });
          break;
        case 'set-usage':
          await bridge.usage({ enabled: action.enabled });
          break;
      }
      return current === version;
    },
    dispose() {
      version++;
    },
  };
}
