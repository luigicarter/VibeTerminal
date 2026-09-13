import { useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  ExternalLink,
  KeyRound,
  Laptop,
  Loader2,
  LockKeyhole,
  LogOut,
  Mail,
  RefreshCw,
  Route,
  ShieldCheck,
  Terminal,
  WifiOff,
} from 'lucide-react';
import logo from '../assets/lina-logo.svg';
import type { AccountViewProps } from './types';
import { accessSummary, presentationScreen, tierLabels } from './model';

const copy = {
  welcome: ['Welcome to Lina', 'Sign in to access your workspace.'],
  browser: [
    'Continue in your browser',
    'Finish signing in, then return to Lina.',
  ],
  'browser-error': [
    'Sign-in didn’t finish',
    'Try again, or use a sign-in code from your browser.',
  ],
  verify: [
    'Verify your email',
    'Open the verification email, then check your account again.',
  ],
  pending: [
    'Your account is awaiting approval',
    'Your email is verified. Access will be available once your account is approved.',
  ],
  suspended: [
    'Your access is paused',
    'Contact support to review your account access.',
  ],
  expired: [
    'Your access has expired',
    'Your account is still available. Contact support to renew access.',
  ],
  'offline-expired': [
    'Reconnect to continue',
    'Your offline access has ended. Connect to the internet so Lina can check your account.',
  ],
} as const;

