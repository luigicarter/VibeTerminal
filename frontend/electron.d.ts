import type { TerminalRuntimeSnapshot } from "./terminalRuntime";
import type {
  AppVersionList,
  AgentThreadListResult,
  AgentThreadLookupPayload,
  AgentThreadLookupResult,
  AgentThreadRef,
  BranchOverview,
  ClaudeProviderListResult,
  ClaudeProviderModelsResult,
  ClaudeProviderProfile,
  ClaudeProviderTestResult,
  CodeChangeSummary,
  FusionCodexEffort,
  FusionFamily,
  FusionRunMode,
  FusionChatEvent,
  OpenFusionChatEvent,
  OpenFusionModel,
  TerminalEvent,
  TerminalLaunchPayload,
  UpdateActionResult,
  UpdateState
} from "./types";

type ScreenshotFixture =
  | {
      mode: "openfusion";
      cwd: string;
      openCodeCommand?: string;
    }
  | {
      mode: "fusion-picker";
      cwd: string;
      role: "planner" | "executor";
      family: FusionFamily;
    }
  | {
      mode: "fusion-builds";
      cwd: string;
    }
  | {
      mode: "split";
      cwd: string;
    };

export interface FilePathDescription {
  path: string;
  kind: "text" | "image" | "directory" | "file" | "missing";
  label: string;
  lineCount?: number;
  error?: string;
}

// Result of the launch-time PATH scan. Keyed by AgentKind; kinds with no CLI of
// their own (terminal, kimi-custom, fusion, openfusion) are absent, not false.
export interface InstalledCliReport {
  probedAt: number;
  durationMs: number;
  timedOut: boolean;
  directoriesScanned: number;
  error?: string;
  clis: Record<string, { command: string; available: boolean; path: string | null }>;
}

