// Presentation contracts. No administrator role or capability belongs to this surface.
export type AccountScreen =
  | 'welcome'
  | 'browser'
  | 'browser-error'
  | 'verify'
  | 'pending'
  | 'suspended'
  | 'expired'
  | 'offline-expired'
  | 'account';
export type AccountTier = 'full_access' | 'orchestrator';
export interface AccountDevice {
  id: string;
  name: string;
  platform: string;
  seen: string;
  current: boolean;
}
export interface AccountPresentation {
  name: string;
  email: string;
  tier: AccountTier;
  verified: boolean;
  expiresAt: string | null;
  offline: boolean;
  graceEndsAt: string | null;
  devices: AccountDevice[];
  shareUsage: boolean;
}
export type AccountAction =
  | { type: 'start-login'; mode: 'sign-in' | 'sign-up' }
  | { type: 'cancel-login' | 'retry' | 'sign-out' }
  | { type: 'submit-code'; code: string }
  | { type: 'revoke-device'; id: string }
  | { type: 'set-usage'; enabled: boolean };
export interface AccountViewProps {
  screen: AccountScreen;
  account: AccountPresentation;
  busy?: boolean;
  error?: string;
  onAction(action: AccountAction): void;
}
