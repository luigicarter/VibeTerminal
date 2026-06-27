import type {
  AgentThreadLookupPayload,
  AgentThreadLookupResult,
  AgentThreadRef,
  CodeChangeSummary,
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
        onEvent: (callback: (event: TerminalEvent) => void) => () => void;
      };
    };
  }
}

export {};
