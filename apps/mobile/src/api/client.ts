import {
  ActionResponse,
  BridgeState,
  Connection,
  DiscoverResponse,
  Endpoint,
  HelloResponse,
  OrchestratorHistory,
  OrchestratorRequestResponse,
  PairRequestResponse,
  PairStatusResponse,
  ScreenResponse,
  TranscriptResponse,
} from './types';

/** Every request except the long poll gives up after this long. */
export const REQUEST_TIMEOUT_MS = 8000;

/** How long a single long poll asks the desktop to hold the connection open. */
export const LONG_POLL_WAIT_MS = 20000;

/** The contract's ceiling for `wait`. */
export const MAX_LONG_POLL_WAIT_MS = 25000;

export type BridgeErrorKind =
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'auth'
  | 'forbidden'
  | 'notFound'
  | 'conflict'
  | 'unavailable'
  | 'http'
  | 'parse';

export type BridgeError = Error & {
  bridgeError: true;
  kind: BridgeErrorKind;
  status?: number;
};

export function isBridgeError(value: unknown): value is BridgeError {
  return Boolean(value) && typeof value === 'object' && (value as BridgeError).bridgeError === true;
}

/* -------------------------------------------------------------------------- */
/* What this session has cost                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Bytes read back since the app started, so Settings can show what the phone
 * has spent. Three buckets, because they are spent for different reasons:
 * the state long poll runs forever, the terminal streams run while a terminal
 * is on screen, and everything else is a one-off read.
 *
 * These are decoded bytes — the length of the body this app parsed. The desktop
 * gzips both JSON and the stream, so the bytes that crossed the network are
 * smaller, usually by four or five times. Counting what arrives is the number
 * the app can actually measure, and it never flatters the app.
 */
export type DataUsage = {
  /** `/api/state`, the long poll that never stops. */
  state: number;
  /** The live terminal stream, as the embedded page reports it. */
  stream: number;
  /** Transcripts, Orchestrator history, screens, pairing — everything else. */
  other: number;
};

let usage: DataUsage = { state: 0, stream: 0, other: 0 };
const usageListeners = new Set<() => void>();

function publishUsage(next: DataUsage): void {
  usage = next;
  for (const listener of Array.from(usageListeners)) listener();
}

/** The bytes of a string as UTF-8, without assuming `TextEncoder` exists. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function recordBytes(bucket: keyof DataUsage, bytes: number): void {
  if (!bytes) return;
  publishUsage({ ...usage, [bucket]: usage[bucket] + bytes });
}

/** Called by the chat screen with what the terminal page says it has read. */
export function recordStreamBytes(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  recordBytes('stream', Math.round(bytes));
}

export function getDataUsage(): DataUsage {
  return usage;
}

export function subscribeDataUsage(listener: () => void): () => void {
  usageListeners.add(listener);
  return () => {
    usageListeners.delete(listener);
  };
}

/** Only for the tests and a fresh pairing; nothing in the UI resets it. */
export function resetDataUsage(): void {
  publishUsage({ state: 0, stream: 0, other: 0 });
}

/** "812 B", "14.2 kB", "3.1 MB" — short enough for one line of Settings. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function bridgeError(kind: BridgeErrorKind, message: string, status?: number): BridgeError {
  const error = new Error(message) as BridgeError;
  error.bridgeError = true;
  error.kind = kind;
  if (status !== undefined) error.status = status;
  return error;
}

/** Strip dashes and spaces, uppercase: the form the Authorization header uses. */
export function normalizeCode(raw: string): string {
  return (raw || '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
}

/** Render a code as XXXX-XXXX-XXXX-XXXX while it is being typed. */
export function formatCode(raw: string): string {
  const flat = normalizeCode(raw).slice(0, 16);
  const groups = flat.match(/.{1,4}/g);
  return groups ? groups.join('-') : '';
}

/** Accept a pasted URL or a bare address; keep only the host part. */
export function normalizeHost(raw: string): string {
  let host = (raw || '').trim();
  host = host.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  host = host.replace(/\/.*$/, '');
  host = host.replace(/:\d+$/, '');
  return host;
}

export function normalizePort(raw: string | number): number {
  const value = typeof raw === 'number' ? raw : Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(value) || value <= 0 || value > 65535) return 0;
  return Math.trunc(value);
}

export function baseUrl(endpoint: Endpoint): string {
  return `http://${endpoint.host}:${endpoint.port}`;
}

