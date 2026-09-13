import type { AccountStatus, Tier } from '../account/types';
export type Role = 'member' | 'admin' | 'owner';
export type Action =
  | 'approve'
  | 'access'
  | 'suspend'
  | 'reactivate'
  | 'close'
  | 'reopen'
  | 'revoke-access'
  | 'revoke-sessions';
export interface ManagedUser {
  id: string;
  name: string;
  email: string;
  status: AccountStatus;
  verified: boolean;
  role: Role;
  tier: Tier | null;
  expiresAt: string | null;
  revision: number;
  lastSeen: string;
  lastLogin: string;
  sessions: number;
}
export interface AuditEntry {
  id: string;
  userId: string;
  userName: string;
  action: string;
  reason: string;
  at: string;
  actor: string;
  before: string;
  after: string;
}
export interface Directory {
  users: ManagedUser[];
  audit: AuditEntry[];
}
export interface Change {
  userId: string;
  action: Action;
  reason: string;
  expectedRevision: number;
  tier?: Tier;
  expiresAt?: string | null;
}
export const demoNow = '2026-09-13T14:30:00Z';
export const actionLabels: Record<Action, string> = {
  approve: 'Approve account',
  access: 'Change access',
  suspend: 'Suspend account',
  reactivate: 'Reactivate account',
  close: 'Close account',
  reopen: 'Reopen for review',
  'revoke-access': 'Revoke access',
  'revoke-sessions': 'Revoke all sessions',
};
export function seedDirectory(): Directory {
  const data: Pick<
    ManagedUser,
    | 'name'
    | 'email'
    | 'status'
    | 'verified'
    | 'role'
    | 'tier'
    | 'expiresAt'
    | 'sessions'
    | 'lastSeen'
  >[] = [
    {
      name: 'Avery Chen',
      email: 'avery@example.test',
      status: 'active',
      verified: true,
      role: 'member',
      tier: 'orchestrator',
      expiresAt: '2026-10-13',
      sessions: 3,
      lastSeen: '2 minutes ago',
    },
    {
      name: 'Morgan Reed',
      email: 'morgan@example.test',
      status: 'active',
      verified: true,
      role: 'owner',
      tier: 'full_access',
      expiresAt: null,
      sessions: 1,
      lastSeen: 'Just now',
    },
    {
      name: 'Noor Ali',
      email: 'noor@example.test',
      status: 'pending',
      verified: true,
      role: 'member',
      tier: null,
      expiresAt: null,
      sessions: 1,
      lastSeen: '18 minutes ago',
    },
    {
      name: 'Jamie Park',
      email: 'jamie@example.test',
      status: 'active',
      verified: true,
      role: 'member',
      tier: 'full_access',
      expiresAt: '2026-10-01',
      sessions: 2,
      lastSeen: '42 minutes ago',
    },
    {
      name: 'Sam Rivera',
      email: 'sam@example.test',
      status: 'suspended',
      verified: true,
      role: 'member',
      tier: 'orchestrator',
      expiresAt: '2026-10-13',
      sessions: 1,
      lastSeen: 'Yesterday',
    },
    {
      name: 'Riley James',
      email: 'riley@example.test',
      status: 'pending',
      verified: false,
      role: 'member',
      tier: null,
      expiresAt: null,
      sessions: 0,
      lastSeen: 'Not seen yet',
    },
    {
      name: 'Casey Brooks',
      email: 'casey@example.test',
      status: 'active',
      verified: true,
      role: 'member',
      tier: 'full_access',
      expiresAt: '2026-09-12',
      sessions: 1,
      lastSeen: 'Yesterday',
    },
    {
      name: 'Taylor Quinn',
      email: 'taylor@example.test',
      status: 'closed',
      verified: true,
      role: 'member',
      tier: null,
      expiresAt: null,
      sessions: 0,
      lastSeen: 'September 8',
    },
  ];
  const users = data.map((u, i) => ({
    ...u,
    id: `demo-${i + 1}`,
    revision: 1,
    lastLogin: i < 4 ? 'Today at 09:14' : 'September 12 at 16:42',
  }));
  return {
    users,
    audit: [
      {
        id: 'audit-initial',
        userId: users[0].id,
        userName: users[0].name,
        action: 'Changed access to Orchestrator',
        reason: 'Approved for the Orchestrator evaluation.',
        at: '09:18',
        actor: 'Morgan Reed',
        before: 'Full Access',
        after: 'Orchestrator',
      },
    ],
  };
}
export function effectiveAccess(user: ManagedUser, now = demoNow) {
  if (!user.verified) return 'Email unverified';
  if (user.status === 'pending') return 'Awaiting approval';
  if (user.status === 'suspended') return 'Suspended';
  if (user.status === 'closed') return 'Closed';
  if (!user.tier) return 'No access';
  if (user.expiresAt && Date.parse(user.expiresAt) <= Date.parse(now))
    return 'Expired';
  return 'Available';
}
/** In-memory demonstration reducer, never an authorization or server implementation. */
export function applyPreviewChange(
  directory: Directory,
  change: Change,
  actor: Role = 'owner',
): Directory {
  if (actor === 'member') throw new Error('Administrator access is required.');
  const user = directory.users.find((u) => u.id === change.userId);
  if (!user) throw new Error('Account not found.');
  if (user.revision !== change.expectedRevision)
    throw new Error(
      'This account changed while you were viewing it. Reload the account and try again.',
    );
  if (change.reason.trim().length < 3)
    throw new Error('Add a reason with at least 3 characters.');
  if (user.role !== 'member' && actor !== 'owner')
    throw new Error('Only an owner can change another administrator.');
  const next = { ...user };
  if (
    user.role === 'owner' &&
    ['suspend', 'close'].includes(change.action) &&
    directory.users.filter((u) => u.role === 'owner' && u.status === 'active')
      .length === 1
  )
    throw new Error('Keep at least one active owner.');
  if (change.action === 'approve' || change.action === 'access') {
    if (!user.verified)
      throw new Error('The user must verify their email first.');
    if (change.action === 'approve' && user.status !== 'pending')
      throw new Error('This account is no longer pending approval.');
    if (change.action === 'access' && user.status !== 'active')
      throw new Error('Reactivate this account before changing access.');
    if (!change.tier) throw new Error('Choose a plan.');
    if (
      change.expiresAt &&
      (!Number.isFinite(Date.parse(change.expiresAt)) ||
        Date.parse(change.expiresAt) <= Date.parse(demoNow))
    )
      throw new Error('Choose a future expiry date or leave it empty.');
    next.status = 'active';
    next.tier = change.tier;
    next.expiresAt = change.expiresAt || null;
  } else if (change.action === 'revoke-sessions') next.sessions = 0;
  else if (change.action === 'revoke-access') {
    next.tier = null;
    next.expiresAt = null;
  } else {
    const changes: Partial<Record<Action, [AccountStatus[], AccountStatus]>> = {
      suspend: [['active'], 'suspended'],
      reactivate: [['suspended'], 'active'],
      close: [['active', 'pending', 'suspended'], 'closed'],
      reopen: [['closed'], 'pending'],
    };
    const rule = changes[change.action];
    if (!rule || !rule[0].includes(user.status))
      throw new Error('That change is unavailable for this account.');
    next.status = rule[1];
    if (change.action === 'reopen') {
      next.tier = null;
      next.expiresAt = null;
    }
  }
  next.revision++;
  const audit: AuditEntry = {
    id: `audit-${directory.audit.length + 1}`,
    userId: user.id,
    userName: user.name,
    action: actionLabels[change.action],
    reason: change.reason.trim(),
    at: 'Now',
    actor: 'Morgan Reed',
    before: `${user.status} · ${user.tier || 'no plan'}`,
    after: `${next.status} · ${next.tier || 'no plan'}`,
  };
  return {
    users: directory.users.map((u) => (u.id === next.id ? next : u)),
    audit: [audit, ...directory.audit],
  };
}
