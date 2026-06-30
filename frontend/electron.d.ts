import type {
  AgentThreadLookupPayload,
  AgentThreadLookupResult,
  AgentThreadRef,
  CodeChangeSummary,
  FusionCodexModel,
  FusionEffort,
  FusionChatEvent,
  FusionClaudeModel,
  TerminalEvent,
  TerminalLaunchPayload,
  UpdateActionResult,
  UpdateState
} from "./types";

declare global {
  interface Window {
    vibe?: {
      platform: string;
      app: {
        getCwd: () => Promise<string>;
      };
      clipboard: {
        readText: () => string;
        writeText: (text: string) => void;
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
      agentThreads: {
        findLatest: (
          payload: AgentThreadLookupPayload
        ) => Promise<AgentThreadLookupResult>;
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
          effort?: Exclude<FusionEffort, "auto"> | string;
        }) => Promise<{ ok: boolean; error?: string }>;
        sendUserTurn: (id: string, text: string) => void;
        stop: (id: string) => Promise<boolean>;
        onEvent: (callback: (event: FusionChatEvent) => void) => () => void;
      };
    };
  }
}

export {};
