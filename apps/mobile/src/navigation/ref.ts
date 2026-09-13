import { createNavigationContainerRef } from '@react-navigation/native';

import type { RootStackParamList } from './types';

/**
 * The one way into the stack from outside React.
 *
 * A notification is tapped by the operating system, not by a screen, so the
 * thing that has to answer it has no `navigation` prop and may not even have
 * mounted yet — a tap can be what started the process. Hence a ref, and a held
 * session id: `openSession` records what to open and tries, and `flushPendingSession`
 * tries again once the container is ready and the paired stack exists.
 *
 * A tap that arrives while the phone is unpaired is dropped rather than queued:
 * there is no `Chat` route to go to, and pairing again is not an invitation to
 * reopen a terminal somebody tapped about hours ago.
 */
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

let pendingSessionId: string | null = null;

export function openSession(sessionId: string | null): void {
  if (!sessionId) return;
  pendingSessionId = sessionId;
  flushPendingSession();
}

export function flushPendingSession(): void {
  if (!pendingSessionId) return;
  if (!navigationRef.isReady()) return;
  const routeNames = navigationRef.getRootState()?.routeNames ?? [];
  // The discovery stack has no terminal to open; drop it rather than hold it.
  if (!routeNames.includes('Chat')) {
    pendingSessionId = null;
    return;
  }
  const sessionId = pendingSessionId;
  pendingSessionId = null;
  navigationRef.navigate('Chat', { sessionId });
}

/** Only for the app's own teardown paths and the tests. */
export function clearPendingSession(): void {
  pendingSessionId = null;
}
