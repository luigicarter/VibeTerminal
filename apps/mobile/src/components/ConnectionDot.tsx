import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { TONE_LABELS } from '../state/presence';
import { ConnectionTone, connectionTone, useBridge } from '../state/bridge';
import { colors } from '../theme/tokens';

const TONE_COLORS: Record<ConnectionTone, string> = {
  connected: colors.done,
  reconnecting: colors.working,
  failed: colors.failed,
  // Nothing has failed yet, and a paused loop is not a fault: stay neutral.
  connecting: colors.textMuted,
  paused: colors.textMuted,
};

/** Re-reads the tone on a timer so freshness expires without a poll. */
export function useConnectionTone(): ConnectionTone {
  const { status, lastSuccessAt, appActive } = useBridge();
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick(value => value + 1), 5000);
    return () => clearInterval(timer);
  }, []);
  return connectionTone(status, lastSuccessAt, { appActive });
}

export function connectionToneColor(tone: ConnectionTone): string {
  return TONE_COLORS[tone];
}

export function connectionToneLabel(tone: ConnectionTone): string {
  return (TONE_LABELS as Record<string, string>)[tone] || tone;
}

/** Green when the last poll landed, yellow while retrying, red when it failed. */
export function ConnectionDot({ tone, size = 7 }: { tone: ConnectionTone; size?: number }) {
  return (
    <View
      accessibilityLabel={connectionToneLabel(tone)}
      style={[
        styles.dot,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: TONE_COLORS[tone] },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  dot: {
    alignSelf: 'center',
  },
});
