import { useState } from 'react';
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  ChevronRight,
  Clock3,
  FileClock,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Search,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { Badge, Brand, Dialog } from '../account/ui';
import { tierNames, type Tier } from '../account/types';
import {
  actionLabels,
  effectiveAccess,
  type Action,
  type Change,
  type Directory,
  type ManagedUser,
} from './model';

export interface AdminWorkspaceProps {
  directory: Directory;
  onChange(change: Change): boolean;
  error?: string;
  onClearError(): void;
  onSignOut(): void;
}
function statusTone(status: string): 'green' | 'amber' | 'red' | 'neutral' {
  return status === 'active'
    ? 'green'
    : status === 'pending'
      ? 'amber'
      : status === 'suspended'
        ? 'red'
        : 'neutral';
}
function Avatar({ user }: { user: ManagedUser }) {
  return (
    <span className="la-avatar">
      {user.name
        .split(' ')
        .map((n) => n[0])
        .join('')}
    </span>
  );
}

export function AdminWorkspace({
  directory,
  onChange,
  error,
  onClearError,
  onSignOut,
}: AdminWorkspaceProps) {
  const [page, setPage] = useState<
      'overview' | 'accounts' | 'activity' | 'audit'
    >('accounts'),
    [search, setSearch] = useState(''),
    [status, setStatus] = useState('all'),
    [tier, setTier] = useState('all'),
    [selected, setSelected] = useState<string | null>(null),
    [change, setChange] = useState<Action | null>(null),
    [detailTab, setDetailTab] = useState<'access' | 'sessions' | 'activity'>(
      'access',
    );
  const user = directory.users.find((u) => u.id === selected);
  const filtered = directory.users.filter(
    (u) =>
      `${u.name} ${u.email}`.toLowerCase().includes(search.toLowerCase()) &&
      (status === 'all' || u.status === status) &&
      (tier === 'all' || u.tier === tier || (tier === 'none' && !u.tier)),
  );
  const counts = {
    all: directory.users.length,
    active: directory.users.filter((u) => effectiveAccess(u) === 'Available')
      .length,
    pending: directory.users.filter((u) => u.status === 'pending').length,
    suspended: directory.users.filter((u) => u.status === 'suspended').length,
  };
  function open(id: string) {
    setSelected(id);
    setChange(null);
    setDetailTab('access');
    onClearError();
  }
  function close() {
    setSelected(null);
    setChange(null);
    onClearError();
  }
  const pending = directory.users.filter((u) => u.status === 'pending');
  return (
    <div className="la-admin">
      <aside className="la-admin-sidebar">
        <Brand subtitle="Administration" />
        <span className="la-workspace-label">
          <ShieldCheck size={13} />
          ACCOUNT MANAGEMENT
        </span>
        <nav aria-label="Administration sections">
          {(
            [
              { id: 'overview', label: 'Overview', icon: LayoutDashboard },
              { id: 'accounts', label: 'Accounts', icon: Users },
              { id: 'activity', label: 'Activity', icon: Activity },
              { id: 'audit', label: 'Audit history', icon: FileClock },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              aria-current={page === item.id ? 'page' : undefined}
              onClick={() => setPage(item.id)}
            >
              <item.icon size={17} />
              {item.label}
              {item.id === 'accounts' && <span>{counts.all}</span>}
            </button>
          ))}
        </nav>
        <div className="la-admin-sidebar-footer">
          <span className="la-avatar">MR</span>
          <div>
            <strong>Morgan Reed</strong>
            <small>Owner · MFA verified</small>
          </div>
          <button
            className="la-icon-button"
            aria-label="Sign out of administration"
            onClick={onSignOut}
          >
            <LogOut size={15} />
          </button>
        </div>
      </aside>
      <div className="la-admin-body">
        <header className="la-admin-topbar">
          <span>
            Administration <ChevronRight size={13} />
            <strong>
              {page === 'audit'
                ? 'Audit history'
                : page[0].toUpperCase() + page.slice(1)}
            </strong>
          </span>
          <Badge tone="green">
            <ShieldCheck size={12} />
            Protected session
          </Badge>
          <button
            className="la-icon-button la-mobile-signout"
            aria-label="Sign out of administration"
            onClick={onSignOut}
          >
            <LogOut size={16} />
          </button>
        </header>
        <main className="la-admin-main">
          <div className="la-admin-heading">
            <div>
              <p className="la-eyebrow">LINA TERMINAL</p>
              <h1>
                {page === 'accounts'
                  ? 'Manage access'
                  : page === 'overview'
                    ? 'Workspace overview'
                    : page === 'activity'
                      ? 'Account activity'
                      : 'A record of every change'}
              </h1>
              <p className="la-lede">
                {page === 'accounts'
                  ? 'Approve accounts and manage each person’s access to Lina.'
                  : page === 'overview'
                    ? 'A clear view of your accounts and access.'
                    : page === 'activity'
                      ? 'Account events and client-reported usage, clearly separated.'
                      : 'Review who changed an account, when, and why.'}
              </p>
            </div>
            <span className="la-updated">
              <Clock3 size={14} />
              Sample snapshot · Sep 13, 2026
            </span>
          </div>
          <div className="la-stats">
            {[
              {
                label: 'Total accounts',
                value: counts.all,
                hint: 'Registered users',
              },
              {
                label: 'With access',
                value: counts.active,
                hint: 'Active, verified, valid plan',
              },
              {
                label: 'Awaiting approval',
                value: counts.pending,
                hint: 'Verification or approval needed',
              },
              {
                label: 'Suspended',
                value: counts.suspended,
                hint: 'Access temporarily paused',
              },
            ].map((stat) => (
              <section key={stat.label}>
                <p>{stat.label}</p>
                <strong>{stat.value}</strong>
                <small>{stat.hint}</small>
              </section>
            ))}
          </div>
          {page === 'overview' ? (
            <div className="la-overview-grid">
              <section className="la-card">
                <div className="la-section-heading">
                  <h2>Waiting for approval</h2>
                  <Badge tone="amber">{pending.length}</Badge>
                </div>
                {pending.length ? (
                  pending.map((u) => (
                    <button
                      className="la-review-row"
                      key={u.id}
                      onClick={() => open(u.id)}
                    >
                      <Avatar user={u} />
                      <span>
                        <strong>{u.name}</strong>
                        <small>
                          {u.verified
                            ? 'Email verified'
                            : 'Email not yet verified'}
                        </small>
                      </span>
                      <ChevronRight size={17} />
                    </button>
                  ))
                ) : (
                  <p className="la-empty">
                    No accounts are waiting for approval.
                  </p>
                )}
              </section>
              <section className="la-card">
                <h2>Access by plan</h2>
                <p>Only users with currently available access.</p>
                {(['full_access', 'orchestrator'] as Tier[]).map((plan) => {
                  const count = directory.users.filter(
                    (u) =>
                      u.tier === plan && effectiveAccess(u) === 'Available',
                  ).length;
                  return (
                    <div className="la-plan-count" key={plan}>
                      <div>
                        <span>{tierNames[plan]}</span>
                        <strong>{count}</strong>
                      </div>
                      <div className="la-meter">
                        <i
                          style={{
                            width: `${counts.active ? (count / counts.active) * 100 : 0}%`,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
                <p className="la-small">
                  Account approval, plan access, and administrator roles are
                  separate.
                </p>
              </section>
            </div>
          ) : page === 'accounts' ? (
            <section className="la-table-card">
              <div className="la-table-tools">
                <label className="la-search">
                  <Search size={17} />
                  <input
                    aria-label="Search accounts"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search name or email…"
                  />
                </label>
                <div className="la-filters">
                  <label>
                    Status
                    <select
                      value={status}
                      onChange={(event) => setStatus(event.target.value)}
                    >
                      <option value="all">All statuses</option>
                      {['active', 'pending', 'suspended', 'closed'].map(
                        (value) => (
                          <option key={value} value={value}>
                            {value[0].toUpperCase() + value.slice(1)}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <label>
                    Plan
                    <select
                      value={tier}
                      onChange={(event) => setTier(event.target.value)}
                    >
                      <option value="all">All plans</option>
                      <option value="full_access">Full Access</option>
                      <option value="orchestrator">Orchestrator</option>
                      <option value="none">No plan</option>
                    </select>
                  </label>
                </div>
              </div>
              <div className="la-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Status</th>
                      <th>Plan / access</th>
                      <th>Last seen</th>
                      <th>
                        <span className="la-sr-only">Details</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((u) => (
                      <tr key={u.id}>
                        <td>
                          <button
                            className="la-user-cell"
                            onClick={() => open(u.id)}
                          >
                            <Avatar user={u} />
                            <span>
                              <strong>
                                {u.name}
                                {u.role !== 'member' && (
                                  <span className="la-role">{u.role}</span>
                                )}
                              </strong>
                              <small>{u.email}</small>
                            </span>
                          </button>
                        </td>
                        <td>
                          <Badge tone={statusTone(u.status)}>
                            {u.status[0].toUpperCase() + u.status.slice(1)}
                          </Badge>
                        </td>
                        <td>
                          <strong className="la-table-plan">
                            {u.tier ? tierNames[u.tier] : 'No plan assigned'}
                          </strong>
                          <small
                            className={
                              effectiveAccess(u) === 'Expired'
                                ? 'la-danger-text'
                                : ''
                            }
                          >
                            {effectiveAccess(u)}
                          </small>
                        </td>
                        <td>
                          <span className="la-table-seen">{u.lastSeen}</span>
                        </td>
                        <td>
                          <button
                            className="la-icon-button"
                            aria-label={`View ${u.name}`}
                            onClick={() => open(u.id)}
                          >
                            <ArrowUpRight size={16} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!filtered.length && (
                <div className="la-empty">
                  <Users size={28} />
                  <h3>No accounts match</h3>
                  <p>Try another name, email, status, or plan.</p>
                  <button
                    className="la-button"
                    onClick={() => {
                      setSearch('');
                      setStatus('all');
                      setTier('all');
                    }}
                  >
                    Clear filters
                  </button>
                </div>
              )}
              <footer className="la-table-footer">
                Showing {filtered.length} of {counts.all} accounts
                <span>Changes appear in audit history</span>
              </footer>
            </section>
          ) : page === 'audit' ? (
            <section className="la-card">
              <div className="la-section-heading">
                <h2>Administrative changes</h2>
                <Badge>{directory.audit.length} entries</Badge>
              </div>
              <div className="la-audit-list">
                {directory.audit.map((entry) => (
                  <article key={entry.id}>
                    <span className="la-timeline-icon">
                      <FileClock size={16} />
                    </span>
                    <div>
                      <strong>{entry.action}</strong>
                      <p>
                        {entry.userName} · by {entry.actor}
                      </p>
                      <blockquote>{entry.reason}</blockquote>
                      <small>
                        {entry.before} <span aria-hidden="true">→</span>{' '}
                        {entry.after}
                      </small>
                    </div>
                    <time>{entry.at}</time>
                  </article>
                ))}
              </div>
            </section>
          ) : (
            <section className="la-card">
              <h2>Recent events</h2>
              <p>
                Connectivity and reported usage are signals, not proof of
                completed work.
              </p>
              <div className="la-event-list">
                {[
                  {
                    name: 'Avery Chen',
                    event: 'Signed in successfully',
                    source: 'Account event',
                    time: '09:24',
                    icon: ShieldCheck,
                  },
                  {
                    name: 'Avery Chen',
                    event: 'Orchestrator request reported',
                    source: 'Client-reported',
                    time: '09:25',
                    icon: Activity,
                  },
                  {
                    name: 'Jamie Park',
                    event: 'Device heartbeat received',
                    source: 'Connectivity',
                    time: '08:48',
                    icon: ArrowDownLeft,
                  },
                  {
                    name: 'Noor Ali',
                    event: 'Email address verified',
                    source: 'Account event',
                    time: '08:42',
                    icon: Check,
                  },
                ].map((entry, i) => (
                  <article key={i}>
                    <span className="la-timeline-icon">
                      <entry.icon size={17} />
                    </span>
                    <div>
                      <strong>{entry.event}</strong>
                      <p>{entry.name}</p>
                    </div>
                    <Badge>{entry.source}</Badge>
                    <time>{entry.time}</time>
                  </article>
                ))}
              </div>
            </section>
          )}
        </main>
      </div>
      {user && (
        <Dialog
          title={change ? actionLabels[change] : user.name}
          wide
          onClose={close}
        >
          {change ? (
            <ChangeForm
              key={`${user.id}-${change}`}
              user={user}
              action={change}
              error={error}
              onCancel={() => {
                setChange(null);
                onClearError();
              }}
              onSubmit={(value) => {
                if (onChange(value)) close();
              }}
            />
          ) : (
            <>
              <div className="la-profile-summary">
                <Avatar user={user} />
                <div>
                  <strong>{user.name}</strong>
                  <p>{user.email}</p>
                  <Badge tone={user.verified ? 'green' : 'amber'}>
                    {user.verified ? 'Email verified' : 'Email unverified'}
                  </Badge>
                </div>
                <Badge tone={statusTone(user.status)}>{user.status}</Badge>
              </div>
              <nav className="la-tabs" aria-label="User details">
                {(['access', 'sessions', 'activity'] as const).map((tab) => (
                  <button
                    key={tab}
                    aria-current={detailTab === tab ? 'page' : undefined}
                    onClick={() => setDetailTab(tab)}
                  >
                    {tab[0].toUpperCase() + tab.slice(1)}
                  </button>
                ))}
              </nav>
              {detailTab === 'access' ? (
                <>
                  <dl className="la-details">
                    <div>
                      <dt>Assigned plan</dt>
                      <dd>
                        {user.tier ? tierNames[user.tier] : 'No plan assigned'}
                      </dd>
                    </div>
                    <div>
                      <dt>Effective access</dt>
                      <dd>{effectiveAccess(user)}</dd>
                    </div>
                    <div>
                      <dt>Access expires</dt>
                      <dd>{user.expiresAt || 'No expiry set'}</dd>
                    </div>
                    <div>
                      <dt>Account role</dt>
                      <dd className="la-capitalize">{user.role}</dd>
                    </div>
                  </dl>
                  <div className="la-account-actions">
                    {user.status === 'pending' && (
                      <button
                        className="la-button la-button--primary"
                        disabled={!user.verified}
                        onClick={() => setChange('approve')}
                      >
                        <Check size={16} />
                        Approve and assign plan
                      </button>
                    )}
                    {user.status === 'pending' && !user.verified && (
                      <p className="la-small">
                        Email verification is required before approval.
                      </p>
                    )}
                    {user.status === 'active' && (
                      <button
                        className="la-button la-button--primary"
                        onClick={() => setChange('access')}
                      >
                        Change plan or expiry
                      </button>
                    )}
                    {user.status === 'suspended' && (
                      <button
                        className="la-button la-button--primary"
                        onClick={() => setChange('reactivate')}
                      >
                        Reactivate account
                      </button>
                    )}
                    {user.status === 'closed' && (
                      <button
                        className="la-button"
                        onClick={() => setChange('reopen')}
                      >
                        Reopen for review
                      </button>
                    )}
                  </div>
                  <div className="la-danger-zone">
                    <h3>Access controls</h3>
                    <p>These changes preserve the user’s local projects.</p>
                    <div>
                      {user.status === 'active' && (
                        <button
                          className="la-button"
                          onClick={() => setChange('suspend')}
                        >
                          Suspend account
                        </button>
                      )}
                      {user.tier && (
                        <button
                          className="la-button"
                          onClick={() => setChange('revoke-access')}
                        >
                          Revoke access
                        </button>
                      )}
                      {user.status !== 'closed' && (
                        <button
                          className="la-button la-button--danger"
                          onClick={() => setChange('close')}
                        >
                          Close account
                        </button>
                      )}
                    </div>
                  </div>
                </>
              ) : detailTab === 'sessions' ? (
                <div className="la-detail-sessions">
                  <ShieldCheck size={25} />
                  <h3>
                    {user.sessions} active{' '}
                    {user.sessions === 1 ? 'session' : 'sessions'}
                  </h3>
                  <p>Last sign-in: {user.lastLogin}</p>
                  <p className="la-small">
                    Revoking sessions requires the user to sign in again. It
                    does not change their plan.
                  </p>
                  <button
                    className="la-button"
                    disabled={user.sessions === 0}
                    onClick={() => setChange('revoke-sessions')}
                  >
                    Revoke all sessions
                  </button>
                </div>
              ) : (
                <div className="la-audit-list">
                  {directory.audit
                    .filter((entry) => entry.userId === user.id)
                    .map((entry) => (
                      <article key={entry.id}>
                        <FileClock size={17} />
                        <div>
                          <strong>{entry.action}</strong>
                          <p>{entry.reason}</p>
                        </div>
                        <time>{entry.at}</time>
                      </article>
                    ))}
                  {!directory.audit.some(
                    (entry) => entry.userId === user.id,
                  ) && (
                    <p className="la-empty">
                      No administrative changes in this preview yet.
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </Dialog>
      )}
    </div>
  );
}

function ChangeForm({
  user,
  action,
  error,
  onSubmit,
  onCancel,
}: {
  user: ManagedUser;
  action: Action;
  error?: string;
  onSubmit(change: Change): void;
  onCancel(): void;
}) {
  const [tier, setTier] = useState<Tier>(user.tier || 'full_access'),
    [expiry, setExpiry] = useState(user.expiresAt || ''),
    [reason, setReason] = useState(''),
    [revision] = useState(user.revision);
  const assignment = action === 'approve' || action === 'access';
  return (
    <form
      className="la-change-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          userId: user.id,
          action,
          reason,
          expectedRevision: revision,
          ...(assignment ? { tier, expiresAt: expiry || null } : {}),
        });
      }}
    >
      <p className="la-lede">
        {user.name} · {user.email}
      </p>
      {error && (
        <p className="la-error" role="alert">
          {error}
        </p>
      )}
      {assignment ? (
        <>
          <fieldset className="la-plan-options">
            <legend>Access plan</legend>
            {(['full_access', 'orchestrator'] as Tier[]).map((value) => (
              <label
                key={value}
                className={tier === value ? 'is-selected' : ''}
              >
                <input
                  type="radio"
                  name="tier"
                  checked={tier === value}
                  onChange={() => setTier(value)}
                />
                <span>
                  <strong>{tierNames[value]}</strong>
                  <small>
                    {value === 'full_access'
                      ? 'All terminals, agent modes, and workspace tools.'
                      : 'Full Access, plus voice and task coordination.'}
                  </small>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="la-field">
            Expiry date <span className="la-small">Optional</span>
            <input
              type="date"
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
              min="2026-09-14"
            />
            <small>Leave empty for access with no scheduled expiry.</small>
          </label>
        </>
      ) : (
        <div className="la-callout">
          <LockKeyhole size={18} />
          <p>
            {action === 'revoke-sessions'
              ? 'All of this user’s sessions will require a new sign-in.'
              : action === 'close'
                ? 'The account will be closed and product access blocked. This does not delete local projects.'
                : action === 'reopen'
                  ? 'The account will return to pending review with no assigned plan.'
                  : action === 'suspend'
                    ? 'Product access will pause until the account is reactivated.'
                    : action === 'reactivate'
                      ? 'The account will become active. Access still depends on a valid plan.'
                      : 'The current plan grant will be revoked. Account status stays unchanged.'}
          </p>
        </div>
      )}
      <label className="la-field">
        Reason
        <textarea
          required
          minLength={3}
          maxLength={500}
          rows={3}
          placeholder="Why are you making this change?"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <small>Saved with your name in the audit history.</small>
      </label>
      <div className="la-dialog-actions">
        <button type="button" className="la-button" onClick={onCancel}>
          Back
        </button>
        <button
          className={`la-button ${['suspend', 'close', 'revoke-access', 'revoke-sessions'].includes(action) ? 'la-button--danger' : 'la-button--primary'}`}
          type="submit"
        >
          {actionLabels[action]}
        </button>
      </div>
    </form>
  );
}
