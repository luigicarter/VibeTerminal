import type {
  AgentThreadListResult,
  AgentThreadLookupPayload,
  AgentThreadLookupResult,
  AgentThreadRef,
  CodeChangeSummary,
  FusionCodexEffort,
  FusionCodexModel,
  FusionEffort,
  FusionRunMode,
  FusionChatEvent,
  FusionClaudeModel,
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
          model?: FusionClaudeModel | string;
          codexModel?: FusionCodexModel | string;
          mode?: FusionRunMode | string;
          effort?: Exclude<FusionEffort, "auto"> | string;
          codexEffort?: Exclude<FusionCodexEffort, "auto"> | string;
        }) => Promise<{ ok: boolean; error?: string }>;
        updateSettings: (
          id: string,
          settings: {
            codexModel?: FusionCodexModel | string;
            codexEffort?: FusionCodexEffort | string;
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
        sendUserTurn: (id: string, text: string) => void;
        permission: (
          id: string,
          requestId: string,
          reply: "once" | "always" | "reject"
        ) => Promise<{ ok: boolean; error?: string }>;
        interrupt: (id: string) => Promise<boolean>;
        stop: (id: string) => Promise<boolean>;
        onEvent: (callback: (event: OpenFusionChatEvent) => void) => () => void;
      };
    };
  }
}

export {};
