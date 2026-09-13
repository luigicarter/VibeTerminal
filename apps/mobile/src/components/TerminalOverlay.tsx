import React from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fontSizes, fonts, radii, spacing } from '../theme/tokens';
import { TERMINAL_ERROR_TEXT, TERMINAL_EXIT_TEXT, type TerminalPhase } from './liveTerminalState';

/**
 * What is drawn over the live terminal while it is not showing a terminal: a
 * spinner until the page is ready, a muted notice when the session ends, and
 * the retry when the page could not load.
 */
export function TerminalOverlay({
  phase,
  detail,
  onRetry,
  testID = 'terminal-overlay',
}: {
  phase: TerminalPhase;
  detail?: string | null;
  onRetry: () => void;
  testID?: string;
}) {
  if (phase === 'ready') return null;
  return (
    <View style={[styles.overlay, phase === 'exit' && styles.overlayQuiet]} testID={testID} pointerEvents="box-none">
      {phase === 'loading' ? (
        <ActivityIndicator size="small" color={colors.textMuted} />
      ) : phase === 'exit' ? (
        <Text style={styles.quiet} testID={`${testID}-exit`}>
          {TERMINAL_EXIT_TEXT}
        </Text>
      ) : (
        <View style={styles.errorBlock}>
          <Text style={styles.errorTitle} testID={`${testID}-error`}>
            {TERMINAL_ERROR_TEXT}
          </Text>
          {detail ? <Text style={styles.errorDetail}>{detail}</Text> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry"
            testID={`${testID}-retry`}
            onPress={onRetry}
            style={({ pressed }) => [styles.retry, pressed && styles.retryPressed]}
          >
            <Text style={styles.retryLabel}>Retry</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    backgroundColor: colors.terminalBackground,
  },
  overlayQuiet: {
    backgroundColor: 'rgba(23,24,28,0.72)',
    justifyContent: 'flex-end',
  },
  quiet: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.small,
    textAlign: 'center',
    paddingBottom: spacing.md,
  },
  errorBlock: {
    alignItems: 'center',
    gap: spacing.xs,
  },
  errorTitle: {
    color: colors.textSecondary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.base,
    textAlign: 'center',
  },
  errorDetail: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.tiny,
    textAlign: 'center',
  },
  retry: {
    marginTop: spacing.xs,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.md,
    backgroundColor: colors.element,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHairline,
    ...Platform.select({ web: { cursor: 'pointer' as const }, default: {} }),
  },
  retryPressed: {
    backgroundColor: colors.elementHover,
  },
  retryLabel: {
    color: colors.textPrimary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.small,
    fontWeight: '600',
  },
});
