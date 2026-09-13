import Feather from '@expo/vector-icons/Feather';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { OrchestratorSummary } from '../api/types';
import { orchestratorSubtitle } from '../state/presence';
import { colors, fontSizes, fonts, radii, spacing } from '../theme/tokens';
import { oneLine } from '../util/time';
import { BrandChip } from './BrandChip';
import { RowShell } from './RowShell';

export type AskLinaRowProps = {
  orchestrator: OrchestratorSummary | null;
  snippet: string;
  onPress: () => void;
};

/** The pinned Orchestrator conversation at the top of the home list. */
export function AskLinaRow({ orchestrator, snippet, onPress }: AskLinaRowProps) {
  // Before the first state arrives the row knows nothing, so it claims nothing.
  const subtitle = orchestratorSubtitle(orchestrator);
  const active = orchestrator?.activeCount ?? 0;
  return (
    <RowShell onPress={onPress} accessibilityLabel="Ask Lina" testID="row-ask-lina">
      <BrandChip />
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          Ask Lina
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {subtitle}
        </Text>
        {snippet ? (
          <Text style={styles.snippet} numberOfLines={1}>
            {oneLine(snippet)}
          </Text>
        ) : null}
      </View>
      {active > 0 ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{active}</Text>
        </View>
      ) : null}
      <Feather name="chevron-right" size={16} color={colors.textMuted} />
    </RowShell>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  title: {
    color: colors.textPrimary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.base,
    fontWeight: '600',
  },
  subtitle: {
    color: colors.textSecondary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.tiny,
  },
  snippet: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.tiny,
  },
  badge: {
    minWidth: 20,
    paddingHorizontal: spacing.xs,
    paddingVertical: 1,
    borderRadius: radii.pill,
    backgroundColor: colors.waitingDim,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.waiting,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: colors.waiting,
    fontFamily: fonts.ui,
    fontSize: fontSizes.micro,
    fontWeight: '700',
  },
});
