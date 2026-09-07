import type { VoiceApi, VoiceResult } from './types';
// A hold shorter than this is a stray tap on the key, not a request.
export const TAP_MS = 300;
type Result = Partial<VoiceResult> | undefined;
let nextHold = 0;
const holdPrefix = Math.random().toString(36).slice(2);
// Shared gesture implementation; each caller owns its hold and receives unique IDs.
export function pressToTalk(api: VoiceApi, onResult: (result: Result) => void = () => {}) {
  let since = 0, holdId = '';
  const send = (pushToTalk: string, after: (result: Result) => void = onResult) =>
    void api.configure({ pushToTalk, holdId }).then(after, error => after({ ok: false, error: String(error) }));
  return {
    active: () => since > 0,
    start() {
      if (since) return;
      since = Date.now();
      const startedId = holdId = `${holdPrefix}-${++nextHold}`;
      send('start', result => { if (result?.ok === false && holdId === startedId) since = 0; onResult(result); });
    },
    release() { if (!since) return; const held = Date.now() - since; since = 0; send(held < TAP_MS ? 'cancel' : 'stop'); },
  };
}