export function describeError(error: unknown, connection?: Endpoint | null): string {
  if (isBridgeError(error)) {
    switch (error.kind) {
      case 'auth':
        return 'That code did not match';
      case 'timeout':
        return connection
          ? `The desktop at ${connection.host}:${connection.port} did not answer in time.`
          : 'The desktop did not answer in time.';
      case 'network':
        return connection
          ? `Could not reach ${connection.host}:${connection.port}. Same Wi-Fi? Is phone access on?`
          : 'Could not reach the desktop. Same Wi-Fi? Is phone access on?';
      default:
        return error.message;
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong.';
}

type RequestOptions = {
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/** The discovery and pairing routes are answered without a code. */
type Target = Endpoint & { code?: string };

async function request<T>(target: Target, path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, timeoutMs = REQUEST_TIMEOUT_MS, signal } = options;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const forwardAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', forwardAbort);
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl(target)}${path}`, {
      method,
      headers: {
        ...(target.code ? { Authorization: `Bearer ${target.code}` } : {}),
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) throw bridgeError('timeout', 'The desktop did not answer in time.');
    if (signal?.aborted) throw bridgeError('aborted', 'Request cancelled.');
    throw bridgeError('network', describeNetworkFailure(error, target));
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', forwardAbort);
  }

  const text = await response.text().catch(() => '');
  recordBytes(path.startsWith('/api/state') ? 'state' : 'other', utf8Length(text));
  let payload: any = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const message =
      (payload && typeof payload.error === 'string' && payload.error) ||
      `The desktop answered ${response.status}.`;
    throw bridgeError(kindForStatus(response.status), message, response.status);
  }

  if (!payload || typeof payload !== 'object') {
    throw bridgeError('parse', 'The desktop sent something this app could not read.');
  }
  if (payload.ok !== true) {
    const message = typeof payload.error === 'string' ? payload.error : 'The desktop refused the request.';
    throw bridgeError('http', message, response.status);
  }
  return payload as T;
}

function kindForStatus(status: number): BridgeErrorKind {
  if (status === 401) return 'auth';
  // 403 is the desktop saying "you may look, not touch" — the read-only answer.
  if (status === 403) return 'forbidden';
  if (status === 404) return 'notFound';
  if (status === 409) return 'conflict';
  if (status === 503) return 'unavailable';
  return 'http';
}

function describeNetworkFailure(error: unknown, endpoint: Endpoint): string {
  const detail = error instanceof Error && error.message ? ` (${error.message})` : '';
  return `Could not reach ${endpoint.host}:${endpoint.port}.${detail}`;
}

/**
 * `GET /api/discover` — unauthenticated, so a phone can find desktops before it
 * has any code. Used by the scanner with a short timeout.
 */
export function discover(
  endpoint: Endpoint,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<DiscoverResponse> {
  return request<DiscoverResponse>(endpoint, '/api/discover', {
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    signal: options.signal,
  });
}

/** `POST /api/pair` — asks the desktop to show its approval prompt. */
export function requestPairing(
  endpoint: Endpoint,
  device: { deviceName: string; platform: string },
  signal?: AbortSignal
): Promise<PairRequestResponse> {
  return request<PairRequestResponse>(endpoint, '/api/pair', {
    method: 'POST',
    body: device,
    signal,
  });
}

/** `GET /api/pair/:requestId` — long-polls until somebody answers the prompt. */
export function pollPairing(
  endpoint: Endpoint,
  requestId: string,
  options: { wait?: number; signal?: AbortSignal } = {}
): Promise<PairStatusResponse> {
  const wait = Math.max(0, Math.min(MAX_LONG_POLL_WAIT_MS, options.wait ?? 0));
  return request<PairStatusResponse>(
    endpoint,
    `/api/pair/${encodeURIComponent(requestId)}?wait=${wait}`,
    { timeoutMs: wait + REQUEST_TIMEOUT_MS, signal: options.signal }
  );
}

export function hello(connection: Connection, signal?: AbortSignal): Promise<HelloResponse> {
  return request<HelloResponse>(connection, '/api/hello', { signal });
}

export function fetchState(
  connection: Connection,
  options: { revision?: number; wait?: number; signal?: AbortSignal } = {}
): Promise<BridgeState> {
  const revision = Number.isFinite(options.revision) ? Number(options.revision) : 0;
  const wait = Math.max(0, Math.min(MAX_LONG_POLL_WAIT_MS, options.wait ?? 0));
  return request<BridgeState>(connection, `/api/state?revision=${revision}&wait=${wait}`, {
    signal: options.signal,
    timeoutMs: wait + REQUEST_TIMEOUT_MS,
  });
}

export function fetchScreen(
  connection: Connection,
  sessionId: string,
  options: { maxChars?: number; signal?: AbortSignal } = {}
): Promise<ScreenResponse> {
  const maxChars = options.maxChars ?? 12000;
  return request<ScreenResponse>(
    connection,
    `/api/sessions/${encodeURIComponent(sessionId)}/screen?maxChars=${maxChars}`,
    { signal: options.signal }
  );
}

/** How many transcript messages one page of the History sheet holds. */
export const TRANSCRIPT_PAGE = 50;

/**
 * `GET /api/sessions/:id/transcript?limit=&before=` — one page of the
 * conversation, newest last. Read only when the History sheet is opened, and
 * again for each "Load earlier", so a terminal nobody asks about costs nothing.
 */
export function fetchTranscript(
  connection: Connection,
  sessionId: string,
  options: { limit?: number; before?: number | null; signal?: AbortSignal } = {}
): Promise<TranscriptResponse> {
  const limit = Math.max(1, Math.trunc(options.limit ?? TRANSCRIPT_PAGE));
  const before =
    options.before === null || options.before === undefined || !Number.isFinite(options.before)
      ? ''
      : `&before=${Math.max(0, Math.trunc(options.before))}`;
  return request<TranscriptResponse>(
    connection,
    `/api/sessions/${encodeURIComponent(sessionId)}/transcript?limit=${limit}${before}`,
    { signal: options.signal }
  );
}

export function sendInput(
  connection: Connection,
  sessionId: string,
  text: string,
  signal?: AbortSignal
): Promise<ActionResponse> {
  return request<ActionResponse>(connection, `/api/sessions/${encodeURIComponent(sessionId)}/input`, {
    method: 'POST',
    body: { text },
    signal,
  });
}

/**
 * `POST /api/sessions/:id/keys` — raw bytes for the terminal, exactly as a
 * keyboard would have produced them. Every key on the key bar comes through
 * here, and nowhere else.
 *
 * Desktops that do not grant control answer 403 `control not allowed`, and
 * desktops that do not serve the route at all answer 404; both mean the same
 * thing to this app (see `isReadOnlyRejection`).
 */
export function sendKeys(
  connection: Connection,
  sessionId: string,
  data: string,
  signal?: AbortSignal
): Promise<ActionResponse> {
  return request<ActionResponse>(connection, `/api/sessions/${encodeURIComponent(sessionId)}/keys`, {
    method: 'POST',
    body: { data },
    signal,
  });
}

/**
 * `GET /terminal/:id` — the desktop's own xterm rendering of one session, as a
 * page for the WebView. The credential rides in the query string because a
 * WebView cannot carry an Authorization header on a top-level navigation.
 */
export function terminalPageUrl(connection: Connection, sessionId: string): string {
  return `${baseUrl(connection)}/terminal/${encodeURIComponent(sessionId)}?code=${encodeURIComponent(
    connection.code
  )}`;
}

export function interruptSession(
  connection: Connection,
  sessionId: string,
  signal?: AbortSignal
): Promise<ActionResponse> {
  return request<ActionResponse>(connection, `/api/sessions/${encodeURIComponent(sessionId)}/interrupt`, {
    method: 'POST',
    signal,
  });
}

export function fetchOrchestratorHistory(
  connection: Connection,
  options: { limit?: number; signal?: AbortSignal } = {}
): Promise<OrchestratorHistory> {
  const limit = options.limit ?? 200;
  return request<OrchestratorHistory>(connection, `/api/orchestrator/history?limit=${limit}`, {
    signal: options.signal,
  });
}

export function sendOrchestratorRequest(
  connection: Connection,
  text: string,
  options: { projectPath?: string; signal?: AbortSignal } = {}
): Promise<OrchestratorRequestResponse> {
  const body: { text: string; projectPath?: string } = { text };
  if (options.projectPath) body.projectPath = options.projectPath;
  return request<OrchestratorRequestResponse>(connection, '/api/orchestrator/request', {
    method: 'POST',
    body,
    signal: options.signal,
  });
}
