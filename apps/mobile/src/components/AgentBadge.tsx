import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { agentDescriptor } from '../theme/agents';
import { colors, fontSizes, fonts, spacing } from '../theme/tokens';
import { AgentDot } from './Dots';

/** Accent dot plus the agent's display name, as the desktop labels panes. */
export function AgentBadge({ kind }: { kind: string }) {
  const { label, accent } = agentDescriptor(kind);
  return (
    <View style={styles.row}>
      <AgentDot color={accent} />
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  label: {
    color: colors.textSecondary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.tiny,
  },
});
