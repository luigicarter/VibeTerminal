import { Platform } from 'react-native';

/**
 * Visual tokens copied from the desktop renderer so the phone app reads as the
 * same product. Values are literal on purpose: the desktop owns the design and
 * this file is the transcription, not a reinterpretation.
 */

export const colors = {
  /** Application background. */
  app: '#101010',
  /** Sidebar and header bars. */
  sidebar: '#141414',
  /** Panels sitting on the app background. */
  panel: '#181818',
  /** Raised surfaces: composer, cards. */
  surface: '#202020',
  /** Interactive elements: buttons, user bubbles. */
  element: '#292929',
  /** Hover / pressed state for elements. */
  elementHover: '#363636',

  textPrimary: '#ededed',
  textSecondary: '#b8b8b8',
  textMuted: '#929292',

  accent: '#d4d4d4',

  borderHairline: 'rgba(255,255,255,0.09)',
  borderStrong: '#404040',
  borderFocus: '#808080',

  working: '#f4cf5a',
  workingDim: 'rgba(244,207,90,0.25)',
  done: '#6fcf97',
  waiting: '#4da3ff',
  waitingDim: 'rgba(77,163,255,0.12)',
  failed: '#f08a7a',
  idle: '#8f8f8f',

  /** A terminal parked on a prompt: the "NEEDS YOU" pill and its chips. */
  needsYou: '#ffc466',
  needsYouDim: 'rgba(255,196,102,0.14)',

  /** Terminal output block. */
  terminalBackground: '#17181c',
  terminalText: '#ededf0',
} as const;

export const spacing = {
  xxs: 3,
  xs: 6,
  sm: 9,
  md: 12,
  lg: 16,
  xl: 22,
} as const;

export const radii = {
  sm: 7,
  md: 10,
  lg: 14,
  pill: 999,
} as const;

export const fontSizes = {
  micro: 10,
  tiny: 11,
  small: 12,
  base: 13,
  title: 15,
  heading: 18,
} as const;

export const fonts = {
  ui: Platform.select({
    ios: 'System',
    android: 'sans-serif',
    web: 'Inter, system-ui, sans-serif',
    default: 'System',
  }),
  mono: Platform.select({
    ios: 'Menlo',
    android: 'monospace',
    web: '"Cascadia Mono", Consolas, monospace',
    default: 'monospace',
  }),
} as const;

/** Status pill: 1px border, fully rounded, uppercase 10px bold. */
export const pill = {
  borderColor: '#4f4f4f',
  borderWidth: 1,
  radius: radii.pill,
  paddingVertical: 2,
  paddingHorizontal: 7,
  fontSize: fontSizes.micro,
  fontWeight: '700' as const,
} as const;

/** The terminal text block. */
export const terminalBlock = {
  background: colors.terminalBackground,
  color: colors.terminalText,
  fontSize: fontSizes.small,
  lineHeight: Math.round(fontSizes.small * 1.35 * 100) / 100,
} as const;

/** Brand mark chip. */
export const brandChip = {
  size: 30,
  radius: 9,
  background: colors.panel,
} as const;

export const dotSizes = {
  session: 7,
  attention: 7,
  attentionHalo: 3,
  workingRing: 9,
  agent: 6,
  tallyGlyph: 9,
} as const;

/**
 * The rules every screen obeys, so the app reads as one thing: one gutter, one
 * header height, one smallest touch target. A control may be drawn smaller than
 * `minTarget` — a 34px icon looks right where a 44px one looks clumsy — but the
 * area a finger may land on never is; `touchArea` below is how that is kept.
 */
export const layout = {
  /** The side gutter on every screen, row, header, bar and sheet. */
  gutter: spacing.lg,
  /** The smallest area a finger may have to hit, in dp. */
  minTarget: 44,
  /** The header's content height, above the top safe-area inset. */
  headerHeight: 44,
  /** The bottom sheets' grab handle. */
  grabberWidth: 36,
  grabberHeight: 4,
} as const;

/**
 * `hitSlop` that grows a control drawn `width` x `height` out to `minTarget`.
 * Everything icon-sized in this app goes through it rather than guessing.
 */
export function touchArea(width: number, height: number = width) {
  const horizontal = Math.max(0, Math.ceil((layout.minTarget - width) / 2));
  const vertical = Math.max(0, Math.ceil((layout.minTarget - height) / 2));
  return { top: vertical, bottom: vertical, left: horizontal, right: horizontal };
}
