import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { useBridge } from '../state/bridge';
import { colors, fontSizes, fonts, layout, radii, spacing, touchArea } from '../theme/tokens';
import { useConnectionTone } from './ConnectionDot';

/**
 * A slim strip under the header whenever the desktop is not answering.
 *
 * The connection dot is still there and still the quick signal, but a coloured
 * dot cannot say *which* desktop is unreachable or offer to try again, and on
 * the terminal screen there is no dot at all. This says both, in one line, and
 * disappears the moment a poll lands.
 */
/**
 * One dropped request is not an outage. A retry that is already succeeding
 * should not flash a banner, so "reconnecting" has to hold for this long first;
 * "can't reach" has already waited through three failures and shows at once.
 */
const SETTLE_MS = 1200;

export function ConnectionBanner({ testID = 'connection-banner' }: { testID?: string }) {
  const { pairing, refresh } = useBridge();
  const tone = useConnectionTone();
  const [retrying, setRetrying] = useState(false);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (tone !== 'reconnecting') {
      setSettled(false);
      return;
    }
    const timer = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [tone]);

  const retry = useCallback(async () => {
    setRetrying(true);
    try {
      await refresh();
    } finally {
      setRetrying(false);
    }
  }, [refresh]);

  if (tone === 'reconnecting' ? !settled : tone !== 'failed') return null;

  const desktop = pairing?.desktopHost || pairing?.host || 'the desktop';
  const failed = tone === 'failed';

  return (
    <View
      style={[styles.bar, failed && styles.barFailed]}
      testID={failed ? `${testID}-offline` : `${testID}-reconnecting`}
      accessibilityRole="alert"
    >
      {failed ? (
        <View style={[styles.dot, styles.dotFailed]} />
      ) : (
        <ActivityIndicator size="small" color={colors.working} />
      )}
      <Text style={[styles.text, failed && styles.textFailed]} numberOfLines={1}>
        {failed ? `Can't reach ${desktop}` : `Reconnecting to ${desktop}…`}
      </Text>
      {failed ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry"
          testID={`${testID}-retry`}
          disabled={retrying}
          onPress={() => void retry()}
          hitSlop={touchArea(56, 26)}
          style={({ pressed }) => [styles.retry, pressed && styles.retryPressed]}
        >
          <Text style={styles.retryLabel}>{retrying ? 'Retrying…' : 'Retry'}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: layout.gutter,
    paddingVertical: spacing.xs,
    backgroundColor: colors.panel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.workingDim,
  },
  barFailed: {
    borderBottomColor: colors.failed,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  dotFailed: {
    backgroundColor: colors.failed,
  },
  text: {
    flex: 1,
    color: colors.working,
    fontFamily: fonts.ui,
    fontSize: fontSizes.tiny,
  },
  textFailed: {
    color: colors.failed,
  },
  retry: {
    minHeight: 26,
    paddingHorizontal: spacing.sm,
    justifyContent: 'center',
    borderRadius: radii.pill,
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
    fontSize: fontSizes.tiny,
    fontWeight: '600',
  },
});
