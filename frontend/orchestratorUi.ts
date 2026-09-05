import type { AgentSession } from "./types";
import type { HISTORY_CONFIG_FIELDS } from "./orchestratorHistory";
import { useEffect, useState } from "react";
export interface RelaySession extends Partial<Pick<AgentSession, typeof HISTORY_CONFIG_FIELDS[number] | "threadRef" | "resumeRef" | "fusion" | "openFusion">> {
    id: string;
    generation?: string;
    started?: boolean;
    launchToken?: number;
    revision?: number;
    kind: string;
    name: string;
    cwd: string;
    projectName?: string;
    status: string;
    statusLabel?: string;
    observation?: string;
    lastTool?: string;
    model?: string;
}
export interface RelayResult {
    ok: boolean;
    error?: string;
    status?: string;
    [key: string]: unknown;
}
export interface RelayState {
    enabled: boolean;
    ready: boolean;
    busy: boolean;
    phase: string;
    error?: string;
    settings: {
        hasKey: boolean;
        model: string;
        sttModel?: string;
        ttsModel?: string;
        voice?: string;
        language?: string;
        monitoringIntervalSeconds?: number;
        spendingLimit?: number;
        microphoneId?: string;
    };
    sessions: RelaySession[];
    messages: {
        id: string;
        role: string;
        text: string;
        at: number;
    }[];
    receipts: {
        id: string;
        kind: string;
        status: string;
        text: string;
        at: number;
    }[];
    requests: {
        id: string;
        sessionId: string;
        revision: number;
        kind: string;
        state: string;
        detail?: string;
        questions: {
            question: string;
            options?: {
                label: string;
            }[];
        }[];
    }[];
    usage: Record<string, unknown>;
    preferences: {
        id: string;
        text: string;
    }[];
}
export interface RelayApi {
    getState(): Promise<RelayState>;
    onState(callback: (state: RelayState) => void): () => void;
    configure(patch: Record<string, unknown>): Promise<RelayResult>;
    models(kind?: "brain" | "transcription" | "speech"): Promise<{
        id: string;
        name?: string;
        label?: string;
    }[]>;
    testConnection(): Promise<RelayResult>;
    setEnabled(enabled: boolean): Promise<RelayResult>;
    send(input: {
        text: string;
        origin: "text" | "voice";
        targetId?: string;
    }): Promise<RelayResult>;
    cancel(): Promise<RelayResult>;
    dispatch(input: Record<string, unknown>): Promise<RelayResult>;
    preferences(input: Record<string, unknown>): Promise<RelayResult>;
    showOverlay(): Promise<RelayResult>;
    onUiAction(callback: (action: {
        id: string;
        kind: string;
        payload: Record<string, unknown>;
    }) => void): () => void;
    completeUiAction(id: string, result: Record<string, unknown>): void;
}
export function relayApi(): RelayApi | undefined { return (window.vibe as unknown as {
    orchestrator?: RelayApi;
})?.orchestrator; }
export function useOrchestrator() {
    const [state, setState] = useState<RelayState | null>(null);
    useEffect(() => {
        const api = relayApi();
        if (!api)
            return;
        let live = true;
        let received = false;
        const unsubscribe = api.onState(next => { received = true; if (live)
            setState(next); });
        void api.getState().then(next => { if (live && !received)
            setState(next); }).catch(() => { });
        return () => { live = false; unsubscribe(); };
    }, []);
    return state;
}
