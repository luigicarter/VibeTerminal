import * as BackgroundTask from 'expo-background-task';
import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { CHANNEL_ID, CHANNEL_NAME } from './notifications';
import type { NotificationItem } from './notificationStore';
import { runNotificationPoll } from './notifyPoll';

/**
 * Everything about notifications that touches a native module.
 *
 * The rule about *what* to notify lives in `notifications.js` and the memory it
 * compares against lives in `notificationStore.ts`; this is only the delivery —
 * the Android channel, the permission, the post, the tap, and the background
 * wake. `notifier.web.ts` is the same surface as nothing at all, so the browser
 * build (which is how the screenshots are taken) never loads any of this.
 */

export type PermissionState = 'granted' | 'denied' | 'undetermined' | 'unsupported';

/** The name the OS knows the background wake by. */
export const NOTIFY_TASK = 'lina-notify-poll';

/** Android's floor. Asking for less does not make it come sooner. */
export const MINIMUM_INTERVAL_MINUTES = 15;

export function notificationsSupported(): boolean {
  return true;
}

/**
 * Nothing is shown while the app is in front. The screen the person is looking
 * at already says everything a banner would, and covering it with a copy of
 * itself is noise; `bridge.tsx` gives a haptic tap instead.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: false,
    shouldShowList: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/**
 * The background wake, defined at module scope on purpose: when Android starts
 * this app headless to run the task, it loads the JavaScript bundle and expects
 * the task to already be defined by the time loading finishes. Registering it
 * from inside a component would be too late.
 */
TaskManager.defineTask(NOTIFY_TASK, async () => {
  try {
    const outcome = await runNotificationPoll(postNotifications);
    return outcome === 'failed'
      ? BackgroundTask.BackgroundTaskResult.Failed
      : BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

let channelReady = false;

/** The one channel, so a person can silence terminals without silencing the app. */
export async function prepareNotifications(): Promise<void> {
  if (Platform.OS !== 'android' || channelReady) return;
  channelReady = true;
  try {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: CHANNEL_NAME,
      importance: Notifications.AndroidImportance.HIGH,
      description: 'A terminal needs you, a terminal finished, or Lina replied.',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      vibrationPattern: [0, 120, 90, 120],
      enableVibrate: true,
      lightColor: '#FFC466',
      showBadge: true,
    });
  } catch {
    channelReady = false;
  }
}

function toState(status: Notifications.NotificationPermissionsStatus): PermissionState {
  if (status.granted) return 'granted';
  if (status.canAskAgain) return 'undetermined';
  return 'denied';
}

export async function getPermissionState(): Promise<PermissionState> {
  try {
    return toState(await Notifications.getPermissionsAsync());
  } catch {
    return 'unsupported';
  }
}

/**
 * Ask for POST_NOTIFICATIONS. Android 13 and later show a system dialog; older
 * versions grant it at install time and this resolves immediately.
 */
export async function askPermission(): Promise<PermissionState> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return 'granted';
    if (!current.canAskAgain) return 'denied';
    return toState(await Notifications.requestPermissionsAsync());
  } catch {
    return 'unsupported';
  }
}

/** Android identifiers are opaque, but keep them printable for `dumpsys`. */
function identifierFor(key: string): string {
  return `lina-${key.replace(/[^0-9a-zA-Z]+/g, '-').slice(0, 60)}`;
}

/**
 * Post one notification per item, immediately.
 *
 * Two details that are easy to get wrong and were: the Android channel is
 * chosen by the *trigger*, not by the content — `{channelId}` is the "deliver
 * now, on this channel" trigger, and a plain `null` lands everything on
 * expo-notifications' own fallback channel instead of "Terminals". And the
 * identifier is derived from the item's key, so the same event arriving twice
 * replaces its own notification rather than stacking a second one.
 */
export async function postNotifications(items: NotificationItem[]): Promise<void> {
  if (!items.length) return;
  await prepareNotifications();
  const trigger = Platform.OS === 'android' ? { channelId: CHANNEL_ID } : null;
  for (const item of items) {
    try {
      await Notifications.scheduleNotificationAsync({
        identifier: identifierFor(item.key),
        content: {
          title: item.title,
          body: item.body,
          data: { sessionId: item.sessionId, kind: item.kind },
          color: '#FFC466',
          priority: 'high',
          autoDismiss: true,
        },
        trigger,
      });
    } catch {
      /* one notification that will not post is not worth losing the rest */
    }
  }
}

/** The foreground answer to everything above: a tap you feel, and nothing else. */
export async function tapFeedback(): Promise<void> {
  try {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  } catch {
    /* a phone without a motor is not a failure */
  }
}

function sessionIdOf(response: Notifications.NotificationResponse | null): string | null {
  const data = response?.notification?.request?.content?.data as { sessionId?: unknown } | undefined;
  return typeof data?.sessionId === 'string' && data.sessionId ? data.sessionId : null;
}

/** Taps while the app is alive. Returns the unsubscribe. */
export function addNotificationTapListener(handler: (sessionId: string | null) => void): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener(response => {
    handler(sessionIdOf(response));
  });
  return () => subscription.remove();
}

/** The tap that started the app from cold, if that is what started it. */
export async function consumeInitialTap(): Promise<string | null> {
  try {
    const response = await Notifications.getLastNotificationResponseAsync();
    const sessionId = sessionIdOf(response);
    if (response) await Notifications.clearLastNotificationResponseAsync();
    return sessionId;
  } catch {
    return null;
  }
}

/**
 * Register or drop the background wake. Android treats the interval as a floor
 * and a suggestion at once: fifteen minutes is the least it will accept, and it
 * still batches wakes with other apps' and skips them under Doze.
 */
export async function setBackgroundPollEnabled(enabled: boolean): Promise<boolean> {
  try {
    const registered = await TaskManager.isTaskRegisteredAsync(NOTIFY_TASK);
    if (enabled && !registered) {
      await BackgroundTask.registerTaskAsync(NOTIFY_TASK, {
        minimumInterval: MINIMUM_INTERVAL_MINUTES,
      });
      return true;
    }
    if (!enabled && registered) {
      await BackgroundTask.unregisterTaskAsync(NOTIFY_TASK);
      return false;
    }
    return registered;
  } catch {
    return false;
  }
}

/**
 * Run the background wake now. Only a debug build can do this — it is how the
 * background path was verified on the emulator without waiting a quarter of an
 * hour for the scheduler — and it answers false in a release build.
 */
export async function triggerBackgroundPollForTesting(): Promise<boolean> {
  try {
    return await BackgroundTask.triggerTaskWorkerForTestingAsync();
  } catch {
    return false;
  }
}
