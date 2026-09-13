import type { BridgeState, Project, ProjectCounts, Session } from '../api/types';
import { toMillis } from '../api/types';
import { countsWithNeedsInput, sessionNeedsInput, waitingForYou } from './needsInput';

/** Waiting terminals come first, then working, then the rest by recency. */
const STATUS_RANK: Record<string, number> = {
  waiting: 0,
  working: 1,
};

function rank(session: Session): number {
  const value = STATUS_RANK[session.status];
  return value === undefined ? 2 : value;
}

export function sortSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const at = toMillis(a.lastActivityAt) ?? 0;
    const bt = toMillis(b.lastActivityAt) ?? 0;
    if (bt !== at) return bt - at;
    return a.title.localeCompare(b.title);
  });
}

export function sessionsForProject(state: BridgeState | null, projectId: string): Session[] {
  if (!state) return [];
  return sortSessions(state.sessions.filter(session => session.projectId === projectId));
}

export function findProject(state: BridgeState | null, projectId: string): Project | null {
  if (!state) return null;
  return state.projects.find(project => project.id === projectId) || null;
}

export function findSession(state: BridgeState | null, sessionId: string): Session | null {
  if (!state) return null;
  return state.sessions.find(session => session.id === sessionId) || null;
}

/**
 * The tally under a project name. A terminal parked on a prompt is counted as
 * waiting even when the desktop still calls it working: it is waiting for the
 * person reading the list.
 */
export function projectCounts(state: BridgeState | null, project: Project): ProjectCounts {
  const sessions = state ? state.sessions.filter(session => session.projectId === project.id) : [];
  return countsWithNeedsInput(project.counts, sessions);
}

/**
 * The "Waiting for you" inbox above the project list: every terminal parked on
 * a prompt or reported waiting, wherever it is. Empty means the section is not
 * drawn at all.
 */
export function inboxSessions(state: BridgeState | null): Session[] {
  return waitingForYou(state?.sessions ?? []);
}

/** Does anything in this project want the user? */
export function projectAttention(state: BridgeState | null, projectId: string): boolean {
  if (!state) return false;
  return state.sessions.some(
    session =>
      session.projectId === projectId && (session.attention || sessionNeedsInput(session))
  );
}
