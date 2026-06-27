import type {
  AgentThreadLookupPayload,
  AgentThreadLookupResult,
  AgentThreadRef,
  TerminalEvent,
  TerminalLaunchPayload
} from "./types";

declare global {
  interface Window {
    vibe?: {
      app: {
        getCwd: () => Promise<string>;
      };
      workspace: {
        selectFolder: () => Promise<string | null>;
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
