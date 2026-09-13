import { Loader2, LockKeyhole, ShieldCheck, WifiOff } from 'lucide-react';
import { Brand } from '../account/ui';

export type AdminGateMode =
  'signed-out' | 'member' | 'mfa' | 'offline' | 'loading';
export function AdminAccessGate({
  mode,
  onContinue,
  onOtherAccount,
}: {
  mode: AdminGateMode;
  onContinue(): void;
  onOtherAccount(): void;
}) {
  const Icon =
    mode === 'loading'
      ? Loader2
      : mode === 'offline'
        ? WifiOff
        : mode === 'mfa'
          ? ShieldCheck
          : LockKeyhole;
  const title = {
    'signed-out': 'Sign in to administration',
    member: 'Administrator access required',
    mfa: 'Verify your administrator session',
    offline: 'We couldn’t load administration',
    loading: 'Loading accounts',
  }[mode];
  const description = {
    'signed-out': 'Use an account with administrator access.',
    member: 'This account can use Lina, but it cannot manage other accounts.',
    mfa: 'Enter the code from your authenticator app.',
    offline: 'Your changes have not been submitted. Reconnect and try again.',
    loading: 'Your account directory is being prepared.',
  }[mode];
  return (
    <main className="la-admin-gate">
      <Brand subtitle="Administration" />
      <section className="la-auth-card">
        <div className="la-auth-symbol">
          <Icon className={mode === 'loading' ? 'la-spin' : ''} size={25} />
        </div>
        <h1>{title}</h1>
        <p className="la-lede">{description}</p>
        {mode === 'signed-out' ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onContinue();
            }}
          >
            <label className="la-field">
              Email address
              <input
                type="email"
                name="email"
                autoComplete="username"
                defaultValue="morgan@example.test"
                required
              />
            </label>
            <label className="la-field">
              Password
              <input
                type="password"
                name="password"
                autoComplete="current-password"
                required
                maxLength={128}
              />
            </label>
            <button className="la-button la-button--primary la-full">
              Continue
            </button>
          </form>
        ) : mode === 'mfa' ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onContinue();
            }}
          >
            <label className="la-field">
              Authentication code
              <input
                className="la-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                placeholder="000000"
              />
            </label>
            <button className="la-button la-button--primary la-full">
              Verify session
            </button>
          </form>
        ) : mode === 'member' ? (
          <button
            className="la-button la-button--primary"
            onClick={onOtherAccount}
          >
            Use another account
          </button>
        ) : mode === 'offline' ? (
          <button className="la-button la-button--primary" onClick={onContinue}>
            Retry
          </button>
        ) : (
          <p className="la-small" role="status">
            Loading…
          </p>
        )}
      </section>
    </main>
  );
}
