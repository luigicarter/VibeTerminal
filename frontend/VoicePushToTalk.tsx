import { useEffect } from 'react';
import type { VoiceApi } from './voice/types';
import { pressToTalk } from './voice/pushToTalk';
// Space talks only while the microphone is open and no terminal or field is focused.
const TALKABLE = ['listening', 'recording', 'awaiting-answer', 'speaking'];
const typing = (target: EventTarget | null) => {
  const element = target instanceof HTMLElement ? target : null;
  return !!element && (element.isContentEditable || !!element.closest('[data-pane-id], input, textarea, select, [role="textbox"], [contenteditable="true"]'));
};
// Mounted once next to the indicator; owns no state the main window can see.
export default function VoicePushToTalk() {
  const api = (window.vibe as unknown as { voice?: VoiceApi }).voice;
  useEffect(() => {
    if (!api) return;
    let phase = 'off', alive = true, received = false;
    const off = api.onState(next => { received = true; if (alive) phase = next.phase; });
    void api.getState().then(next => { if (alive && !received) phase = next.phase; }).catch(() => { /* The indicator reports voice failures. */ });
    const hold = pressToTalk(api);
    const down = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.ctrlKey || event.altKey || event.metaKey) return;
      // A held key repeats; keep swallowing it so the focused control cannot activate.
      if (hold.active()) { event.preventDefault(); return; }
      if (event.repeat || typing(event.target) || !TALKABLE.includes(phase)) return;
      event.preventDefault(); hold.start();
    };
    const up = (event: KeyboardEvent) => { if (event.code === 'Space' && hold.active()) { event.preventDefault(); hold.release(); } };
    const away = () => { if (hold.active()) hold.release(); };
    const hidden = () => { if (document.hidden) away(); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    window.addEventListener('blur', away); document.addEventListener('visibilitychange', hidden);
    return () => {
      alive = false; off(); away();
      window.removeEventListener('keydown', down); window.removeEventListener('keyup', up);
      window.removeEventListener('blur', away); document.removeEventListener('visibilitychange', hidden);
    };
  }, [api]);
  return null;
}
