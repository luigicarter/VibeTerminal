import type { AgentSession, SplitBranch, SplitLeaf, SplitNode } from "../types";

// Pure tile/split helpers. No React import on purpose: the smoke script
// transpiles this module and runs it directly, the same way
// tiled-board-resize-smoke.cjs does with tiledBoardGeometry.ts.

// Bounds on a persisted tree. localStorage is user-editable and a corrupt tree
// must degrade, never hang the renderer or produce a pane too small to measure.
const MAX_SPLIT_DEPTH = 6;
const MAX_SPLIT_LEAVES = 8;

export const MIN_SPLIT_RATIO = 0.05;
export const MAX_SPLIT_RATIO = 0.95;

export type SplitPath = ReadonlyArray<"a" | "b">;

export interface SplitMin {
  minW: number;
  minH: number;
}

export function clampSplitRatio(value: unknown): number {
  const numeric =
    typeof value === "number" && Number.isFinite(value) ? value : 0.5;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, numeric));
}

export function isSplitLeaf(node: SplitNode): node is SplitLeaf {
  return typeof (node as SplitLeaf).id === "string";
}

// Shape validation for a persisted tree. Unknown/malformed nodes collapse into
// their sibling rather than failing the whole tree, duplicate leaf ids are
// dropped (two tiles can never claim one session), and the depth cap also makes
// a cyclic hand-edited object terminate.
export function normalizeSplitNode(
  value: unknown,
  seen: Set<string> = new Set(),
  depth = 0
): SplitNode | undefined {
  if (!value || typeof value !== "object" || depth > MAX_SPLIT_DEPTH) {
    return undefined;
  }

  const node = value as Partial<SplitBranch> & Partial<SplitLeaf>;

  if (typeof node.id === "string") {
    if (!node.id || seen.has(node.id) || seen.size >= MAX_SPLIT_LEAVES) {
      return undefined;
    }
    seen.add(node.id);
    return { id: node.id };
  }

  if (node.dir !== "row" && node.dir !== "col") {
    return undefined;
  }

  const a = normalizeSplitNode(node.a, seen, depth + 1);
  const b = normalizeSplitNode(node.b, seen, depth + 1);
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }

  return { dir: node.dir, ratio: clampSplitRatio(node.ratio), a, b };
}

export function leafIds(node: SplitNode | undefined): string[] {
  if (!node) {
    return [];
  }
  if (isSplitLeaf(node)) {
    return [node.id];
  }
  return [...leafIds(node.a), ...leafIds(node.b)];
}

