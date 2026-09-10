import type { RelayState } from './orchestratorUi';

export type RelayActivity = Pick<RelayState, 'sessions' | 'activeTargets'> & { publicationRevision: number };

// A small activity update can race the initial full-state IPC response. Keep
// history from that response while applying only the newest live inventory.
export function mergeRelayActivity(state: RelayState, activity?: RelayActivity): RelayState {
    if (!activity || activity.publicationRevision <= (state.publicationRevision ?? 0)) return state;
    return { ...state, publicationRevision: activity.publicationRevision, sessions: activity.sessions, activeTargets: activity.activeTargets };
}
