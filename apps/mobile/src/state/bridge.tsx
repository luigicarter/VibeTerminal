import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, AppStateStatus } from 'react-native';

import {
  LONG_POLL_WAIT_MS,
  describeError,
  fetchOrchestratorHistory,
  fetchState,
  hello,
  isBridgeError,
} from '../api/client';
import type { BridgeState, Connection, Pairing } from '../api/types';
import { toMillis } from '../api/types';
import {
  loadNotifyEnabled,
  recordState,
  resetNotificationState,
  saveNotifyEnabled,
} from './notificationStore';
import {
  type PermissionState,
  askPermission,
  getPermissionState,
  notificationsSupported,
  postNotifications,
  prepareNotifications,
  setBackgroundPollEnabled,
  tapFeedback,
} from './notifier';
import {
  FRESH_WINDOW_MS as PRESENCE_FRESH_WINDOW_MS,
  connectionTone as computeConnectionTone,
} from './presence';
import { clearPairing, loadPairing, savePairing } from './storage';

/**
 * One long-poll loop owns the desktop connection for the whole app. Screens
 * read `state`; nobody else polls `/api/state`.
 */

export type ConnectionStatus = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline';

export type ConnectionTone = 'connected' | 'reconnecting' | 'failed' | 'connecting' | 'paused';

/** The window in which a successful poll still counts as "connected". */
export const FRESH_WINDOW_MS = PRESENCE_FRESH_WINDOW_MS;

/** The tone the dot shows, from the pure mapping both the app and tests use. */
export function connectionTone(
  status: ConnectionStatus,
  lastSuccessAt: number | null,
  options?: { now?: number; appActive?: boolean }
): ConnectionTone {
  return computeConnectionTone(status, lastSuccessAt, options) as ConnectionTone;
}

const BACKOFF_MS = [1000, 2000, 5000];

/**
 * How long the long poll keeps running after the app goes to the background.
 *
 * Android lets an app that has just been backgrounded finish what it was doing
 * for a while before it is frozen, and a minute of that is worth spending. The
 * loop enforces this by reading the clock, not by setting a timer — see the
 * comment where it does.
 */
export const BACKGROUND_GRACE_MS = 60000;

/** Shown on the discovery screen after the desktop stops accepting the code. */
export const SIGNED_OUT_MESSAGE = 'This desktop signed phones out; pair again.';

export type BridgeContextValue = {
  /** False until the stored pairing has been read back. */
  ready: boolean;
  pairing: Pairing | null;
  connection: Connection | null;
  status: ConnectionStatus;
  /** False while the app is in the background and the poll loop is stopped. */
  appActive: boolean;
  state: BridgeState | null;
  error: string | null;
  lastSuccessAt: number | null;
  /** Text of the most recent Orchestrator message, for the "Ask Lina" row. */
  orchestratorSnippet: string;
  /** Set when the desktop stopped accepting the stored code. */
  authError: string | null;
  clearAuthError: () => void;
  /** True when this desktop build shows terminals but refuses input. */
  readOnly: boolean;
  /** Called when a write route answers 404, which means the same thing. */
  markReadOnly: () => void;
  refresh: () => Promise<void>;
  pair: (pairing: Pairing) => Promise<void>;
  unpair: () => Promise<void>;
  /** False in a browser, where there is no notification to post. */
  notifySupported: boolean;
  /** What the OS says about POST_NOTIFICATIONS. */
  notifyPermission: PermissionState;
  /** The toggle's position: wanted *and* allowed. */
  notifyEnabled: boolean;
  /** Turning it on asks for the permission if it has not been asked for. */
  setNotifyEnabled: (enabled: boolean) => Promise<void>;
};

const BridgeContext = createContext<BridgeContextValue | null>(null);

export function useBridge(): BridgeContextValue {
  const value = useContext(BridgeContext);
  if (!value) throw new Error('useBridge must be used inside <BridgeProvider>');
  return value;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal.aborted) done();
    else signal.addEventListener('abort', done);
  });
}

