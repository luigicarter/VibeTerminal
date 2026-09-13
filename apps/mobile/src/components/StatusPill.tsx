import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { sessionStatusLabel, statusPillColor } from '../theme/status';
import { colors, fonts, pill } from '../theme/tokens';

/** The bordered uppercase status pill from the desktop session list. */
export function StatusPill({ status, label }: { status: string; label?: string | null }) {
  const text = sessionStatusLabel(status, label);
  if (!text) return null;
  return (
    <View style={styles.pill}>
      <Text style={[styles.text, { color: statusPillColor(status) }]} numberOfLines={1}>
        {text.toUpperCase()}
      </Text>
    </View>
  );
}

/**
 * Shown instead of the status pill while a terminal is parked on a prompt:
 * whatever the desktop calls that terminal, it is waiting for the person.
 */
export function NeedsYouPill({ testID }: { testID?: string }) {
  return (
    <View style={[styles.pill, styles.needsYou]} testID={testID}>
      <Text style={[styles.text, { color: colors.needsYou }]} numberOfLines={1}>
        NEEDS YOU
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    borderWidth: pill.borderWidth,
    borderColor: pill.borderColor,
    borderRadius: pill.radius,
    paddingVertical: pill.paddingVertical,
    paddingHorizontal: pill.paddingHorizontal,
    alignSelf: 'flex-start',
  },
  needsYou: {
    borderColor: colors.needsYou,
    backgroundColor: colors.needsYouDim,
  },
  text: {
    fontFamily: fonts.ui,
    fontSize: pill.fontSize,
    fontWeight: pill.fontWeight,
    letterSpacing: 0.4,
  },
});
