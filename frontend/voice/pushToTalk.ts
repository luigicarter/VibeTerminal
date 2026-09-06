import type { VoiceApi } from './types';
// A hold shorter than this is a stray tap on the key, not a request.
export const TAP_MS = 300;
type Result = { ok?: boolean; error?: string } | undefined;
// One hold at a time, shared by the Space key and the indicator's press-and-hold mic.
export function pressToTalk(api: VoiceApi, onResult: (result: Result) => void = () => {}) {
  let since = 0;
  const send = (pushToTalk: string, after: (result: Result) => void = onResult) =>
    void api.configure({ pushToTalk }).then(after, error => after({ ok: false, error: String(error) }));
  return {
    active: () => since > 0,
    start() {
      if (since) return;
      const at = since = Date.now();
      send('start', result => { if (result?.ok === false && since === at) since = 0; onResult(result); });
    },
    release() { if (!since) return; const held = Date.now() - since; since = 0; send(held < TAP_MS ? 'cancel' : 'stop'); },
  };
}
