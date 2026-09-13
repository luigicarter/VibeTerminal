import { useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock3,
  Eye,
  EyeOff,
  KeyRound,
  Mail,
  ShieldCheck,
  WifiOff,
  LockKeyhole,
  Loader2,
} from 'lucide-react';
import type { AuthScreen as Screen, AuthSubmission } from './types';
import { Brand } from './ui';

export interface AuthScreenProps {
  screen: Screen;
  email: string;
  busy?: boolean;
  error?: string;
  onNavigate(screen: Screen): void;
  onSubmit(value: AuthSubmission): void;
  onRetry(): void;
}
const copy = {
  'sign-in': ['Welcome back', 'Sign in to your Lina account.'],
  'sign-up': [
    'A workspace of your own',
    'Create your account to get started with Lina.',
  ],
  verify: ['Check your inbox', 'Verify your email address to continue.'],
  forgot: [
    'Forgot your password?',
    'We’ll send you a link to choose a new one.',
  ],
  'reset-sent': [
    'Check your inbox',
    'If an account exists for this address, a reset link is on its way.',
  ],
  reset: [
    'Choose a new password',
    'Your new password will sign out your other sessions.',
  ],
  mfa: ['One more step', 'Enter the code from your authenticator app.'],
  pending: [
    'Your account is ready for review',
    'Your email is verified. We’ll let you know when your access is approved.',
  ],
  suspended: [
    'Your access is paused',
    'You can still manage your account. Contact support to review your access.',
  ],
  expired: [
    'Your access has expired',
    'Your account and local projects are still yours. Contact support to renew access.',
  ],
  offline: ['We couldn’t connect', 'Check your connection, then try again.'],
} as const;

