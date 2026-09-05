import type { AgentSession, SplitNode } from "./types";
import { migrateRemovedAgent } from "./sessionPersistence";
import { normalizeSplitNode, reconcileTiles } from "./components/splitTree";

// This is intentionally independent of runtime session serialization.
export const SETUP_CONFIG_FIELDS = [
  "name", "kind", "command", "fusion", "fusionPlannerFamily", "fusionPlannerModel",
  "fusionPlannerEffort", "fusionPlannerFast", "fusionExecutorFamily", "fusionExecutorModel",
  "fusionExecutorEffort", "fusionExecutorFast", "fusionRunMode", "fusionModel",
  "fusionCodexModel", "fusionClaudeEffort", "fusionCodexEffort", "fusionEffort",
  "openFusion", "openFusionPlannerModel", "openFusionExecutorModel", "openFusionRunMode",
  "providerProfileId", "providerModelOverride"
] as const;
export interface SetupPane {
  localId: string;
  migratedFrom?: "aider";
  config: Partial<Pick<AgentSession, typeof SETUP_CONFIG_FIELDS[number]>>;
  path: { kind: "project" } | { kind: "absolute"; value: string };
  layout: AgentSession["layout"];
  tileId?: string;
  splitTree?: SplitNode;
  prompt?: string;
}
export interface WorkspaceSetup {
  version: 1; id: string; name: string; scope: "global" | "project";
  projectPath?: string; panes: SetupPane[]; createdAt: number; updatedAt: number;
}
const identity = () => crypto.randomUUID();
const samePath = (a: string, b: string) => a.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase() === b.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
function remapTree(value: unknown, ids: Map<string, string>): SplitNode | undefined {
  const node = normalizeSplitNode(value);
  if (!node) return;
  if ("id" in node) return ids.has(node.id) ? { id: ids.get(node.id)! } : undefined;
  const a = remapTree(node.a, ids), b = remapTree(node.b, ids);
  return a && b ? { dir: node.dir, ratio: node.ratio, a, b } : a || b;
}
function configOnly(value: unknown): SetupPane["config"] {
  const input = migrateRemovedAgent(value) as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const field of SETUP_CONFIG_FIELDS) {
    const expected = ["fusion", "openFusion", "fusionPlannerFast", "fusionExecutorFast"].includes(field) ? "boolean" : "string";
    if (typeof input?.[field] === expected) result[field] = input[field];
  }
  return result;
}
function layoutOnly(value: AgentSession["layout"]): AgentSession["layout"] {
  return { x: value.x, y: value.y, w: value.w, h: value.h, ...(value.unit === "fluid" ? { unit: "fluid" as const } : {}) };
}
export function createWorkspaceSetup(input: { name: string; scope: WorkspaceSetup["scope"]; projectPath?: string; sessions: AgentSession[]; prompts?: Record<string, string> }): WorkspaceSetup {
  if (!input.name.trim()) throw new Error("Name the setup first.");
  if (input.scope === "project" && !input.projectPath) throw new Error("A project setup needs a project folder.");
  const ids = new Map(input.sessions.map((session, index) => [session.id, `pane-${index + 1}`]));
  return { version: 1, id: identity(), name: input.name.trim(), scope: input.scope,
    ...(input.scope === "project" ? { projectPath: input.projectPath } : {}), createdAt: Date.now(), updatedAt: Date.now(),
    panes: reconcileTiles(input.sessions).map(session => ({ localId: ids.get(session.id)!, config: configOnly(session),
      ...(String(session.kind) === "aider" ? { migratedFrom: "aider" as const } : {}),
      path: input.projectPath && samePath(session.cwd, input.projectPath) ? { kind: "project" } : { kind: "absolute", value: session.cwd },
      layout: layoutOnly(session.layout), tileId: session.tileId ? ids.get(session.tileId) : undefined,
      splitTree: remapTree(session.splitTree, ids), prompt: input.prompts?.[session.id] })) };
}
export function instantiateWorkspaceSetup(recipe: WorkspaceSetup, options: { projectPath?: string; idFactory?: () => string } = {}): { sessions: AgentSession[]; prompts: Record<string, string> } {
  if (recipe.version !== 1) throw new Error("Unsupported setup version.");
  if (recipe.scope === "project" && (!options.projectPath || !recipe.projectPath || !samePath(options.projectPath, recipe.projectPath))) throw new Error("Open this setup's project folder first.");
  const ids = new Map(recipe.panes.map(pane => [pane.localId, (options.idFactory || identity)()]));
  if (ids.size !== recipe.panes.length || new Set(ids.values()).size !== recipe.panes.length) throw new Error("Setup identities must be unique.");
  const prompts: Record<string, string> = {};
  const sessions = recipe.panes.map(pane => {
    const id = ids.get(pane.localId)!;
    const cwd = pane.path.kind === "project" ? options.projectPath : pane.path.value;
    if (!cwd) throw new Error("Select a project folder for this setup.");
    if (pane.prompt) prompts[id] = pane.prompt;
    return { name: "Terminal", kind: "terminal", command: "", ...configOnly(pane.config), id, cwd,
      createdAt: Date.now(), nextLaunchMode: "new", started: false, launchToken: 0, status: "idle",
      layout: layoutOnly(pane.layout), tileId: pane.tileId ? ids.get(pane.tileId) : undefined,
      splitTree: remapTree(pane.splitTree, ids) } as AgentSession;
  });
  return { sessions: reconcileTiles(sessions), prompts };
}

export interface HandoffEndpoint { id: string; generation: string; name?: string }
export interface HandoffDraft {
  readonly id: string; readonly source: Readonly<HandoffEndpoint>; readonly target: Readonly<HandoffEndpoint>;
  readonly selectedText: string; readonly paths: readonly string[]; readonly instruction: string;
  readonly text: string; readonly createdAt: number;
}
export function freezeHandoff(input: { source: HandoffEndpoint; target: HandoffEndpoint; selectedText: string; paths: readonly string[]; instruction: string; text?: string }): HandoffDraft {
  if (!input.source.id || !input.source.generation || !input.target.id || !input.target.generation) throw new Error("Select a current source and destination.");
  if (input.source.id === input.target.id) throw new Error("Choose a different destination.");
  const text = input.text ?? [input.instruction, input.selectedText, input.paths.length ? `Files:\n${input.paths.join("\n")}` : ""].filter(Boolean).join("\n\n");
  if (!text.trim()) throw new Error("Add selected context or an instruction.");
  const endpoint = (value: HandoffEndpoint) => Object.freeze({ id: value.id, generation: value.generation, ...(value.name !== undefined ? { name: value.name } : {}) });
  return Object.freeze({ id: identity(), source: endpoint(input.source), target: endpoint(input.target), selectedText: input.selectedText,
    paths: Object.freeze([...input.paths]), instruction: input.instruction, text, createdAt: Date.now() });
}
export function handoffTargetIsCurrent(draft: HandoffDraft, sessions: HandoffEndpoint[]): boolean {
  return [draft.source, draft.target].every(endpoint => sessions.some(session => session.id === endpoint.id && session.generation === endpoint.generation));
}