export function AccountView({
  screen: requestedScreen,
  account,
  busy = false,
  error,
  onAction,
}: AccountViewProps) {
  const screen = presentationScreen(requestedScreen, account);
  const [tab, setTab] = useState<'account' | 'devices' | 'privacy'>('account'),
    [manual, setManual] = useState(false),
    [code, setCode] = useState(''),
    [confirm, setConfirm] = useState<string | null>(null);
  const summary = accessSummary(screen, account);
  if (screen !== 'account') {
    const Icon =
      screen === 'welcome'
        ? KeyRound
        : screen === 'browser'
          ? ExternalLink
          : screen === 'browser-error'
            ? RefreshCw
            : screen === 'verify'
              ? Mail
              : screen === 'pending'
                ? Clock3
                : screen === 'offline-expired'
                  ? WifiOff
                  : LockKeyhole;
    const browser = screen === 'browser' || screen === 'browser-error';
    return (
      <section className="da-gate" aria-labelledby="da-gate-title">
        <div className="da-gate-brand">
          <img src={logo} alt="" />
          <span>Lina Terminal</span>
        </div>
        <div className="da-gate-icon">
          <Icon size={23} strokeWidth={1.5} />
        </div>
        <h1 id="da-gate-title">{copy[screen][0]}</h1>
        <p className="da-lede">{copy[screen][1]}</p>
        {[
          'verify',
          'pending',
          'suspended',
          'expired',
          'offline-expired',
        ].includes(screen) && (
          <p className="da-email">
            <Mail size={14} />
            {account.email}
          </p>
        )}
        {error && (
          <p className="da-error" role="alert">
            {error}
          </p>
        )}
        {screen === 'welcome' ? (
          <>
            <button
              className="da-button da-primary da-full"
              onClick={() => onAction({ type: 'start-login', mode: 'sign-in' })}
            >
              <ExternalLink size={16} />
              Continue in browser
            </button>
            <button
              className="da-link"
              onClick={() => onAction({ type: 'start-login', mode: 'sign-up' })}
            >
              Create a Lina account
              <ArrowUpRight size={13} />
            </button>
          </>
        ) : browser ? (
          <>
            <div className="da-browser-status" role="status">
              {screen === 'browser' && (
                <Loader2 size={15} className="da-spin" />
              )}
              {screen === 'browser'
                ? 'Waiting for sign-in…'
                : 'No sign-in was completed'}
            </div>
            <button
              className="da-button da-full"
              disabled={busy}
              onClick={() => onAction({ type: 'start-login', mode: 'sign-in' })}
            >
              Open browser again
              <ArrowUpRight size={15} />
            </button>
            <button
              className="da-link"
              aria-expanded={manual}
              onClick={() => setManual(!manual)}
            >
              Use a sign-in code
              <ChevronRight size={13} />
            </button>
            {manual && (
              <form
                className="da-code-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  onAction({ type: 'submit-code', code: code.trim() });
                  setCode('');
                }}
              >
                <label>
                  Sign-in code
                  <input
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    required
                    minLength={32}
                    maxLength={32}
                    placeholder="Paste the code from your browser"
                  />
                </label>
                <button
                  className="da-button da-primary da-full"
                  disabled={busy}
                >
                  Continue
                </button>
              </form>
            )}
            <button
              className="da-link da-muted-link"
              onClick={() => onAction({ type: 'cancel-login' })}
            >
              <ArrowLeft size={13} />
              Cancel sign-in
            </button>
          </>
        ) : (
          <>
            <button
              className="da-button da-primary da-full"
              disabled={busy}
              onClick={() => onAction({ type: 'retry' })}
            >
              {busy ? (
                <>
                  <Loader2 size={15} className="da-spin" />
                  Checking…
                </>
              ) : (
                <>
                  <RefreshCw size={15} />
                  Check access again
                </>
              )}
            </button>
            <button
              className="da-link"
              onClick={() => onAction({ type: 'sign-out' })}
            >
              Use another account
            </button>
          </>
        )}
        {summary.preserveRunningWork && (
          <div className="da-work-preserved">
            <ShieldCheck size={18} />
            <p>
              Running terminals can finish. Your local projects and files are
              preserved.
            </p>
          </div>
        )}
        <footer>
          <ShieldCheck size={13} />
          <span>
            Your projects and AI provider accounts stay on your device.
          </span>
        </footer>
      </section>
    );
  }
  return (
    <section className="da-settings" aria-labelledby="da-account-title">
      <header className="da-settings-header">
        <div>
          <p className="da-eyebrow">LINA TERMINAL</p>
          <h1 id="da-account-title">Your account</h1>
        </div>
        <button className="da-button" onClick={() => setConfirm('sign-out')}>
          <LogOut size={14} />
          Sign out
        </button>
      </header>
      <div className="da-profile">
        <span className="da-avatar">
          {account.name
            .split(' ')
            .map((n) => n[0])
            .join('')}
        </span>
        <div>
          <strong>{account.name}</strong>
          <p>{account.email}</p>
        </div>
        <span className="da-badge">
          <CheckCircle2 size={12} />
          Verified
        </span>
      </div>
      {account.offline && (
        <div className="da-offline">
          <WifiOff size={17} />
          <div>
            <strong>You’re offline</strong>
            <p>
              Your last verified access is available until {account.graceEndsAt}
              . Reconnect to refresh it.
            </p>
          </div>
        </div>
      )}
      <nav className="da-tabs" aria-label="Personal account sections">
        {(['account', 'devices', 'privacy'] as const).map((value) => (
          <button
            key={value}
            aria-current={tab === value ? 'page' : undefined}
            onClick={() => setTab(value)}
          >
            {value === 'account'
              ? 'Access'
              : value[0].toUpperCase() + value.slice(1)}
            {value === 'devices' && <span>{account.devices.length}</span>}
          </button>
        ))}
      </nav>
      {tab === 'account' ? (
        <>
          <div className="da-plan">
            <div>
              <p className="da-eyebrow">CURRENT PLAN</p>
              <span className="da-badge">Active access</span>
            </div>
            <h2>{tierLabels[account.tier]}</h2>
            <p>
              {account.tier === 'orchestrator'
                ? 'Your full workspace, with voice and task coordination.'
                : 'Every terminal and agent mode, in your own workspace.'}
            </p>
            <dl>
              <div>
                <dt>Access expires</dt>
                <dd>{account.expiresAt || 'No expiry set'}</dd>
              </div>
            </dl>
          </div>
          <section className="da-feature-section">
            <h2>Available in your workspace</h2>
            <div>
              <Terminal size={18} />
              <span>
                <strong>All terminals and agent modes</strong>
                <small>Including Fusion and Open Fusion</small>
              </span>
              <Check size={16} />
            </div>
            <div>
              <Route size={18} />
              <span>
                <strong>Orchestrator and voice</strong>
                <small>
                  {summary.orchestrator
                    ? 'Task routing, follow-ups, and workspace coordination'
                    : 'Available with the Orchestrator plan'}
                </small>
              </span>
              {summary.orchestrator ? (
                <Check size={16} />
              ) : (
                <LockKeyhole size={15} />
              )}
            </div>
          </section>
          <p className="da-footnote">
            AI provider accounts, subscriptions, and usage are separate from
            your Lina plan.
          </p>
        </>
      ) : tab === 'devices' ? (
        <section className="da-device-list">
          <h2>Signed-in devices</h2>
          <p>Revoke a session to require a new sign-in.</p>
          {account.devices.map((device) => (
            <article key={device.id}>
              <span className="da-device-icon">
                <Laptop size={20} />
              </span>
              <div>
                <strong>
                  {device.name}
                  {device.current && <small>This device</small>}
                </strong>
                <p>
                  {device.platform} · {device.seen}
                </p>
              </div>
              <button
                className="da-button"
                onClick={() => setConfirm(device.id)}
              >
                {device.current ? 'Sign out' : 'Revoke'}
              </button>
            </article>
          ))}
        </section>
      ) : (
        <section className="da-privacy">
          <ShieldCheck size={27} />
          <h2>Your workspace stays local.</h2>
          <p>
            Account activity helps you review your sign-ins and connected
            devices. Your terminal contents, prompts, files, and provider
            credentials are not included.
          </p>
          <label>
            <input
              type="checkbox"
              checked={account.shareUsage}
              onChange={(event) =>
                onAction({ type: 'set-usage', enabled: event.target.checked })
              }
            />
            <span>
              <strong>Share basic feature usage</strong>
              <small>
                Feature names and usage counts, to help improve Lina.
              </small>
            </span>
          </label>
          <p className="da-footnote">
            This preference is separate from account security and session
            checks.
          </p>
        </section>
      )}
      {confirm && (
        <div className="da-inline-confirm" role="alert">
          <h3>
            {confirm === 'sign-out' ||
            account.devices.find((d) => d.id === confirm)?.current
              ? 'Sign out of Lina?'
              : 'Revoke this device’s session?'}
          </h3>
          <p>
            The device will need to sign in again. Local projects are preserved.
          </p>
          <div>
            <button className="da-button" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              className="da-button da-primary"
              onClick={() => {
                confirm === 'sign-out' ||
                account.devices.find((d) => d.id === confirm)?.current
                  ? onAction({ type: 'sign-out' })
                  : onAction({ type: 'revoke-device', id: confirm });
                setConfirm(null);
              }}
            >
              Confirm sign out
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
