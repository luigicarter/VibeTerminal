import { useCallback, useEffect, useState } from 'react';
import { bridgeApi, type MobileBridgeApi, type MobileBridgeStatus } from './phoneBridgeApi';
import './phoneSettings.css';

export type { MobileBridgeStatus };

const when = (at: number) => {
  try { return new Date(at).toLocaleString(); } catch { return ''; }
};

export function PhoneSettings(): JSX.Element {
  const [status, setStatus] = useState<MobileBridgeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [showFallback, setShowFallback] = useState(false);

  useEffect(() => {
    const api = bridgeApi();
    if (!api) { setNote('Phone connections are unavailable in this window.'); return; }
    let current = true;
    void api.getState().then(value => { if (current) setStatus(value); })
      .catch(error => { if (current) setNote(String(error?.message || error)); });
    const stop = api.onState(value => { if (current) setStatus(value); });
    return () => { current = false; stop(); };
  }, []);

  const act = useCallback(async (operation: (api: MobileBridgeApi) => Promise<unknown>, success: string) => {
    const api = bridgeApi();
    if (!api) return;
    setBusy(true); setNote('');
    try { await operation(api); setStatus(await api.getState()); setNote(success); }
    catch (error) { setNote(String((error as Error)?.message || error)); }
    finally { setBusy(false); }
  }, []);

  const enabled = status?.enabled === true;
  const addresses = status?.addresses ?? [];
  const pending = status?.pending ?? [];
  const devices = status?.devices ?? [];
  const state = !status ? 'Loading…' : status.listening ? 'On' : enabled ? 'Unavailable' : 'Off';
  const statusLine = !status ? 'Checking…'
    : status.listening ? `Listening on ${addresses[0] || status.host}:${status.port}`
    : status.error ? status.error
    : enabled ? 'Starting…'
    : 'Off';

  return <section className="settings-section phone-settings">
    <div className="settings-section-heading"><h3>Phone</h3><span>{state}</span></div>
    <p className="settings-description">Let the Lina phone app on this network read your projects, terminals and Orchestrator history. This connection is read&#8209;only: the phone cannot type into a terminal, interrupt a session or send an Orchestrator request.</p>
    <label className="phone-check">
      <input type="checkbox" checked={enabled} disabled={busy || !status}
        onChange={event => void act(api => api.setEnabled(event.target.checked), event.target.checked ? 'Phone connections allowed.' : 'Phone connections turned off.')}/>
      Allow phone connections on this network
    </label>

    {enabled && status && <div className="phone-details">
      <p className="settings-description">Open the Lina app on your phone. It finds this computer on the network by itself; approve it here when it asks.</p>
      {status.autoApprove && <p className="phone-status" role="status">Automatic approval is on for testing. Every phone that asks is allowed without this prompt.</p>}

      {pending.length > 0 && <div className="phone-field">
        <span className="phone-label">Waiting for approval</span>
        <ul className="phone-list">{pending.map(request => <li key={request.requestId} className="phone-pending-row">
          <span><strong>{request.deviceName}</strong> ({request.platform}) from {request.remoteAddress}</span>
          <span className="phone-pending-actions">
            <button type="button" disabled={busy} onClick={() => void act(api => api.respondPair(request.requestId, false), 'Phone denied.')}>Deny</button>
            <button type="button" className="phone-pair-allow" disabled={busy} onClick={() => void act(api => api.respondPair(request.requestId, true), 'Phone allowed.')}>Allow</button>
          </span>
        </li>)}</ul>
      </div>}

      <div className="phone-field">
        <span className="phone-label">Allowed phones</span>
        {devices.length
          ? <ul className="phone-list">{devices.slice().reverse().map(device => <li key={`${device.deviceName}:${device.platform}:${device.approvedAt}`}>
              <strong>{device.deviceName}</strong> ({device.platform}) &middot; {when(device.approvedAt)}
            </li>)}</ul>
          : <p className="settings-description">No phone has been allowed yet.</p>}
        <p className="settings-description">Creating a new code signs every phone out; they each have to be allowed again.</p>
      </div>

      <p className="phone-status" role="status">{statusLine}</p>

      <button type="button" className="phone-fallback-toggle" aria-expanded={showFallback} onClick={() => setShowFallback(value => !value)}>
        {showFallback ? 'Hide manual setup' : 'Connect manually instead'}
      </button>
      {showFallback && <div className="phone-fallback">
        <p className="settings-description">If the phone cannot find this computer by itself, open Settings in the phone app and enter the address, port and code.</p>
        <div className="phone-field">
          <span className="phone-label">Address</span>
          {addresses.length
            ? <ul className="phone-addresses">{addresses.map(address => <li key={address}><code>{address}</code></li>)}</ul>
            : <p className="settings-description">No network address was found. Connect this computer to Wi&#8209;Fi or Ethernet.</p>}
        </div>
        <div className="phone-field"><span className="phone-label">Port</span><code>{status.port}</code></div>
        <div className="phone-field">
          <span className="phone-label">Pairing code</span>
          <div className="phone-code-row">
            <code className="phone-code" aria-label="Pairing code">{status.code}</code>
            <button type="button" disabled={busy} onClick={() => void act(api => api.regenerateCode(), 'New pairing code. Every phone has to be allowed again.')}>New code</button>
          </div>
        </div>
      </div>}
    </div>}
    {note && <p className="settings-description" role="status">{note}</p>}
  </section>;
}
