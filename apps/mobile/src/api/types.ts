/**
 * Bridge API contract v1, with the changed-rows terminal stream (protocol 2).
 *
 * The desktop app serves this over plain HTTP on the local network; every
 * success is `{ ok: true, ... }` and every failure `{ ok: false, error }`.
 * `scripts/mock-bridge.cjs` implements the same shapes for development.
 *
 * JSON bodies may arrive gzip-encoded; `fetch` decodes them, so nothing in this
 * app sees the difference beyond a smaller network bill.
 */

export const BRIDGE_PROTOCOL = 1;

/**
 * The terminal stream's own version, reported in the `hello` event. Version 2
 * is the changed-rows frame protocol: `hello`, one `scrollback`, a full
 * `screen`, then `frame`s carrying only the rows that moved.
 */
export const STREAM_PROTOCOL = 2;

export const DEFAULT_PORT = 47831;

/** Timestamps arrive as epoch milliseconds; tolerate ISO strings and nulls. */
export type Timestamp = number | string | null;

export type SessionStatus = 'working' | 'waiting' | 'done' | 'failed' | 'idle' | 'starting' | 'exited';

export type AgentKind =
  | 'terminal'
  | 'codex'
  | 'open-codex'
  | 'codex-web'
  | 'claude'
  | 'claude-custom'
  | 'cursor'
  | 'gemini'
  | 'opencode'
  | 'kimi'
  | 'kimi-custom'
  | 'qwen'
  | 'grok'
  | 'fusion'
  | 'openfusion';

/** Kinds the desktop adds later still render, as the raw kind string. */
export type SessionKind = AgentKind | (string & {});

export type TaskStatus =
  | 'queued'
  | 'routing'
  | 'running'
  | 'waiting-results'
  | 'needs-answer'
  | 'finished'
  | 'failed'
  | 'cancelled'
  | 'paused'
  | 'continued';

/** The shapes of prompt a terminal can be parked on. */
export type NeedsInputKind = 'menu' | 'yesno' | 'approval';

/** One answer the terminal will accept: the key to send and what it means. */
export type NeedsInputOption = {
  /** The literal key the terminal expects — "1", "y", "n". */
  key: string;
  label: string;
};

/** What a terminal is waiting for, when it is waiting for a person. */
export type NeedsInput = {
  kind: NeedsInputKind;
  prompt: string;
  options: NeedsInputOption[];
};

export type ProjectCounts = {
  working: number;
  waiting: number;
  done: number;
  failed: number;
};

export type Project = {
  id: string;
  name: string;
  path: string;
  counts: ProjectCounts;
};

export type Session = {
  id: string;
  generation: number;
  projectId: string | null;
  projectName: string;
  title: string;
  kind: SessionKind;
  provider: string;
  isChat: boolean;
  status: SessionStatus;
  /**
   * Omitted when it would only repeat `status`; `sessionStatusLabel` fills the
   * gap from the status itself, so the wire never carries "working" twice.
   */
  statusLabel?: string;
  /** Omitted when it equals the project's path, which is the usual case. */
  cwd?: string;
  lastActivityAt: Timestamp;
  attention: boolean;
  /** At most 80 characters: a list row cannot show more than that anyway. */
  snippet: string;
  /**
   * The prompt this terminal is parked on, when the desktop can see one.
   * Optional: a desktop older than this field simply never sends it.
   */
  needsInput?: NeedsInput | null;
};

export type OrchestratorSummary = {
  enabled: boolean;
  ready: boolean;
  activeCount: number;
  lastMessageAt: Timestamp;
};

export type HelloResponse = {
  ok: true;
  app: string;
  version: string;
  host: string;
  bridge: number;
  /** Present on desktops that serve the bridge for reading only. */
  readOnly?: boolean;
};

export type BridgeState = {
  ok: true;
  revision: number;
  at: Timestamp;
  projects: Project[];
  sessions: Session[];
  orchestrator: OrchestratorSummary;
};

export type ScreenResponse = {
  ok: true;
  text: string;
  exited: boolean;
  updatedAt: Timestamp;
};

export type TranscriptStatus = 'found' | 'unavailable' | 'unsupported';

export type TranscriptMessage = {
  role: 'user' | 'assistant';
  text: string;
};

/**
 * `GET /api/sessions/:id/transcript?limit=&before=` — one page, newest last.
 *
 * `before` is the index the previous page started at, so paging backwards is
 * `before = nextBefore` until `nextBefore` is null.
 */
export type TranscriptResponse = {
  ok: true;
  status: TranscriptStatus;
  messages: TranscriptMessage[];
  /** How many messages the desktop holds for this terminal in total. */
  total?: number;
  /** Where the next (older) page starts, or null at the beginning. */
  nextBefore?: number | null;
};

export type ActionResponse = {
  ok: true;
  actionId: string;
};

export type OrchestratorMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  at: Timestamp;
  requestId?: string | null;
  taskId?: string | null;
  status?: string | null;
  targetId?: string | null;
};

export type OrchestratorTask = {
  id: string;
  requestId: string | null;
  text: string;
  status: TaskStatus;
  terminalId: string | null;
  projectId: string | null;
  cwd: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  result: string | null;
  error: string | null;
  summary: string | null;
};

export type OrchestratorHistory = {
  ok: true;
  enabled: boolean;
  ready: boolean;
  messages: OrchestratorMessage[];
  tasks: OrchestratorTask[];
};

export type OrchestratorRequestResponse = {
  ok: true;
  requestId: string;
  status: string;
};

/** An address the bridge might answer on, before any code is known. */
export type Endpoint = {
  host: string;
  port: number;
};

/** Everything needed to reach one desktop. `code` is stored normalized. */
export type Connection = Endpoint & {
  code: string;
};

/** `GET /api/discover`: unauthenticated, so a phone can find desktops. */
export type DiscoverResponse = {
  ok: true;
  app: string;
  host: string;
  version: string;
  bridge: number;
  readOnly: boolean;
  desktopId: string;
};

/** `POST /api/pair`: asks the desktop to show an approval prompt. */
export type PairRequestResponse = {
  ok: true;
  requestId: string;
  expiresAt: Timestamp;
};

export type PairStatus = 'pending' | 'approved' | 'denied' | 'expired';

/** `GET /api/pair/:requestId`: long-polls until the person answers. */
export type PairStatusResponse = {
  ok: true;
  status: PairStatus;
  /** Delivered once, on approval. */
  code?: string;
};

/** What pairing persists between launches. */
export type Pairing = Connection & {
  /** The machine name the desktop reported through `/api/hello`. */
  desktopHost: string;
  /** Stable identity of the desktop, used to dedupe discovery results. */
  desktopId: string;
  /** The desktop app version at pairing time. */
  version: string;
  pairedAt: number;
  /** True when this desktop build shows terminals but refuses input. */
  readOnly: boolean;
};

/** Milliseconds for a timestamp that may arrive as a number or an ISO string. */
export function toMillis(value: Timestamp | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
