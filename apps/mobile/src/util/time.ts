import { toMillis } from '../api/types';
import type { Timestamp } from '../api/types';

/** "now", "2m", "1h", "3d" — the compact form the desktop list uses. */
export function relativeTime(value: Timestamp | undefined, now = Date.now()): string {
  const millis = toMillis(value);
  if (millis === null) return '';
  const delta = Math.max(0, now - millis);
  const seconds = Math.floor(delta / 1000);
  if (seconds < 45) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  return `${Math.floor(days / 30)}mo`;
}

/** "14:32" for a clock reading, used by the Settings connection card. */
export function clockTime(value: Timestamp | undefined): string {
  const millis = toMillis(value);
  if (millis === null) return '';
  const date = new Date(millis);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

/** Collapse whitespace so a snippet stays on one line. */
export function oneLine(text: string | null | undefined, limit = 160): string {
  const flat = (text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit - 1)}…`;
}
