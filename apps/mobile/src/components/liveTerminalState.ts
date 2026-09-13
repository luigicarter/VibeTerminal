import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The state shared by the two live-terminal shells — the native WebView and the
 * web iframe — so both behave identically: a spinner until the page says it is
 * ready, a muted notice when the terminal ends, a retry when it cannot load,
 * and the plain-text fallback after the second failure.
 */

/** What the terminal page posts back, per the bridge contract. */
export type TerminalMessage = {
  type: 'ready' | 'exit' | 'error' | 'stats';
  message?: string;
  /**
   * Whether this page can send keys. Pages that do not say (an older desktop)
   * leave it undefined, and the app falls back to the pairing's read-only flag.
   */
  control?: boolean;
  /** `stats`: bytes the page has read off the stream since it opened. */
  bytes?: number;
  /** `stats`: how many `frame` events it has drawn. */
  frames?: number;
};

export type TerminalPhase = 'loading' | 'ready' | 'exit' | 'error';

/** Two failures and the plain-text terminal takes over. */
export const MAX_TERMINAL_ERRORS = 2;

/** A page that has not said "ready" by now is not going to. */
export const TERMINAL_LOAD_TIMEOUT_MS = 15000;

export const TERMINAL_ERROR_TEXT = 'Could not load the terminal';
export const TERMINAL_EXIT_TEXT = 'Terminal ended';

/** Accept the string a WebView posts, or the object an iframe may post. */
export function parseTerminalMessage(raw: unknown): TerminalMessage | null {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const candidate = value as {
    type?: unknown;
    message?: unknown;
    control?: unknown;
    bytes?: unknown;
    frames?: unknown;
  };
  const type = candidate.type;
  if (type !== 'ready' && type !== 'exit' && type !== 'error' && type !== 'stats') return null;
  const message: TerminalMessage = { type };
  if (typeof candidate.message === 'string') message.message = candidate.message;
  if (typeof candidate.control === 'boolean') message.control = candidate.control;
  if (typeof candidate.bytes === 'number' && Number.isFinite(candidate.bytes)) {
    message.bytes = candidate.bytes;
  }
  if (typeof candidate.frames === 'number' && Number.isFinite(candidate.frames)) {
    message.frames = candidate.frames;
  }
  return message;
}

/** What the shell lets the screen around it do to the page. */
export type LiveTerminalHandle = {
  /** Put the caret back in the terminal — what `/` on the key bar does. */
  focus: () => void;
  /** Step the page's zoom by `delta`, clamped inside the page to 0.6x…3x. */
  zoom: (delta: number) => void;
  /** Back to 1x — the same thing a double tap on the page does. */
  resetZoom: () => void;
  /** Re-fit the columns to the frame; called when the phone is rotated. */
  fit: () => void;
};

/** The props both shells take; the platform picks the implementation. */
export type LiveTerminalProps = {
  /** `http://host:port/terminal/<id>?code=<code>`. */
  url: string;
  /** `http://host:port` — the only origin this view is allowed to load. */
  origin: string;
  /** The session, so a different chat resets the state machine. */
  sessionId: string;
  /** The page's own answer to "may this phone send keys?". */
  onControl?: (control: boolean | null) => void;
  /** Called after the second failure: the caller shows the plain text instead. */
  onFallback?: () => void;
  /** Every five seconds: what this page has read off the stream so far. */
  onStats?: (stats: { bytes: number; frames: number }) => void;
  /** Filled in with the handle while this shell is mounted. */
  handleRef?: React.MutableRefObject<LiveTerminalHandle | null>;
  testID?: string;
};

export type LiveTerminalOptions = {
  /** Called when the page says whether it may send keys. */
  onControl?: (control: boolean | null) => void;
  /** Called once the page has failed twice: show the plain text instead. */
  onFallback?: () => void;
  /** Called with each `stats` report the page posts. */
  onStats?: (stats: { bytes: number; frames: number }) => void;
  /** Reset the state machine when this changes — a different session. */
  resetKey?: string;
};

export function useLiveTerminal({ onControl, onFallback, onStats, resetKey }: LiveTerminalOptions) {
  const [phase, setPhase] = useState<TerminalPhase>('loading');
  const [detail, setDetail] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const failuresRef = useRef(0);
  const mountedRef = useRef(false);

  // A different session starts again from nothing. The first run is already
  // "nothing", so it must not re-key the page and load it twice.
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    failuresRef.current = 0;
    setPhase('loading');
    setDetail(null);
    setReloadKey(key => key + 1);
    onControl?.(null);
    // `onControl` is a callback the caller rebuilds freely; only the session matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const fail = useCallback(
    (message?: string) => {
      failuresRef.current += 1;
      setDetail(message || null);
      setPhase('error');
      if (failuresRef.current >= MAX_TERMINAL_ERRORS) onFallback?.();
    },
    [onFallback]
  );

  const handleMessage = useCallback(
    (raw: unknown) => {
      const message = parseTerminalMessage(raw);
      if (!message) return;
      if (message.type === 'stats') {
        onStats?.({ bytes: message.bytes ?? 0, frames: message.frames ?? 0 });
        return;
      }
      if (message.type === 'ready') {
        failuresRef.current = 0;
        setDetail(null);
        setPhase('ready');
        onControl?.(message.control === undefined ? null : message.control);
        return;
      }
      if (message.type === 'exit') {
        setPhase('exit');
        return;
      }
      fail(message.message);
    },
    [fail, onControl, onStats]
  );

  const retry = useCallback(() => {
    setDetail(null);
    setPhase('loading');
    setReloadKey(key => key + 1);
  }, []);

  // A page that never answers is a failure too, or the spinner would spin forever.
  useEffect(() => {
    if (phase !== 'loading') return;
    const timer = setTimeout(() => fail('The desktop did not answer in time.'), TERMINAL_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [phase, reloadKey, fail]);

  return { phase, detail, reloadKey, handleMessage, fail, retry };
}
