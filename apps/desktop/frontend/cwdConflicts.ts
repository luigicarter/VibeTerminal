// Shared-working-folder awareness for agent panes.
//
// Two autonomous agents writing one checkout can trample each other's
// uncommitted work; the harnesses' own stale-write checks (Claude Code
// read-tracking, opencode's compare-and-swap writes) only stop blind byte
// clobbering and never coordinate ACROSS panes/processes. The app is the one
// layer that sees every pane's cwd and status, so it derives the overlap here
// and the panes show it as a neutral chip — side-by-side agents on one project
// is normal use, not a mistake, so this is awareness, not a warning; only the
// window where overlapping agents are working SIMULTANEOUSLY gets an amber
// tint.
//
// Known limits (advisory-only impact, deliberate): normalization lowercases
// unconditionally to match normalizeWorkspacePath in App.tsx (a theoretical
// false positive on case-sensitive POSIX), and symlinks/junctions are not
// resolved (no fs access in the renderer), so two spellings of one directory
// through a link are not caught.

import type { AgentSession, SessionStatus } from "./types";

export type CwdConflictSession = Pick<
  AgentSession,
  "id" | "name" | "kind" | "cwd" | "status"
>;

export interface CwdConflictInput {
  session: CwdConflictSession;
  // Where the pane lives, for the tooltip: its workspace name, or "Multi".
  scopeLabel: string;
}

export interface CwdConflictPeer {
  sessionId: string;
  name: string;
  scopeLabel: string;
  active: boolean;
}

export interface CwdConflict {
  peers: CwdConflictPeer[];
  // The real collision window: THIS pane and at least one overlapping peer
  // are both mid-turn at the same time.
  active: boolean;
}

export function normalizeCwdForConflict(cwd: string): string {
  return cwd
    .trim()
    .replace(/[\\/]+$/, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

// Deliberately NOT attention.ts's isSessionWorking (running-only, tuned for
// the sidebar spinner): a "starting" harness begins writing right after boot,
// and the escalation is styling-only, so counting it errs a few seconds early
// instead of late.
export function isCwdConflictWorkingStatus(status: SessionStatus): boolean {
  return status === "running" || status === "starting";
}

// Takes NORMALIZED paths. Nesting counts — an agent at the repo root writes
// anywhere under it, including the other agent's subfolder. The "/" boundary
// keeps c:/repo from matching c:/repo2.
export function cwdsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

// Presence counts regardless of status — the pane exists and one keystroke
// starts it, and a stable chip beats one that flickers with status churn.
// Plain shells (kind "terminal") are not autonomous writers and are excluded;
// an empty cwd must never overlap anything.
export function computeCwdConflicts(
  inputs: CwdConflictInput[]
): Map<string, CwdConflict> {
  const agents = inputs
    .map((input) => ({
      ...input,
      normalized: normalizeCwdForConflict(input.session.cwd)
    }))
    .filter((entry) => entry.session.kind !== "terminal" && entry.normalized !== "");
  const conflicts = new Map<string, CwdConflict>();
  for (const entry of agents) {
    const peers: CwdConflictPeer[] = [];
    for (const other of agents) {
      if (other.session.id === entry.session.id) continue;
      if (!cwdsOverlap(entry.normalized, other.normalized)) continue;
      peers.push({
        sessionId: other.session.id,
        name: other.session.name,
        scopeLabel: other.scopeLabel,
        active: isCwdConflictWorkingStatus(other.session.status)
      });
    }
    if (peers.length === 0) continue;
    conflicts.set(entry.session.id, {
      peers,
      active:
        isCwdConflictWorkingStatus(entry.session.status) &&
        peers.some((peer) => peer.active)
    });
  }
  return conflicts;
}

export function cwdConflictChipLabel(conflict: CwdConflict): string {
  if (!conflict.active) {
    return `×${conflict.peers.length + 1} here`;
  }
  const activeCount = 1 + conflict.peers.filter((peer) => peer.active).length;
  return `×${activeCount} active`;
}

export function cwdConflictTitle(conflict: CwdConflict): string {
  if (!conflict.active) {
    const names = conflict.peers
      .map((peer) => `${peer.name} (${peer.scopeLabel})`)
      .join(", ");
    return `Also in this folder: ${names}`;
  }
  const activePeers = conflict.peers.filter((peer) => peer.active);
  const names = activePeers
    .map((peer) => `${peer.name} (${peer.scopeLabel})`)
    .join(", ");
  return `${names} ${
    activePeers.length > 1 ? "are" : "is"
  } also running in this folder right now — edits can collide.`;
}