export function AuthScreen(props: AuthScreenProps) {
  const {
    screen,
    email,
    busy = false,
    error,
    onNavigate,
    onSubmit,
    onRetry,
  } = props;
  const [visible, setVisible] = useState(false),
    [validation, setValidation] = useState('');
  const formScreen = ['sign-in', 'sign-up', 'forgot', 'reset', 'mfa'].includes(
    screen,
  );
  const passwordScreen = ['sign-in', 'sign-up', 'reset'].includes(screen);
  const Icon =
    screen === 'pending'
      ? Clock3
      : screen === 'offline'
        ? WifiOff
        : screen === 'suspended' || screen === 'expired'
          ? LockKeyhole
          : screen === 'mfa'
            ? ShieldCheck
            : ['verify', 'reset-sent'].includes(screen)
              ? Mail
              : KeyRound;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidation('');
    const data = new FormData(event.currentTarget);
    const password = String(data.get('password') || ''),
      confirm = String(data.get('confirm') || ''),
      code = String(data.get('code') || '').trim();
    if (passwordScreen && password.length < (screen === 'sign-in' ? 1 : 12))
      return setValidation('Use at least 12 characters for your password.');
    if (screen === 'reset' && password !== confirm)
      return setValidation('The passwords don’t match.');
    if (screen === 'mfa' && !/^\d{6}$/.test(code))
      return setValidation('Enter a six-digit authenticator code.');
    onSubmit({
      email: String(data.get('email') || email),
      name: String(data.get('name') || ''),
      password,
      code,
    });
  }
  return (
    <div className="la-auth-layout">
      <aside className="la-auth-intro">
        <Brand />
        <div>
          <p className="la-eyebrow">YOUR LOCAL WORKSPACE</p>
          <h1>
            A home for
            <br />
            your next build.
          </h1>
          <p>
            Your terminals, agents, and projects.
            <br />
            One place to make progress.
          </p>
          <ul>
            <li>
              <Check size={17} />
              All your agent workflows together
            </li>
            <li>
              <Check size={17} />
              Your projects stay on your device
            </li>
            <li>
              <Check size={17} />
              Your choice of AI providers
            </li>
          </ul>
        </div>
        <small>Lina Terminal</small>
      </aside>
      <main className="la-auth-main">
        <div className="la-mobile-brand">
          <Brand />
        </div>
        <section className="la-auth-card" aria-labelledby="auth-title">
          <div className="la-auth-symbol">
            <Icon size={23} strokeWidth={1.5} />
          </div>
          <h1 id="auth-title">{copy[screen][0]}</h1>
          <p className="la-lede">{copy[screen][1]}</p>
          {['verify', 'reset-sent', 'pending'].includes(screen) && (
            <div className="la-email-summary">
              <Mail size={16} />
              {email}
            </div>
          )}
          {(validation || error) && (
            <p className="la-error" role="alert">
              {validation || error}
            </p>
          )}
          {formScreen ? (
            <form onSubmit={submit} key={screen}>
              {screen === 'sign-up' && (
                <label className="la-field">
                  Your name
                  <input
                    name="name"
                    autoComplete="name"
                    required
                    maxLength={80}
                    placeholder="Avery Chen"
                  />
                </label>
              )}
              {['sign-in', 'sign-up', 'forgot'].includes(screen) && (
                <label className="la-field">
                  Email address
                  <input
                    type="email"
                    name="email"
                    autoComplete="email"
                    defaultValue={email}
                    required
                    maxLength={254}
                  />
                </label>
              )}
              {passwordScreen && (
                <label className="la-field">
                  <span>
                    Password
                    {screen === 'sign-in' && (
                      <button
                        type="button"
                        className="la-text-button"
                        onClick={() => onNavigate('forgot')}
                      >
                        Forgot password?
                      </button>
                    )}
                  </span>
                  <div className="la-password">
                    <input
                      name="password"
                      type={visible ? 'text' : 'password'}
                      autoComplete={
                        screen === 'sign-in'
                          ? 'current-password'
                          : 'new-password'
                      }
                      required
                      maxLength={128}
                      minLength={screen === 'sign-in' ? 1 : 12}
                    />
                    <button
                      type="button"
                      className="la-icon-button"
                      aria-label={visible ? 'Hide password' : 'Show password'}
                      onClick={() => setVisible(!visible)}
                    >
                      {visible ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                  </div>
                  {screen !== 'sign-in' && (
                    <small>At least 12 characters.</small>
                  )}
                </label>
              )}
              {screen === 'reset' && (
                <label className="la-field">
                  Confirm password
                  <input
                    name="confirm"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={12}
                    maxLength={128}
                  />
                </label>
              )}
              {screen === 'mfa' && (
                <label className="la-field">
                  Authentication code
                  <input
                    className="la-code"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    placeholder="000000"
                    required
                  />
                </label>
              )}
              <button
                className="la-button la-button--primary la-full"
                disabled={busy}
                type="submit"
              >
                {busy ? (
                  <>
                    <Loader2 className="la-spin" size={17} />
                    Please wait
                  </>
                ) : (
                  <>
                    {screen === 'sign-up'
                      ? 'Create account'
                      : screen === 'forgot'
                        ? 'Send reset link'
                        : screen === 'reset'
                          ? 'Save new password'
                          : screen === 'mfa'
                            ? 'Verify and continue'
                            : 'Sign in'}
                    <ArrowRight size={17} />
                  </>
                )}
              </button>
              {screen === 'sign-up' && (
                <p className="la-form-note">
                  After email verification, your account will be reviewed for
                  access.
                </p>
              )}
            </form>
          ) : (
            <div className="la-auth-actions">
              {screen === 'pending' && (
                <div className="la-checklist">
                  <p>
                    <CheckCircle2 size={17} />
                    Email verified
                  </p>
                  <p>
                    <Clock3 size={17} />
                    Waiting for account approval
                  </p>
                </div>
              )}
              <button
                className="la-button la-button--primary la-full"
                onClick={onRetry}
                disabled={busy}
              >
                {busy ? (
                  <Loader2 size={17} className="la-spin" />
                ) : screen === 'verify' ? (
                  'I’ve verified my email'
                ) : screen === 'reset-sent' ? (
                  'Resend reset link'
                ) : screen === 'pending' ? (
                  'Check access'
                ) : (
                  'Try again'
                )}
              </button>
              {screen === 'verify' && (
                <button
                  className="la-button la-full"
                  onClick={() => onSubmit({ email })}
                  disabled={busy}
                >
                  Resend verification email
                </button>
              )}
            </div>
          )}
          <div className="la-auth-footer">
            {screen === 'sign-in' ? (
              <>
                New to Lina?{' '}
                <button onClick={() => onNavigate('sign-up')}>
                  Create an account
                </button>
              </>
            ) : screen === 'sign-up' ? (
              <>
                Already have an account?{' '}
                <button onClick={() => onNavigate('sign-in')}>Sign in</button>
              </>
            ) : (
              <button onClick={() => onNavigate('sign-in')}>
                <ArrowLeft size={14} />
                Back to sign in
              </button>
            )}
          </div>
          <p className="la-privacy-note">
            <ShieldCheck size={14} />
            Your AI provider accounts remain separate.
          </p>
        </section>
      </main>
    </div>
  );
}
