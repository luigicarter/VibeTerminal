// Real panes with a deterministic bridge. No provider processes or credentials.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import FusionChatPane from "../../frontend/components/FusionChatPane";
import OpenFusionChatPane from "../../frontend/components/OpenFusionChatPane";
import "../../frontend/styles.css";

const qa = (window as any).qa = { settings: [], sends: [], refreshes: 0, failed: false, empty: false };
let listeners = new Set<(event: any) => void>();
const providers = [{ id: "openai", name: "OpenAI", models: Array.from({ length: 65 }, (_, i) => ({ id: `model-${i}`, name: `Model ${i}` })) }];
function emit(event: any) { for (const listener of listeners) listener({ id: "menu-qa", ...event }); }
const bridge = {
  start: async () => ({ ok: true }),
  onEvent: (listener: any) => { listeners.add(listener); return () => listeners.delete(listener); },
  sendUserTurn: async (...args: any[]) => { qa.sends.push(args); },
  setMode: async () => ({ ok: true }),
  setModels: async () => ({ ok: true }),
  saveModels: async () => ({ ok: true }),
  requestProviders: async () => {
    qa.refreshes++;
    setTimeout(() => emit(qa.failed ? { type: "providers", ok: false, message: "Fixture catalog unavailable" }
      : { type: "providers", ok: true, catalogOk: true, connected: qa.empty ? [] : providers,
        available: [{ id: "anthropic", name: "Anthropic" }] }), 10);
  }
};
(window as any).vibe = {
  platform: "win32", fusionChat: bridge, openFusionChat: bridge,
  fusionModelCatalog: { list: async ({ family, refresh }: any) => {
    if (refresh) qa.refreshes++;
    return { ok: true, family, models: family === "codex" ? [{ id: "gpt-6-astra", label: "GPT-6 Astra", supportedEfforts: ["low", "high", "max", "ultra"] }] : [] };
  } },
  agentThreads: { list: async () => ({ status: "found", threads: Array.from({ length: 55 }, (_, i) => ({ id: `thread-${i}`, provider: "claude", title: `Saved chat ${i}`, updatedAt: Date.now() })) }) },
  clipboard: { readFilePaths: () => [] }
};
function Fixture() {
  const [mode, setMode] = useState("fusion");
  qa.setMode = setMode;
  const session: any = { id: "menu-qa", name: mode === "fusion" ? "Fusion" : "Open Fusion", kind: mode,
    cwd: "C:\\work\\lina", started: true, launchToken: 1, createdAt: Date.now(), status: "waiting",
    fusionPlannerFamily: "claude", fusionPlannerModel: "opus", fusionExecutorFamily: "codex", fusionExecutorModel: "gpt-6-astra",
    openFusionPlannerModel: "openai/model-40", openFusionExecutorModel: "openai/model-2" };
  const props: any = { session, profile: { id: mode, name: session.name }, isSelected: true, isMaximized: true,
    claimedThreadIds: ["thread-0"], onClose() {}, onDuplicate() {}, onRestart() {}, onResume() {}, onClear() {},
    onSettingsChange(value: any) { qa.settings.push(value); }, onAdd() {}, onSelect() {}, onMaximize() {},
    onThreadRefChange() {}, onStatusChange() {}, onAttention() {} };
  return <div style={{ width: "100%", height: "100vh", padding: 16 }}>
    {mode === "fusion" ? <FusionChatPane key={mode} {...props} /> : <OpenFusionChatPane key={mode} {...props} />}
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
