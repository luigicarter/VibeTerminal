import type { AccountPresentation, AccountScreen } from './types';
export const tierLabels = {
  full_access: 'Full Access',
  orchestrator: 'Orchestrator',
} as const;
export const initialAccount: AccountPresentation = {
  name: 'Avery Chen',
  email: 'avery@example.test',
  tier: 'orchestrator',
  verified: true,
  expiresAt: 'October 13, 2026',
  offline: false,
  graceEndsAt: null,
  shareUsage: false,
  devices: [
    {
      id: 'local',
      name: 'Windows desktop',
      platform: 'Windows',
      seen: 'Active now',
      current: true,
    },
    {
      id: 'laptop',
      name: 'MacBook Air',
      platform: 'macOS',
      seen: 'Yesterday, 16:42',
      current: false,
    },
  ],
};
export const scenes: Record<
  string,
  { screen: AccountScreen; patch: Partial<AccountPresentation> }
> = {
  'Sign in': { screen: 'welcome', patch: {} },
  'Waiting for browser': { screen: 'browser', patch: {} },
  'Browser sign-in failed': { screen: 'browser-error', patch: {} },
  'Verify email': { screen: 'verify', patch: { verified: false } },
  'Awaiting approval': { screen: 'pending', patch: {} },
  'Full Access account': { screen: 'account', patch: { tier: 'full_access' } },
  'Orchestrator account': {
    screen: 'account',
    patch: { tier: 'orchestrator' },
  },
  Suspended: { screen: 'suspended', patch: {} },
  'Access expired': { screen: 'expired', patch: {} },
  'Offline with example grace': {
    screen: 'account',
    patch: { offline: true, graceEndsAt: 'September 14, 09:20' },
  },
  'Offline grace expired': {
    screen: 'offline-expired',
    patch: { offline: true },
  },
};
/** Presentation only: the future main-process authority must supply a verified state. */
export function presentationScreen(
  screen: AccountScreen,
  account: AccountPresentation,
): AccountScreen {
  if (screen !== 'account') return screen;
  if (!account.verified) return 'verify';
  if (account.offline && !account.graceEndsAt) return 'offline-expired';
  return screen;
}
export function accessSummary(
  requestedScreen: AccountScreen,
  account: AccountPresentation,
) {
  const screen = presentationScreen(requestedScreen, account);
  const available = screen === 'account';
  return {
    terminals: available,
    orchestrator: available && account.tier === 'orchestrator',
    preserveRunningWork: ['suspended', 'expired', 'offline-expired'].includes(
      screen,
    ),
  };
}
