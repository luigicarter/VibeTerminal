import { useEffect, useState } from 'react';
import { bridgeApi, type PairRequest } from './phoneBridgeApi';
import './phoneSettings.css';

// Mounted once near the app root. It renders nothing until a phone asks, and it
// is the only place approval happens: the code is never shown to the network
// before a person on this desktop says yes.
export function PhonePairPrompt(): JSX.Element | null {
  const [requests, setRequests] = useState<PairRequest[]>([]);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    const api = bridgeApi();
    if (!api) return;
    let current = true;
    const add = (request: PairRequest) => setRequests(list =>
      list.some(item => item.requestId === request.requestId) ? list : [...list, request]);
    const stopRequests = api.onPairRequest(request => { if (current) add(request); });
    // Another window (or an expiry) may settle a request this one is showing.
    const stopState = api.onState(status => {
      if (!current) return;
      const open = new Set((status.pending || []).map(item => item.requestId));
      setRequests(list => list.filter(item => open.has(item.requestId)));
    });
    void api.getState().then(status => { if (current) (status.pending || []).forEach(add); }).catch(() => {});
    return () => { current = false; stopRequests(); stopState(); };
  }, []);

  // Drop an offer the moment it can no longer be accepted, without a round trip.
  useEffect(() => {
    if (!requests.length) return;
    const timer = setInterval(() => setRequests(list => list.filter(item => item.expiresAt > Date.now())), 1000);
    return () => clearInterval(timer);
  }, [requests.length]);

  if (!requests.length) return null;
  const request = requests[0];

  async function respond(requestId: string, approve: boolean) {
    const api = bridgeApi();
    if (!api) return;
    setBusy(requestId);
    try { await api.respondPair(requestId, approve); }
    catch { /* The bridge settles it either way; the list is driven by status. */ }
    finally {
      setBusy('');
      setRequests(list => list.filter(item => item.requestId !== requestId));
    }
  }

  return <div className="phone-pair-backdrop" role="presentation">
    <section className="phone-pair-prompt" role="alertdialog" aria-modal="true" aria-labelledby="phone-pair-title">
      <h2 id="phone-pair-title">A phone wants to view this workspace</h2>
      <p className="phone-pair-device"><strong>{request.deviceName}</strong> ({request.platform}) from {request.remoteAddress}</p>
      <p className="settings-description">Allowing lets this phone read your projects, terminals and Orchestrator history. It cannot type into a terminal or send a request.</p>
      {requests.length > 1 && <p className="settings-description">{requests.length - 1} other request{requests.length > 2 ? 's' : ''} waiting.</p>}
      <div className="phone-pair-actions">
        <button type="button" disabled={busy === request.requestId} onClick={() => void respond(request.requestId, false)}>Deny</button>
        <button type="button" className="phone-pair-allow" disabled={busy === request.requestId} onClick={() => void respond(request.requestId, true)}>Allow</button>
      </div>
    </section>
  </div>;
}
