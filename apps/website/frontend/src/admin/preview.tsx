import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ShieldCheck } from 'lucide-react';
import { PreviewBar } from '../account/ui';
import { AdminWorkspace } from './AdminWorkspace';
import { AdminAccessGate, type AdminGateMode } from './AdminAccessGate';
import { AdminMfaSetup } from './AdminMfaSetup';
import { applyPreviewChange, seedDirectory, type Change } from './model';
import '../account/account.css';

function AdminPreview() {
  const [directory, setDirectory] = useState(seedDirectory),
    [mode, setMode] = useState('owner'),
    [error, setError] = useState(''),
    [toast, setToast] = useState(''),
    [generation, setGeneration] = useState(0);
  function reset() {
    setDirectory(seedDirectory());
    setMode('owner');
    setError('');
    setToast('');
    setGeneration((n) => n + 1);
  }
  function change(value: Change) {
    try {
      if (mode === 'error')
        throw new Error('Couldn’t save this change. Try again.');
      const next = applyPreviewChange(directory, value);
      setDirectory(next);
      setError('');
      setToast('Change saved to the sample directory.');
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t save this change.');
      return false;
    }
  }
  // All session checks below are fixtures, never authentication or authorization.
  const gated = ['signed-out', 'member', 'mfa', 'offline', 'loading'].includes(
    mode,
  );
  return (
    <div className="la-root">
      <PreviewBar onReset={reset}>
        <label>
          Scenario
          <select
            value={mode}
            onChange={(event) => {
              setMode(event.target.value);
              setError('');
              setToast('');
            }}
          >
            <option value="owner">Owner session</option>
            <option value="signed-out">Signed out</option>
            <option value="member">No admin access</option>
            <option value="mfa">MFA required</option>
            <option value="mfa-setup">Authenticator setup</option>
            <option value="recovery">Recovery codes</option>
            <option value="offline">Connection error</option>
            <option value="loading">Loading</option>
            <option value="error">Save fails</option>
            <option value="empty">Empty directory</option>
          </select>
        </label>
      </PreviewBar>
      {['mfa-setup', 'recovery'].includes(mode) ? (
        <AdminMfaSetup
          key={mode}
          recovery={mode === 'recovery'}
          setupKey="JBSWY3DPEHPK3PXP"
          codes={[
            'DEMO-1111',
            'DEMO-2222',
            'DEMO-3333',
            'DEMO-4444',
            'DEMO-5555',
            'DEMO-6666',
          ]}
          onContinue={() =>
            setMode(mode === 'mfa-setup' ? 'recovery' : 'owner')
          }
        />
      ) : gated ? (
        <AdminAccessGate
          mode={mode as AdminGateMode}
          onContinue={() => setMode(mode === 'signed-out' ? 'mfa' : 'owner')}
          onOtherAccount={() => setMode('signed-out')}
        />
      ) : (
        <>
          <AdminWorkspace
            key={generation}
            directory={mode === 'empty' ? { users: [], audit: [] } : directory}
            onChange={change}
            error={error}
            onClearError={() => setError('')}
            onSignOut={() => {
              setMode('signed-out');
              setToast('');
            }}
          />
          {toast && (
            <div className="la-toast" role="status">
              <ShieldCheck size={16} />
              {toast}
              <button
                aria-label="Dismiss notification"
                onClick={() => setToast('')}
              >
                ×
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<AdminPreview />);
