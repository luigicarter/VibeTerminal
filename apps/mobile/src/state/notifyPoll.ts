import { fetchState } from '../api/client';
import { recordState } from './notificationStore';
import type { NotificationItem } from './notificationStore';
import { loadPairing } from './storage';

/**
 * One pass of the background check, with no native module in sight.
 *
 * Android will not let an app poll in the background — the scheduler wakes it,
 * at best every fifteen minutes, and gives it a moment to do something. So this
 * is deliberately one request: `/api/state?wait=0`, compared against the stored
 * snapshot, notifications posted, snapshot replaced. No long poll, no retry, no
 * loop; if the desktop is asleep or the phone is on another network the pass
 * simply fails and the next wake tries again.
 *
 * The poster is a parameter rather than an import so this module stays free of
 * `expo-notifications`, which lets the task body be reasoned about (and run)
 * without a native runtime.
 */

export type PollOutcome = 'notified' | 'quiet' | 'unpaired' | 'failed';

export async function runNotificationPoll(
  post: (items: NotificationItem[]) => Promise<void>
): Promise<PollOutcome> {
  let pairing;
  try {
    pairing = await loadPairing();
  } catch {
    return 'failed';
  }
  if (!pairing) return 'unpaired';

  try {
    // `revision: 0` and `wait: 0` means "answer now with whatever you have",
    // which is the only shape of request that fits inside a background wake.
    const state = await fetchState(
      { host: pairing.host, port: pairing.port, code: pairing.code },
      { revision: 0, wait: 0 }
    );
    const items = await recordState(state);
    if (!items.length) return 'quiet';
    await post(items);
    return 'notified';
  } catch {
    return 'failed';
  }
}
