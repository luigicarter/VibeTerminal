// View contracts only. No transport, auth SDK, browser storage, or server imports.
export type Tier = 'full_access' | 'orchestrator';
export type AccountStatus = 'pending' | 'active' | 'suspended' | 'closed';
export type AuthScreen =
  | 'sign-in'
  | 'sign-up'
  | 'verify'
  | 'forgot'
  | 'reset-sent'
  | 'reset'
  | 'mfa'
  | 'pending'
  | 'suspended'
  | 'expired'
  | 'offline';
export type AuthSubmission = {
  email?: string;
  password?: string;
  name?: string;
  code?: string;
};
export interface PersonalSession {
  id: string;
  device: string;
  platform: string;
  lastSeen: string;
  current: boolean;
}
export interface PersonalAccount {
  name: string;
  email: string;
  tier: Tier;
  status: AccountStatus;
  verified: boolean;
  expiresAt: string | null;
  sessions: PersonalSession[];
}
export const tierNames: Record<Tier, string> = {
  full_access: 'Full Access',
  orchestrator: 'Orchestrator',
};
