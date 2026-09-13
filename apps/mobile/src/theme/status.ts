import type { SessionStatus, TaskStatus } from '../api/types';
import { colors } from './tokens';

/** Status pill text colours, transcribed from the desktop renderer. */
const PILL_TEXT: Record<string, string> = {
  waiting: '#6bd7db',
  done: '#8fd694',
  failed: '#ff8e95',
  idle: '#8f8f8f',
  working: '#f4cf5a',
  starting: '#c2c2c2',
  exited: '#c2c2c2',
};

export function statusPillColor(status: string | null | undefined): string {
  return PILL_TEXT[(status || '').trim()] || colors.textSecondary;
}

/** 7px session dot; anything that is not working, waiting or failed stays inert. */
const SESSION_DOT: Record<string, string> = {
  working: '#eac675',
  waiting: '#74b9ed',
  failed: '#ec968e',
};

export function sessionDotColor(status: string | null | undefined): string {
  return SESSION_DOT[(status || '').trim()] || colors.elementHover;
}

const STATUS_LABELS: Record<SessionStatus, string> = {
  working: 'Working',
  waiting: 'Waiting',
  done: 'Done',
  failed: 'Failed',
  idle: 'Idle',
  starting: 'Starting',
  exited: 'Exited',
};

/** The bridge sends its own label; this is the fallback when it does not. */
export function sessionStatusLabel(status: string | null | undefined, statusLabel?: string | null): string {
  const given = (statusLabel || '').trim();
  if (given) return given;
  const key = (status || '').trim() as SessionStatus;
  return STATUS_LABELS[key] || key || 'Unknown';
}

export type TaskStatusDescriptor = {
  label: string;
  color: string;
};

const TASK_STATUS: Record<string, TaskStatusDescriptor> = {
  running: { label: 'Working', color: '#60baff' },
  routing: { label: 'Working', color: '#60baff' },
  'waiting-results': { label: 'Working', color: '#60baff' },
  finished: { label: 'Done', color: '#82df9c' },
  'needs-answer': { label: 'Needs you', color: '#ffc466' },
  failed: { label: 'Error', color: '#ff808e' },
  queued: { label: 'Starting', color: '#b9b4dc' },
  paused: { label: 'Starting', color: '#b9b4dc' },
  cancelled: { label: 'Cancelled', color: '#989ca4' },
  continued: { label: 'Continued', color: '#989ca4' },
};

export function taskStatusDescriptor(status: TaskStatus | string | null | undefined): TaskStatusDescriptor {
  const key = (status || '').trim();
  return TASK_STATUS[key] || { label: key || 'Unknown', color: colors.textMuted };
}
