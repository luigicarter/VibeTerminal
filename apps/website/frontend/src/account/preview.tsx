import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthScreen } from './AuthScreen';
import { PersonalAccount } from './PersonalAccount';
import { PreviewBar } from './ui';
import type {
  AuthScreen as Screen,
  AuthSubmission,
  PersonalAccount as Account,
} from './types';
import './account.css';

const initial: Account = {
  name: 'Avery Chen',
  email: 'avery@example.test',
  tier: 'orchestrator',
  status: 'active',
  verified: true,
  expiresAt: 'October 13, 2026',
  sessions: [
    {
      id: 'this',
      device: 'Windows desktop',
      platform: 'Windows',
      lastSeen: 'Active now',
      current: true,
    },
    {
      id: 'mac',
      device: 'MacBook Air',
      platform: 'macOS',
      lastSeen: 'Yesterday at 16:42',
      current: false,
    },
    {
      id: 'phone',
      device: 'iPhone',
      platform: 'ios',
      lastSeen: 'September 11 at 10:18',
      current: false,
    },
  ],
};
function AccountPreview() {
  const [screen, setScreen] = useState<Screen | 'account'>('sign-in'),
    [account, setAccount] = useState(initial),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [error, setError] = useState(''),
    [fail, setFail] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  function navigate(next: Screen | 'account') {
    clearTimeout(timer.current);
    setBusy(false);
    setNotice('');
    setError('');
    setScreen(next);
  }
  function later(work: () => void) {
    setBusy(true);
    setError('');
    timer.current = setTimeout(() => {
      setBusy(false);
      if (fail)
        setError('We couldn’t complete that request. Please try again.');
      else work();
    }, 450);
  }
  function submit(input: AuthSubmission) {
    // Credentials are discarded here. This fixture never authenticates or persists them.
    if (input.email)
      setAccount((value) => ({
        ...value,
        email: input.email!,
        ...(input.name ? { name: input.name } : {}),
      }));
    later(() => {
      if (screen === 'sign-up') navigate('verify');
      else if (screen === 'sign-in') navigate('mfa');
      else if (screen === 'mfa') navigate('account');
      else if (screen === 'forgot') navigate('reset-sent');
      else if (screen === 'reset') {
        navigate('sign-in');
        setNotice('Your password was updated. Sign in to continue.');
      } else
        setNotice(
          'A verification email would be sent. This preview sends no email.',
        );
    });
  }
  const scenes: (Screen | 'account')[] = [
    'sign-in',
    'sign-up',
    'verify',
    'forgot',
    'reset-sent',
    'reset',
    'mfa',
    'pending',
    'suspended',
    'expired',
    'offline',
    'account',
  ];
  return (
    <div className="la-root">
      <PreviewBar
        onReset={() => {
          setAccount(initial);
          setFail(false);
          navigate('sign-in');
        }}
      >
        <label>
          Screen
          <select
            value={screen}
            onChange={(event) =>
              navigate(event.target.value as Screen | 'account')
            }
          >
            {scenes.map((s) => (
              <option value={s} key={s}>
                {s.replace(/-/g, ' ')}
              </option>
            ))}
          </select>
        </label>
        <label className="la-preview-checkbox">
          <input
            type="checkbox"
            checked={fail}
            onChange={(event) => setFail(event.target.checked)}
          />
          Simulate error
        </label>
      </PreviewBar>
      {notice && (
        <div className="la-notice" role="status">
          {notice}
        </div>
      )}
      {screen === 'account' ? (
        <PersonalAccount
          account={account}
          onSignOut={() => navigate('sign-in')}
          onRevoke={(id) => {
            setAccount((value) => ({
              ...value,
              sessions: value.sessions.filter((s) => s.id !== id),
            }));
            setNotice('Session revoked in the preview.');
          }}
        />
      ) : (
        <AuthScreen
          key={screen}
          screen={screen}
          email={account.email}
          busy={busy}
          error={error}
          onNavigate={navigate}
          onSubmit={submit}
          onRetry={() =>
            later(() =>
              screen === 'verify'
                ? navigate('pending')
                : screen === 'pending'
                  ? setNotice(
                      'Still awaiting approval. Use the Screen menu to preview an approved account.',
                    )
                  : screen === 'reset-sent'
                    ? setNotice(
                        'A new reset link would be sent. This preview sends no email.',
                      )
                    : navigate('sign-in'),
            )
          }
        />
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<AccountPreview />);
