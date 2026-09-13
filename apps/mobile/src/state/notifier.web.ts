import type { NotificationItem } from './notificationStore';

/**
 * The browser build has no notifications.
 *
 * `expo-notifications`, `expo-task-manager` and `expo-background-task` are all
 * native modules; a browser has neither an Android channel nor a background
 * scheduler, and the web build exists for one reason — `npm run capture`, which
 * photographs screens. So Metro picks this file on web and the whole delivery
 * layer disappears from that bundle rather than being guarded at every call.
 *
 * The Settings toggle still renders here; it reads `unsupported` and says so.
 */

export type PermissionState = 'granted' | 'denied' | 'undetermined' | 'unsupported';

export const NOTIFY_TASK = 'lina-notify-poll';
export const MINIMUM_INTERVAL_MINUTES = 15;

export function notificationsSupported(): boolean {
  return false;
}

export async function prepareNotifications(): Promise<void> {}

export async function getPermissionState(): Promise<PermissionState> {
  return 'unsupported';
}

export async function askPermission(): Promise<PermissionState> {
  return 'unsupported';
}

export async function postNotifications(_items: NotificationItem[]): Promise<void> {}

export async function tapFeedback(): Promise<void> {}

export function addNotificationTapListener(_handler: (sessionId: string | null) => void): () => void {
  return () => {};
}

export async function consumeInitialTap(): Promise<string | null> {
  return null;
}

export async function setBackgroundPollEnabled(_enabled: boolean): Promise<boolean> {
  return false;
}

export async function triggerBackgroundPollForTesting(): Promise<boolean> {
  return false;
}
