import type { BridgeState } from '../api/types';
import {
  compactSnapshot,
  diffNotifications,
  expandSnapshot,
  snapshotFromState,
} from './notifications';
import { readItem, removeItem, writeItem } from './storage';

/**
 * The memory behind the notification rule.
 *
 * `notifications.js` decides what a *difference* is worth telling somebody
 * about; this is where the other half of that difference is kept. One snapshot
 * of the last state the phone saw, persisted, so the comparison survives the app
 * being killed — which it has to, because the background task runs in a process
 * that was not alive a moment ago.
 *
 * Everything that can notify goes through `recordState`, and it is serialized:
 * the long poll and the background task can both be awake at once, and two
 * comparisons against the same stored snapshot would notify twice for one
 * event.
 */

export type NotificationSnapshot = ReturnType<typeof snapshotFromState>;
export type NotificationItem = ReturnType<typeof diffNotifications>[number];

const ENABLED_KEY = 'lina.notify.enabled.v1';
const SNAPSHOT_KEY = 'lina.notify.snapshot.v1';

/** Kept alongside the stored copy so the common case costs no storage read. */
let cached: NotificationSnapshot | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** Run `job` after everything already queued, whatever happened to those. */
function serialize<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job);
  queue = next.catch(() => undefined);
  return next;
}

/**
 * Whether the person wants to be told. `null` means they have never been asked,
 * which is not the same as "no": the toggle defaults on once the OS permission
 * has been granted.
 */
export async function loadNotifyEnabled(): Promise<boolean | null> {
  const raw = await readItem(ENABLED_KEY);
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  return null;
}

export async function saveNotifyEnabled(enabled: boolean): Promise<void> {
  await writeItem(ENABLED_KEY, enabled ? 'on' : 'off');
}

async function loadSnapshot(): Promise<NotificationSnapshot | null> {
  if (cached) return cached;
  const raw = await readItem(SNAPSHOT_KEY);
  if (!raw) return null;
  try {
    cached = expandSnapshot(JSON.parse(raw));
  } catch {
    cached = null;
  }
  return cached;
}

async function saveSnapshot(snapshot: NotificationSnapshot): Promise<void> {
  cached = snapshot;
  await writeItem(SNAPSHOT_KEY, JSON.stringify(compactSnapshot(snapshot)));
}

/**
 * Compare one `/api/state` body against the last one anything saw, store it as
 * the new baseline, and return what that difference is worth saying.
 *
 * The first call after a pairing returns nothing at all: there is no previous
 * snapshot, and a desktop's existing terminals are not news.
 */
export function recordState(
  state: BridgeState | null,
  options: { orchestratorSnippet?: string; now?: number } = {}
): Promise<NotificationItem[]> {
  return serialize(async () => {
    if (!state) return [];
    const previous = await loadSnapshot();
    const next = snapshotFromState(state, options);
    const items = diffNotifications(previous, next);
    await saveSnapshot(next);
    return items;
  });
}

/** Forget the baseline — a different desktop's terminals are different news. */
export function resetNotificationState(): Promise<void> {
  return serialize(async () => {
    cached = null;
    await removeItem(SNAPSHOT_KEY);
  });
}