// Replace a leaf with a divider over the original pane and a new one. O(1)
// structurally, and the result is always a valid partition.
export function splitLeaf(
  node: SplitNode,
  targetId: string,
  dir: "row" | "col",
  newId: string
): SplitNode {
  if (isSplitLeaf(node)) {
    return node.id === targetId
      ? { dir, ratio: 0.5, a: { id: node.id }, b: { id: newId } }
      : node;
  }

  const a = splitLeaf(node.a, targetId, dir, newId);
  const b = splitLeaf(node.b, targetId, dir, newId);
  // Unchanged subtrees keep their identity so React can skip them.
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

// Remove a leaf; its parent collapses into the surviving sibling.
export function removeLeaf(
  node: SplitNode,
  id: string
): SplitNode | undefined {
  if (isSplitLeaf(node)) {
    return node.id === id ? undefined : node;
  }

  const a = removeLeaf(node.a, id);
  const b = removeLeaf(node.b, id);
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

export function setRatioAtPath(
  node: SplitNode,
  path: SplitPath,
  ratio: number
): SplitNode {
  if (isSplitLeaf(node)) {
    return node;
  }
  if (path.length === 0) {
    return { ...node, ratio: clampSplitRatio(ratio) };
  }

  const [head, ...rest] = path;
  return { ...node, [head]: setRatioAtPath(node[head], rest, ratio) };
}

export function nodeAtPath(
  node: SplitNode,
  path: SplitPath
): SplitNode | undefined {
  let current: SplitNode | undefined = node;
  for (const step of path) {
    if (!current || isSplitLeaf(current)) {
      return undefined;
    }
    current = current[step];
  }
  return current;
}

// The smallest box this subtree can occupy. Fed to TiledBoard as the tile's
// minW/minH, so sanitizeLayout/settleLayouts grow a split tile and re-pack its
// neighbours with no new sizing code in App.
export function subtreeMin(
  node: SplitNode,
  leafMinW: number,
  leafMinH: number,
  dividerPx: number
): SplitMin {
  if (isSplitLeaf(node)) {
    return { minW: leafMinW, minH: leafMinH };
  }

  const a = subtreeMin(node.a, leafMinW, leafMinH, dividerPx);
  const b = subtreeMin(node.b, leafMinW, leafMinH, dividerPx);

  return node.dir === "row"
    ? {
        minW: a.minW + b.minW + dividerPx,
        minH: Math.max(a.minH, b.minH)
      }
    : {
        minW: Math.max(a.minW, b.minW),
        minH: a.minH + b.minH + dividerPx
      };
}

type TileSession = Pick<AgentSession, "id" | "tileId" | "splitTree">;

export function effectiveTileId(session: Pick<AgentSession, "id" | "tileId">) {
  return session.tileId ?? session.id;
}

export function isTileAnchor(session: Pick<AgentSession, "id" | "tileId">) {
  return effectiveTileId(session) === session.id;
}

function stripTileFields<T extends TileSession>(session: T): T {
  return session.tileId === undefined && session.splitTree === undefined
    ? session
    : { ...session, tileId: undefined, splitTree: undefined };
}

// Remove one session from its tile, keeping the rest of the tile valid. Serves
// both closing a sub-pane and popping one out: the detached session keeps its
// own (dead-data) layout, and the caller decides where it goes next.
export function detachSessionFromTile(
  sessions: AgentSession[],
  id: string
): AgentSession[] {
  const target = sessions.find((session) => session.id === id);
  if (!target) {
    return sessions;
  }

  const tileId = effectiveTileId(target);
  const anchor = sessions.find((session) => session.id === tileId);
  const tree = anchor?.splitTree;

  if (!anchor || !tree) {
    const stripped = stripTileFields(target);
    return stripped === target
      ? sessions
      : sessions.map((session) => (session.id === id ? stripped : session));
  }

  const nextTree = removeLeaf(tree, id);
  const remainingIds = leafIds(nextTree);

  // One member left (or none): the tile dissolves and the survivor inherits its
  // board box, becoming an ordinary solo tile again.
  if (remainingIds.length <= 1) {
    const soleId = remainingIds[0];
    return sessions.map((session) => {
      if (session.id === id) {
        return stripTileFields(session);
      }
      if (session.id === soleId) {
        return { ...stripTileFields(session), layout: anchor.layout };
      }
      return session;
    });
  }

  // Re-anchor on the first surviving member in list order, so the tile keeps
  // its board box even when the anchor itself is the one leaving.
  const nextAnchorId =
    sessions.find((session) => remainingIds.includes(session.id))?.id ??
    remainingIds[0];

  return sessions.map((session) => {
    if (session.id === id) {
      return stripTileFields(session);
    }
    if (!remainingIds.includes(session.id)) {
      return session;
    }
    return session.id === nextAnchorId
      ? {
          ...session,
          tileId: nextAnchorId,
          splitTree: nextTree,
          layout: anchor.layout
        }
      : { ...session, tileId: nextAnchorId, splitTree: undefined };
  });
}

// Cross-session repair. restoreSession validates one session at a time and so
// cannot know about its siblings; this runs wherever sessions become a SET
// (workspace load, multi-session load) and guarantees the tree/membership
// invariant. It never drops a session — anything it cannot place reappears as
// an ordinary solo tile with its stored layout.
export function reconcileTiles(sessions: AgentSession[]): AgentSession[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const tiles = new Map<string, { tree: SplitNode; layout: AgentSession["layout"] }>();
  const claimed = new Set<string>();

  for (const session of sessions) {
    // A splitTree on a non-anchor is stray data; only an anchor owns one.
    if (!session.splitTree || !isTileAnchor(session)) {
      continue;
    }

    let tree = normalizeSplitNode(session.splitTree);
    if (!tree) {
      continue;
    }

    for (const leafId of leafIds(tree)) {
      const member = byId.get(leafId);
      const belongs =
        member && effectiveTileId(member) === session.id && !claimed.has(leafId);
      if (!belongs) {
        tree = removeLeaf(tree, leafId);
      }
      if (!tree) {
        break;
      }
    }

    const ids = leafIds(tree);
    if (ids.length < 2) {
      continue;
    }

    const anchorId = ids.includes(session.id)
      ? session.id
      : sessions.find((candidate) => ids.includes(candidate.id))?.id ?? ids[0];

    for (const memberId of ids) {
      claimed.add(memberId);
    }
    tiles.set(anchorId, { tree: tree as SplitNode, layout: session.layout });
  }

  const memberTile = new Map<string, string>();
  for (const [anchorId, tile] of tiles) {
    for (const memberId of leafIds(tile.tree)) {
      memberTile.set(memberId, anchorId);
    }
  }

  return sessions.map((session) => {
    const anchorId = memberTile.get(session.id);
    if (!anchorId) {
      return stripTileFields(session);
    }

    const tile = tiles.get(anchorId)!;
    return session.id === anchorId
      ? {
          ...session,
          tileId: anchorId,
          splitTree: tile.tree,
          layout: tile.layout
        }
      : { ...session, tileId: anchorId, splitTree: undefined };
  });
}

export interface BoardTile {
  id: string;
  anchor: AgentSession;
  members: AgentSession[];
  tree?: SplitNode;
}

// Group a scope's sessions into the tiles the board actually renders. Order
// follows the sessions array, so tiles keep a stable identity across renders.
export function buildBoardTiles(sessions: AgentSession[]): BoardTile[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const tiles: BoardTile[] = [];
  const placed = new Set<string>();

  for (const session of sessions) {
    if (placed.has(session.id)) {
      continue;
    }

    const anchor = byId.get(effectiveTileId(session));
    const tree = anchor?.splitTree;
    if (!anchor || !tree) {
      placed.add(session.id);
      tiles.push({ id: session.id, anchor: session, members: [session] });
      continue;
    }

    const members = leafIds(tree)
      .map((id) => byId.get(id))
      .filter((member): member is AgentSession => Boolean(member));
    for (const member of members) {
      placed.add(member.id);
    }
    tiles.push({ id: anchor.id, anchor, members, tree });
  }

  return tiles;
}
