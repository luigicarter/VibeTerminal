import { colors } from './tokens';

/**
 * Agent labels and accent colours, transcribed from the desktop renderer.
 * A kind the desktop grows later falls back to the raw kind string in muted
 * text rather than disappearing from the list.
 */

export type AgentDescriptor = {
  label: string;
  accent: string;
};

const AGENTS: Record<string, AgentDescriptor> = {
  terminal: { label: 'Terminal', accent: '#f4cf5a' },
  codex: { label: 'Codex', accent: '#ff9f43' },
  'open-codex': { label: 'Open Codex', accent: '#df9e55' },
  'codex-web': { label: 'Codex Web', accent: '#ff9f43' },
  claude: { label: 'Claude', accent: '#8fd694' },
  'claude-custom': { label: 'Open Claude Code', accent: '#d97757' },
  fusion: { label: 'Fusion', accent: '#b98bff' },
  openfusion: { label: 'Open Fusion', accent: '#2ee8be' },
  cursor: { label: 'Cursor', accent: '#46c2c9' },
  gemini: { label: 'Gemini', accent: '#70a8ff' },
  opencode: { label: 'OpenCode', accent: '#c78bff' },
  kimi: { label: 'Kimi', accent: '#1e88e5' },
  'kimi-custom': { label: 'Kimi + CC', accent: '#8e24aa' },
  qwen: { label: 'Qwen', accent: '#6d7cff' },
  grok: { label: 'Grok Build', accent: '#d8e2ef' },
};

export function agentDescriptor(kind: string | null | undefined): AgentDescriptor {
  const key = (kind || '').trim();
  return AGENTS[key] || { label: key || 'Unknown', accent: colors.textMuted };
}

export function agentLabel(kind: string | null | undefined): string {
  return agentDescriptor(kind).label;
}

export function agentAccent(kind: string | null | undefined): string {
  return agentDescriptor(kind).accent;
}
