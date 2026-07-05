import type {
  AgentThreadListResult,
  AgentThreadLookupPayload,
  AgentThreadLookupResult,
  AgentThreadRef,
  CodeChangeSummary,
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

export interface FilePathDescription {
  path: string;
  kind: "text" | "image" | "directory" | "file" | "missing";
  label: string;
  lineCount?: number;
  error?: string;
}

declare global {
  interface Window {
    vibe?: {
      platform: string;
      app: {
        getCwd: () => Promise<string>;
        screenshotFixture?: {
          mode: "openfusion";
          cwd: string;
          openCodeCommand?: string;
        } | null;
        getScreenshotFixture?: () => Promise<{
          mode: "openfusion";
          cwd: string;
          openCodeCommand?: string;
        } | null>;
      };
      clipboard: {
        readText: () => string;
        writeText: (text: string) => void;
        readFilePaths?: () => string[];
      };
      updates: {
        getState: () => Promise<UpdateState>;
        check: () => Promise<UpdateActionResult>;
        download: () => Promise<UpdateActionResult>;
        restart: () => Promise<boolean>;
        onEvent: (callback: (state: UpdateState) => void) => () => void;
      };
      workspace: {
        selectFolder: () => Promise<string | null>;
        getCodeChanges: (cwd: string) => Promise<CodeChangeSummary>;
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
        create: (payload: TerminalLaunchPayload) => Promise<boolean>;
        input: (id: string, data: string) => void;
        resize: (id: string, cols: number, rows: number) => void;
        kill: (id: string) => Promise<boolean>;
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
        stop: (id: string) => Promise<boolean>;
        onEvent: (callback: (event: FusionChatEvent) => void) => () => void;
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
          answers: string[][]
        ) => Promise<{ ok: boolean; error?: string }>;
        rejectQuestion: (
          id: string,
          requestId: string
        ) => Promise<{ ok: boolean; error?: string }>;
        compact: (id: string) => Promise<{ ok: boolean; error?: string }>;
        interrupt: (id: string) => Promise<boolean>;
        stop: (id: string) => Promise<boolean>;
        onEvent: (callback: (event: OpenFusionChatEvent) => void) => () => void;
      };
    };
  }
}

export {};
