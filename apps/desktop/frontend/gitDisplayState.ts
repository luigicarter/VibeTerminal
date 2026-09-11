import type { BranchOverview, BranchOverviewEntry, BranchWorktreeState, CodeChangeSummary } from "./types";

export const GIT_REFRESH_MS = 7_500;

export function upstreamLabel(branch: Pick<BranchOverviewEntry, "upstream" | "upstreamState" | "ahead" | "behind" | "detached">) {
  if (branch.detached) return "No branch checked out";
  if (branch.upstreamState === "gone") return `Upstream missing: ${branch.upstream}`;
  if (!branch.upstream) return "No upstream";
  const drift = [branch.ahead ? `${branch.ahead} ahead` : "", branch.behind ? `${branch.behind} behind` : ""].filter(Boolean).join(" · ");
  return `${branch.upstream} · ${drift || "In sync with fetched upstream"}`;
}

export function worktreeLabel(value: Pick<BranchWorktreeState, "state" | "changedFiles" | "conflicts">) {
  if (value.state === "unavailable" || value.state === "not-git") return "Changes unavailable";
  if (value.state === "clean") return "Working tree clean";
  const files = `${value.changedFiles} changed file${value.changedFiles === 1 ? "" : "s"}`;
  return value.conflicts ? `${files} · ${value.conflicts} conflict${value.conflicts === 1 ? "" : "s"}` : files;
}

export type GitDisplayUpdate = {
  refreshing: boolean;
  summary?: CodeChangeSummary;
  overview?: BranchOverview;
};

// Each mount/open state owns an observer. Disposal fences both success and
// failure responses, including close/reopen and A -> B -> A project changes.
export function createGitDisplayObserver(options: {
  cwd: string;
  expanded: boolean;
  readSummary(cwd: string): Promise<CodeChangeSummary>;
  readOverview(cwd: string): Promise<BranchOverview>;
  publish(update: GitDisplayUpdate): void;
}) {
  let disposed = false;
  let inFlight = false;
  const unavailable = (message: string): CodeChangeSummary => ({ state: "unavailable", cwd: options.cwd, changedFiles: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, insertions: 0, deletions: 0, ahead: 0, behind: 0, updatedAt: Date.now(), message });
  return {
    async refresh() {
      if (disposed || inFlight) return;
      inFlight = true;
      options.publish({ refreshing: true });
      try {
        const update = options.expanded
          ? await options.readOverview(options.cwd).then(overview => ({ overview, summary: overview.summary || unavailable(overview.message || "Git summary unavailable.") }))
          : { summary: await options.readSummary(options.cwd) };
        if (!disposed) options.publish({ ...update, refreshing: false });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!disposed) options.publish(options.expanded
          ? { refreshing: false, summary: unavailable(message), overview: { state: "unavailable", branches: [], message } }
          : { refreshing: false, summary: unavailable(message) });
      } finally {
        inFlight = false;
      }
    },
    dispose() { disposed = true; }
  };
}

export function branchPopupPosition(rect: { bottom: number; right: number }, width: number, height: number) {
  const popupWidth = Math.min(460, width - 16);
  const top = Math.min(rect.bottom + 8, Math.max(8, height - 180));
  return { top, left: Math.max(8, Math.min(rect.right - popupWidth, width - popupWidth - 8)), width: popupWidth, maxHeight: Math.max(0, Math.min(460, height - top - 8)) };
}
