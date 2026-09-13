import { LayoutAnimation, Platform, UIManager } from 'react-native';

/**
 * The app's one piece of in-place motion.
 *
 * Sections that come and go on their own — the "Waiting for you" inbox, the
 * prompt-chips card — slide the rest of the list rather than teleporting it.
 * Everything else that moves is a navigation transition, which the stack owns.
 */

/**
 * Old-architecture Android does nothing with LayoutAnimation until this is
 * switched on. The New Architecture animates layout without it — and warns if
 * it is asked — so the switch is only thrown where it is still a switch.
 */
export function enableLayoutAnimation(): void {
  if (Platform.OS !== 'android') return;
  const fabric = (globalThis as { nativeFabricUIManager?: unknown }).nativeFabricUIManager;
  if (fabric) return;
  UIManager.setLayoutAnimationEnabledExperimental?.(true);
}

const SECTION = LayoutAnimation.create(
  180,
  LayoutAnimation.Types.easeInEaseOut,
  LayoutAnimation.Properties.opacity
);

/**
 * Animate the next layout pass. Never called while the terminal is streaming —
 * the terminal is a WebView and animating around it fights the stream.
 */
export function animateSection(): void {
  if (Platform.OS === 'web') return;
  LayoutAnimation.configureNext(SECTION);
}