export function BridgeProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [state, setState] = useState<BridgeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const [orchestratorSnippet, setOrchestratorSnippet] = useState('');
  const [appActive, setAppActive] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [notifyPermission, setNotifyPermission] = useState<PermissionState>('undetermined');
  /** null while the person has never been asked; not the same as "no". */
  const [notifyPreference, setNotifyPreference] = useState<boolean | null>(null);

  const revisionRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const forceRef = useRef(false);
  const waitersRef = useRef<Array<() => void>>([]);
  const runningRef = useRef(false);
  const snippetKeyRef = useRef<string>('');
  const wasOnlineRef = useRef(false);
  const notifyEnabledRef = useRef(false);
  /** When the app last went to the background, or null while it is in front. */
  const backgroundedAtRef = useRef<number | null>(null);

  const notifyEnabled = notifyPreference === true && notifyPermission === 'granted';
  notifyEnabledRef.current = notifyEnabled;

  const settleWaiters = useCallback(() => {
    const waiters = waitersRef.current;
    waitersRef.current = [];
    waiters.forEach(resolve => resolve());
  }, []);

  /** Drop the pairing and go back to discovery, with a reason when there is one. */
  const forget = useCallback(async (reason: string | null) => {
    await clearPairing();
    // Another desktop's terminals are not this desktop's news; start the
    // comparison again rather than notifying about a state nobody has seen.
    await resetNotificationState();
    abortRef.current?.abort();
    revisionRef.current = 0;
    snippetKeyRef.current = '';
    wasOnlineRef.current = false;
    setOrchestratorSnippet('');
    setState(null);
    setError(null);
    setLastSuccessAt(null);
    setStatus('idle');
    setAuthError(reason);
    setPairing(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadPairing()
      .then(stored => {
        if (cancelled) return;
        setPairing(stored);
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const initial = AppState.currentState;
    const active = initial !== 'background' && initial !== 'inactive';
    setAppActive(active);
    backgroundedAtRef.current = active ? null : Date.now();
    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      const nextActive = next === 'active';
      // The clock is read here rather than started as a timer, because Android
      // pauses React Native's JS timers when the app leaves the foreground: a
      // `setTimeout` set on the way out does not fire until the app comes back,
      // which would have left the poll running forever in the background.
      if (nextActive) backgroundedAtRef.current = null;
      else if (backgroundedAtRef.current === null) backgroundedAtRef.current = Date.now();
      setAppActive(nextActive);
    });
    return () => subscription.remove();
  }, []);

  const connection = useMemo<Connection | null>(
    () => (pairing ? { host: pairing.host, port: pairing.port, code: pairing.code } : null),
    [pairing]
  );

  const connectionKey = connection ? `${connection.host}:${connection.port}:${connection.code}` : '';

  useEffect(() => {
    if (!connection) {
      runningRef.current = false;
      settleWaiters();
      return;
    }
    // Going to the background does not stop the poll at once. It keeps running
    // for `BACKGROUND_GRACE_MS`, because the most likely moment for a terminal
    // to want something is right after the phone was put down, and inside that
    // window the person is told the moment it happens rather than at the
    // scheduler's convenience. Past it there is only the background task, and
    // that is a fifteen-minute floor.
    const backgroundDeadline = appActive
      ? null
      : (backgroundedAtRef.current ?? Date.now()) + BACKGROUND_GRACE_MS;
    if (backgroundDeadline !== null && Date.now() >= backgroundDeadline) {
      runningRef.current = false;
      settleWaiters();
      return;
    }
    let cancelled = false;
    runningRef.current = true;
    let failures = 0;
    setStatus(current => (current === 'online' ? current : 'connecting'));

    /**
     * Everything that can notify comes through here, so the foreground path and
     * the background task cannot disagree about what counts as news.
     *
     * The snapshot is recorded whether or not notifications are wanted: a
     * baseline that stops moving while the toggle is off would produce a flood
     * of stale notifications the moment it was turned back on.
     */
    const notifyFrom = async (next: BridgeState) => {
      let snippet = '';
      const orchestrator = next.orchestrator;
      if (orchestrator?.enabled) {
        const key = String(toMillis(orchestrator.lastMessageAt) ?? '');
        // `/api/state` carries no message text, so the pinned "Ask Lina" row's
        // snippet and the "Lina replied" notification both need this one small
        // history read. The key is claimed before the await so a second poll
        // arriving while it is in flight does not pay for it again.
        if (key && key !== snippetKeyRef.current) {
          snippetKeyRef.current = key;
          try {
            const history = await fetchOrchestratorHistory(connection, { limit: 3 });
            const last = [...history.messages].reverse().find(message => (message.text || '').trim());
            snippet = last ? last.text.trim() : '';
            setOrchestratorSnippet(snippet);
          } catch {
            snippetKeyRef.current = '';
          }
        }
      }
      const items = await recordState(next, { orchestratorSnippet: snippet });
      if (!items.length || !notifyEnabledRef.current) return;
      // What is on the screen already says all of this; a banner over it would
      // only be a copy. A tap is what a phone can add.
      if (AppState.currentState === 'active') {
        void tapFeedback();
        return;
      }
      await postNotifications(items);
    };

    const loop = async () => {
      while (!cancelled) {
        // The deadline is checked here, not on a timer, for the reason above:
        // a backgrounded app's timers do not fire. So the loop notices within
        // one poll of the minute rather than exactly on it.
        if (backgroundDeadline !== null && Date.now() >= backgroundDeadline) break;
        const force = forceRef.current;
        forceRef.current = false;
        const controller = new AbortController();
        abortRef.current = controller;
        try {
          const next = await fetchState(connection, {
            revision: revisionRef.current,
            wait: force ? 0 : LONG_POLL_WAIT_MS,
            signal: controller.signal,
          });
          if (cancelled) break;
          revisionRef.current = next.revision;
          failures = 0;
          setState(next);
          setLastSuccessAt(Date.now());
          setStatus('online');
          setError(null);
          settleWaiters();
          try {
            await notifyFrom(next);
          } catch {
            /* a notification that cannot be posted is not a connection failure */
          }
        } catch (caught) {
          if (cancelled) break;
          if (isBridgeError(caught) && caught.kind === 'aborted') {
            settleWaiters();
            continue;
          }
          // The desktop rotated its code: this pairing is dead, not flaky.
          if (isBridgeError(caught) && caught.kind === 'auth') {
            settleWaiters();
            void forget(SIGNED_OUT_MESSAGE);
            break;
          }
          failures += 1;
          setStatus(failures >= 3 ? 'offline' : 'reconnecting');
          setError(describeError(caught, connection));
          settleWaiters();
          await sleep(BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)], controller.signal);
        }
      }
      runningRef.current = false;
      settleWaiters();
    };

    void loop();

    return () => {
      cancelled = true;
      runningRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
    };
    // `connection` is rebuilt from `pairing`; the key keeps the loop from
    // restarting on unrelated renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionKey, appActive, settleWaiters, forget]);

  const refresh = useCallback(() => {
    if (!runningRef.current) return Promise.resolve();
    return new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 12000);
      waitersRef.current.push(() => {
        clearTimeout(timer);
        resolve();
      });
      forceRef.current = true;
      abortRef.current?.abort();
    });
  }, []);

  /** A write route answered 404: this desktop does not take input. */
  const markReadOnly = useCallback(() => {
    setPairing(current => {
      if (!current || current.readOnly) return current;
      const next = { ...current, readOnly: true };
      void savePairing(next);
      return next;
    });
  }, []);

  const pair = useCallback(async (next: Pairing) => {
    await savePairing(next);
    await resetNotificationState();
    setAuthError(null);
    revisionRef.current = 0;
    snippetKeyRef.current = '';
    wasOnlineRef.current = false;
    setOrchestratorSnippet('');
    setState(null);
    setError(null);
    setLastSuccessAt(null);
    setStatus('connecting');
    setPairing(next);
  }, []);

  const unpair = useCallback(() => forget(null), [forget]);

  const clearAuthError = useCallback(() => setAuthError(null), []);

  /*
   * `/api/state` carries no message text, so the pinned "Ask Lina" row's snippet
   * comes from a small history read whenever the Orchestrator speaks. That read
   * now lives in the poll loop's `notifyFrom`, because the "Lina replied"
   * notification needs the same line and neither should pay for it twice — the
   * loop claims `snippetKeyRef` before it awaits, and publishes what it finds.
   */

  /* ---------------------------------------------------------------------- */
  /* Notifications                                                           */
  /* ---------------------------------------------------------------------- */

  // What the OS currently allows, and what the person last asked for.
  useEffect(() => {
    let cancelled = false;
    void prepareNotifications();
    void Promise.all([getPermissionState(), loadNotifyEnabled()]).then(([permission, stored]) => {
      if (cancelled) return;
      setNotifyPermission(permission);
      setNotifyPreference(stored);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The first launch after a pairing is when asking makes sense: before that
  // there is nothing to be notified about, and a permission dialog on the very
  // first screen is a dialog about nothing.
  useEffect(() => {
    if (!ready || !pairing || notifyPreference !== null || !notificationsSupported()) return;
    let cancelled = false;
    void askPermission().then(async permission => {
      if (cancelled) return;
      setNotifyPermission(permission);
      // Granted means on by default; a refusal is remembered as a refusal so
      // the dialog is not raised again on the next launch.
      const wanted = permission === 'granted';
      await saveNotifyEnabled(wanted);
      if (!cancelled) setNotifyPreference(wanted);
    });
    return () => {
      cancelled = true;
    };
  }, [ready, pairing, notifyPreference]);

  // The background wake exists only while it has something to say.
  useEffect(() => {
    void setBackgroundPollEnabled(notifyEnabled);
  }, [notifyEnabled]);

  const setNotifyEnabled = useCallback(async (enabled: boolean) => {
    if (!enabled) {
      await saveNotifyEnabled(false);
      setNotifyPreference(false);
      return;
    }
    const permission = await askPermission();
    setNotifyPermission(permission);
    const wanted = permission === 'granted';
    await saveNotifyEnabled(wanted);
    setNotifyPreference(wanted);
  }, []);

  // `/api/hello` says whether this desktop takes input at all. Re-read it on
  // every fresh connection so a desktop that is restarted into another build
  // does not leave the app with a stale answer.
  useEffect(() => {
    if (!connection) {
      wasOnlineRef.current = false;
      return;
    }
    if (status !== 'online') {
      if (status === 'offline' || status === 'reconnecting') wasOnlineRef.current = false;
      return;
    }
    if (wasOnlineRef.current) return;
    wasOnlineRef.current = true;
    let cancelled = false;
    hello(connection)
      .then(response => {
        if (cancelled) return;
        const nextReadOnly = response.readOnly === true;
        setPairing(current => {
          if (!current) return current;
          if (current.readOnly === nextReadOnly && current.version === (response.version || current.version)) {
            return current;
          }
          const next = {
            ...current,
            readOnly: nextReadOnly,
            version: response.version || current.version,
            desktopHost: response.host || current.desktopHost,
          };
          void savePairing(next);
          return next;
        });
      })
      .catch(caught => {
        if (cancelled) return;
        wasOnlineRef.current = false;
        if (isBridgeError(caught) && caught.kind === 'auth') void forget(SIGNED_OUT_MESSAGE);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionKey, status, forget]);

  const value = useMemo<BridgeContextValue>(
    () => ({
      ready,
      pairing,
      connection,
      status,
      appActive,
      state,
      error,
      lastSuccessAt,
      orchestratorSnippet,
      authError,
      clearAuthError,
      readOnly: pairing?.readOnly === true,
      markReadOnly,
      refresh,
      pair,
      unpair,
      notifySupported: notificationsSupported(),
      notifyPermission,
      notifyEnabled,
      setNotifyEnabled,
    }),
    [
      ready,
      pairing,
      connection,
      status,
      appActive,
      state,
      error,
      lastSuccessAt,
      orchestratorSnippet,
      authError,
      clearAuthError,
      markReadOnly,
      refresh,
      pair,
      unpair,
      notifyPermission,
      notifyEnabled,
      setNotifyEnabled,
    ]
  );

  return <BridgeContext.Provider value={value}>{children}</BridgeContext.Provider>;
}
