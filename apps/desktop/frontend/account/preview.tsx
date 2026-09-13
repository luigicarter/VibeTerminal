import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FlaskConical, Terminal, Minus, Square, X } from 'lucide-react';
import { AccountView } from './AccountView';
import { initialAccount, scenes } from './model';
import type {
  AccountAction,
  AccountPresentation,
  AccountScreen,
} from './types';
import './account.css';

function DesktopPreview() {
  const [screen, setScreen] = useState<AccountScreen>('welcome'),
    [account, setAccount] = useState<AccountPresentation>(initialAccount),
    [scene, setScene] = useState('Sign in'),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  function choose(value: string) {
    clearTimeout(timer.current);
    const next = scenes[value];
    setScene(value);
    setScreen(next.screen);
    setAccount({
      ...initialAccount,
      ...next.patch,
      devices: initialAccount.devices.map((d) => ({ ...d })),
    });
    setBusy(false);
    setNotice('');
    setError('');
  }
  function action(value: AccountAction) {
    setError('');
    if (value.type === 'start-login') {
      setScreen('browser');
      setScene('Waiting for browser');
      setNotice(
        `Browser ${value.mode === 'sign-up' ? 'registration' : 'sign-in'} is simulated. Use “Simulate browser return” to continue.`,
      );
    } else if (value.type === 'cancel-login' || value.type === 'sign-out')
      choose('Sign in');
    else if (value.type === 'submit-code') {
      if (!/^[a-zA-Z0-9_-]{32}$/.test(value.code))
        setError('Paste the full 32-character sign-in code.');
      else {
        choose('Orchestrator account');
        setNotice('Sample sign-in completed. No credentials were exchanged.');
      }
    } else if (value.type === 'revoke-device') {
      setAccount((a) => ({
        ...a,
        devices: a.devices.filter((d) => d.id !== value.id),
      }));
      setNotice('The sample session was revoked.');
    } else if (value.type === 'set-usage') {
      setAccount((a) => ({ ...a, shareUsage: value.enabled }));
      setNotice('Preview preference updated in memory.');
    } else {
      setBusy(true);
      timer.current = setTimeout(() => {
        setBusy(false);
        if (screen === 'verify') choose('Awaiting approval');
        else
          setNotice(
            'No backend check was made. Choose another scenario to review a different access state.',
          );
      }, 400);
    }
  }
  return (
    <div className="da-root">
      <aside className="da-preview-bar" aria-label="Preview controls">
        <span>
          <FlaskConical size={14} />
          <strong>Desktop preview</strong>
          <small>Sample data · disconnected</small>
        </span>
        <div>
          <label>
            Scenario
            <select
              value={scene}
              onChange={(event) => choose(event.target.value)}
            >
              {Object.keys(scenes).map((key) => (
                <option key={key}>{key}</option>
              ))}
            </select>
          </label>
          <button onClick={() => choose('Sign in')}>Reset</button>
          {screen === 'browser' && (
            <button onClick={() => choose('Orchestrator account')}>
              Simulate browser return
            </button>
          )}
        </div>
      </aside>
      <main className="da-preview-stage">
        <div
          className={`da-window ${screen === 'account' ? 'da-window--account' : ''}`}
        >
          <div className="da-window-chrome">
            <span>
              <Terminal size={14} />
              Lina Terminal
            </span>
            <span aria-hidden="true">
              <Minus size={13} />
              <Square size={11} />
              <X size={13} />
            </span>
          </div>
          {notice && (
            <div className="da-notice" role="status">
              {notice}
            </div>
          )}
          <AccountView
            key={screen}
            screen={screen}
            account={account}
            busy={busy}
            error={error}
            onAction={action}
          />
        </div>
        <p className="da-preview-caption">
          A standalone account preview. The installed app, sessions, and local
          workspace are unaffected.
        </p>
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<DesktopPreview />);
