import { useState } from 'react';
import {
  ArrowUpRight,
  Check,
  Laptop,
  LogOut,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import { Badge, Brand, Dialog } from './ui';
import { tierNames, type PersonalAccount as Account } from './types';

export function PersonalAccount({
  account,
  onSignOut,
  onRevoke,
}: {
  account: Account;
  onSignOut(): void;
  onRevoke(id: string): void;
}) {
  const [tab, setTab] = useState<'overview' | 'devices'>('overview'),
    [confirm, setConfirm] = useState<string | null>(null),
    [usage, setUsage] = useState(false);
  return (
    <div className="la-personal">
      <header className="la-personal-header">
        <Brand />
        <button className="la-button" onClick={onSignOut}>
          <LogOut size={15} />
          Sign out
        </button>
      </header>
      <main className="la-personal-main">
        <p className="la-eyebrow">YOUR ACCOUNT</p>
        <h1>Good to see you, {account.name.split(' ')[0]}.</h1>
        <p className="la-lede">Your access, security, and connected devices.</p>
        <nav className="la-tabs" aria-label="Account sections">
          <button
            aria-current={tab === 'overview' ? 'page' : undefined}
            onClick={() => setTab('overview')}
          >
            Overview
          </button>
          <button
            aria-current={tab === 'devices' ? 'page' : undefined}
            onClick={() => setTab('devices')}
          >
            Devices <span>{account.sessions.length}</span>
          </button>
        </nav>
        {tab === 'overview' ? (
          <div className="la-personal-grid">
            <section className="la-plan-card">
              <div>
                <span className="la-eyebrow">CURRENT PLAN</span>
                <Badge
                  tone={
                    account.status === 'active' && account.verified
                      ? 'green'
                      : 'amber'
                  }
                >
                  {account.status === 'active' && account.verified
                    ? 'Active access'
                    : 'Access needs review'}
                </Badge>
              </div>
              <h2>{tierNames[account.tier]}</h2>
              <p>
                {account.tier === 'orchestrator'
                  ? 'Your full workspace, with voice and task coordination.'
                  : 'Every terminal and agent mode, in your own workspace.'}
              </p>
              <ul>
                {[
                  'All terminal and agent modes',
                  'Fusion and Open Fusion',
                  'Workspace and Git tools',
                  ...(account.tier === 'orchestrator'
                    ? ['Orchestrator and voice']
                    : []),
                ].map((feature) => (
                  <li key={feature}>
                    <Check size={16} />
                    {feature}
                  </li>
                ))}
              </ul>
              <footer>
                <span>Access expires</span>
                <strong>{account.expiresAt || 'No expiry set'}</strong>
              </footer>
              <p className="la-small">
                AI provider subscriptions and usage are separate.
              </p>
            </section>
            <div className="la-card-stack">
              <section className="la-card">
                <h2>Account details</h2>
                <dl className="la-details">
                  <div>
                    <dt>Name</dt>
                    <dd>{account.name}</dd>
                  </div>
                  <div>
                    <dt>Email</dt>
                    <dd>
                      {account.email}
                      <Badge tone={account.verified ? 'green' : 'amber'}>
                        {account.verified ? 'Verified' : 'Unverified'}
                      </Badge>
                    </dd>
                  </div>
                </dl>
              </section>
              <section className="la-card">
                <ShieldCheck size={22} />
                <h2>Privacy is part of your workspace.</h2>
                <p>
                  Projects, terminal contents, and provider credentials stay on
                  your device.
                </p>
                <label className="la-toggle">
                  <input
                    type="checkbox"
                    checked={usage}
                    onChange={(event) => setUsage(event.target.checked)}
                  />
                  <span>
                    <strong>Share basic feature usage</strong>
                    <small>
                      Feature names and counts. Never prompts, code, or terminal
                      output.
                    </small>
                  </span>
                </label>
              </section>
            </div>
          </div>
        ) : (
          <section className="la-card">
            <div className="la-section-heading">
              <div>
                <h2>Signed-in devices</h2>
                <p>Review where your Lina account is being used.</p>
              </div>
              <Badge>{account.sessions.length} sessions</Badge>
            </div>
            <div className="la-device-list">
              {account.sessions.map((session) => (
                <div className="la-device" key={session.id}>
                  <span className="la-device-icon">
                    {session.platform === 'ios' ? (
                      <Smartphone size={21} />
                    ) : (
                      <Laptop size={21} />
                    )}
                  </span>
                  <div>
                    <strong>
                      {session.device}
                      {session.current && (
                        <Badge tone="green">This device</Badge>
                      )}
                    </strong>
                    <p>
                      {session.platform} · {session.lastSeen}
                    </p>
                  </div>
                  <button
                    className="la-button"
                    onClick={() => setConfirm(session.id)}
                  >
                    {session.current ? 'Sign out' : 'Revoke session'}
                    <ArrowUpRight size={14} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
      {confirm && (
        <Dialog title="Sign out this device?" onClose={() => setConfirm(null)}>
          <p className="la-lede">
            It will need to sign in again. Local projects and provider accounts
            are preserved.
          </p>
          <div className="la-dialog-actions">
            <button className="la-button" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              className="la-button la-button--primary"
              onClick={() => {
                const current = account.sessions.find(
                  (s) => s.id === confirm,
                )?.current;
                current ? onSignOut() : onRevoke(confirm);
                setConfirm(null);
              }}
            >
              Sign out device
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
