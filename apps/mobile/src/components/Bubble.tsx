import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, fontSizes, fonts, radii, spacing } from '../theme/tokens';

export type BubbleRole = 'user' | 'assistant' | 'system';

/** Chat bubble: user right on the element surface, assistant left on the panel. */
export function Bubble({
  role,
  text,
  pending = false,
}: {
  role: BubbleRole;
  text: string;
  pending?: boolean;
}) {
  if (role === 'system') {
    return (
      <View style={styles.systemWrap}>
        <Text style={styles.systemText} selectable>
          {text}
        </Text>
      </View>
    );
  }
  const mine = role === 'user';
  return (
    <View style={[styles.row, mine ? styles.rowRight : styles.rowLeft]}>
      <View style={[styles.bubble, mine ? styles.user : styles.assistant, pending && styles.pending]}>
        <Text style={styles.text} selectable>
          {text}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xxs,
  },
  rowRight: {
    justifyContent: 'flex-end',
  },
  rowLeft: {
    justifyContent: 'flex-start',
  },
  bubble: {
    maxWidth: '86%',
    borderRadius: radii.lg,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  user: {
    backgroundColor: colors.element,
  },
  assistant: {
    backgroundColor: colors.panel,
  },
  pending: {
    opacity: 0.55,
  },
  text: {
    color: colors.textPrimary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.base,
    lineHeight: 19,
  },
  systemWrap: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xxs,
    alignItems: 'center',
  },
  systemText: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.tiny,
    textAlign: 'center',
  },
});