declare global {
  interface Window {
    vibe?: {
      orchestrator: import("./orchestratorUi").RelayApi & {
        openMain(): Promise<{ ok: boolean }>;
        getChanges(payload: { id?: string; cwd?: string }): Promise<CodeChangeSummary>;
      };
      voice: import("./voice/types").VoiceApi;
      setups: import("./components/WorkspaceSetups").WorkspaceSetupsProps["api"];
      platform: string;
      app: {
        getCwd: () => Promise<string>;
        getInstalledClis?: (options?: {
          refresh?: boolean;
        }) => Promise<InstalledCliReport>;
        screenshotFixture?: ScreenshotFixture | null;
        getScreenshotFixture?: () => Promise<ScreenshotFixture | null>;
      };
      clipboard: {
        readText: () => string;
        writeText: (text: string) => void;
        readFilePaths?: () => string[];
      };
      // Native application menu action broadcasts ("menu:event" from main).
      menu?: {
        onEvent: (
          callback: (event: { type: string; action?: string }) => void
        ) => () => void;
      };
      // Claude provider profiles (Settings dialog). Sanitized — no key material.
      claudeProviders?: {
        list: () => Promise<ClaudeProviderListResult>;
        listModels: () => Promise<ClaudeProviderModelsResult>;
        upsert: (profile: {
          id?: string;
          name: string;
          baseUrl: string;
          apiKey?: string;
          model: string;
          smallFastModel?: string;
        }) => Promise<{ ok: boolean; profile?: ClaudeProviderProfile; message?: string }>;
        remove: (id: string) => Promise<{ ok: boolean; message?: string }>;
        setDefault: (id: string | null) => Promise<{ ok: boolean; message?: string }>;
        test: (payload: {
          id?: string;
          baseUrl?: string;
          apiKey?: string;
        }) => Promise<ClaudeProviderTestResult>;
      };
      updates: {
        getState: () => Promise<UpdateState>;
        check: () => Promise<UpdateActionResult>;
        download: () => Promise<UpdateActionResult>;
        restart: () => Promise<boolean>;
        listVersions: () => Promise<AppVersionList>;
        installVersion: (version: string) => Promise<UpdateActionResult>;
        onEvent: (callback: (state: UpdateState) => void) => () => void;
      };
      workspace: {
        selectFolder: () => Promise<string | null>;
        getCodeChanges: (cwd: string) => Promise<CodeChangeSummary>;
        getBranches: (cwd: string) => Promise<BranchOverview>;
        openInExplorer: (path: string) => Promise<{ ok: boolean; error?: string }>;
        openTerminal: (path: string) => Promise<{ ok: boolean; error?: string }>;
      };
      files?: {
        getPathForFile?: (file: File) => string;
        describePaths: (payload: {
          cwd: string;
          paths: string[];
        }) => Promise<FilePathDescription[]>;
      };
      agentThreads: {
        findLatest: (
          payload: AgentThreadLookupPayload
        ) => Promise<AgentThreadLookupResult>;
        // Saved-chat history for the Open Fusion resume picker (app-owned
        // OpenCode store only). Optional: older preloads may not expose it.
        list?: (
          payload: AgentThreadLookupPayload
        ) => Promise<AgentThreadListResult>;
      };
      terminal: {
        create: (payload: TerminalLaunchPayload) => Promise<boolean | { ok?: boolean; generation?: string; launchToken?: number; cancelled?: boolean; error?: string }>;
        input: (id: string, data: string, scope?: { generation?: string; launchToken?: number }) => void;
        resize: (id: string, cols: number, rows: number, scope?: { generation?: string; launchToken?: number }) => void;
        kill: (id: string, scope?: { generation?: string; launchToken?: number; reason?: "close" | "restart" }) => Promise<boolean>;
        getRuntimeSnapshots: () => Promise<TerminalRuntimeSnapshot[]>;
        onRuntime: (callback: (snapshot: TerminalRuntimeSnapshot) => void) => () => void;
        showContextMenu: (payload: {
          id: string;
          selectionText?: string;
        }) => Promise<boolean>;
        onContextMenuPaste: (
          callback: (payload: { id: string; text: string }) => void
        ) => () => void;
        onEvent: (callback: (event: TerminalEvent) => void) => () => void;
      };
      fusionChat: {
        answerQuestion(id: string, requestId: string, answers: Record<string, string[]>): Promise<{ ok: boolean; status?: string; error?: string }>;
        start: (payload: {
          id: string;
          cwd: string;
          resumeId?: string;
          // Per-role families: the planner and executor each run Claude or
          // Codex. "auto" model/effort values are omitted rather than sent.
          plannerFamily?: FusionFamily | string;
          executorFamily?: FusionFamily | string;
          plannerFast?: boolean;
          executorFast?: boolean;
          model?: string;
          executorModel?: string;
          mode?: FusionRunMode | string;
          effort?: string;
          executorEffort?: string;
          // Pins the pane's claude-family roles to a specific Claude provider
          // profile (Settings → Claude providers); the default custom profile
          // applies when omitted.
          providerProfileId?: string;
          // Legacy field names (pre-family builds).
          codexModel?: string;
          codexEffort?: string;
        }) => Promise<{ ok: boolean; error?: string }>;
        updateSettings: (
          id: string,
          settings: {
            plannerFamily?: FusionFamily | string;
            plannerFast?: boolean;
            executorFamily?: FusionFamily | string;
            executorModel?: string;
            executorEffort?: string;
            executorFast?: boolean;
            // Legacy field names (pre-family builds).
            codexModel?: string;
            codexEffort?: string;
          }
        ) => Promise<{ ok: boolean; error?: string }>;
        sendUserTurn: (id: string, text: string) => void;
        setMode: (id: string, mode: FusionRunMode | string) => Promise<{ ok: boolean; mode?: FusionRunMode; error?: string }>;
        steer: (id: string, text: string) => void;
        interrupt: (id: string) => Promise<boolean>;
        backgroundCancel: (
          id: string,
          taskId: string
        ) => Promise<{ status?: string; error?: string }>;
        buildCancel: (
          id: string,
          buildId: string
        ) => Promise<{ status?: string; error?: string }>;
        stop: (id: string) => Promise<boolean>;
        onEvent: (callback: (event: FusionChatEvent) => void) => () => void;
      };
      fusionModelCatalog?: {
        list: (payload: { family: string }) => Promise<{
          ok: boolean;
          family: string;
          models:
            | {
                id: string;
                label: string;
                supportedEfforts?: FusionCodexEffort[];
                isDefault?: boolean;
              }[]
            | null;
          error?: string;
        }>;
      };
      openFusionChat: {
        start: (payload: {
          id: string;
          cwd: string;
          resumeId?: string;
          plannerModel?: OpenFusionModel | string;
          executorModel?: OpenFusionModel | string;
        }) => Promise<{
          ok: boolean;
          error?: string;
          plannerModel?: string;
          executorModel?: string;
        }>;
        saveModels: (
          id: string,
          models: {
            plannerModel?: OpenFusionModel | string;
            executorModel?: OpenFusionModel | string;
          }
        ) => Promise<{
          ok: boolean;
          error?: string;
          models?: { plannerModel?: string | null; executorModel?: string | null };
        }>;
        requestProviders: (id: string) => Promise<{ ok: boolean; error?: string }>;
        setProviderKey: (
          id: string,
          providerId: string,
          key: string,
          metadata?: Record<string, string>,
          nonce?: string
        ) => Promise<{ ok: boolean; error?: string }>;
        removeProviderKey: (
          id: string,
          providerId: string
        ) => Promise<{ ok: boolean; error?: string }>;
        customProviderSet: (
          id: string,
          provider: {
            providerId: string;
            name: string;
            baseURL: string;
            models: { id: string; name?: string; contextLimit?: number }[];
            key?: string;
          },
          nonce?: string
        ) => Promise<{ ok: boolean; error?: string }>;
        customProviderRemove: (
          id: string,
          providerId: string
        ) => Promise<{ ok: boolean; error?: string }>;
        oauthAuthorize: (
          id: string,
          providerId: string,
          method: number,
          inputs?: Record<string, string>,
          nonce?: string
        ) => Promise<{ ok: boolean; error?: string }>;
        oauthCallback: (
          id: string,
          providerId: string,
          method: number,
          code?: string,
          nonce?: string
        ) => Promise<{ ok: boolean; error?: string }>;
        openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
        sendUserTurn: (id: string, text: string, mode?: FusionRunMode | string) => void;
        permission: (
          id: string,
          requestId: string,
          reply: "once" | "always" | "reject"
        ) => Promise<{ ok: boolean; error?: string }>;
        answerQuestion: (
          id: string,
          requestId: string,
          answers: string[][],
          revision?: number
        ) => Promise<{ ok: boolean; error?: string }>;
        questionProgress: (id: string, requestId: string, answers: string[][], revision?: number) => Promise<{ ok: boolean; error?: string; revision?: number; partialAnswers?: string[][] }>;
        rejectQuestion: (
          id: string,
          requestId: string,
          revision?: number
        ) => Promise<{ ok: boolean; error?: string }>;
        compact: (id: string) => Promise<{ ok: boolean; error?: string }>;
        interrupt: (id: string) => Promise<boolean>;
        backgroundCancel: (
          id: string,
          taskId: string
        ) => Promise<{ ok: boolean; error?: string }>;
        stop: (id: string) => Promise<boolean>;
        onEvent: (callback: (event: OpenFusionChatEvent) => void) => () => void;
      };
    };
  }
}

export {};
