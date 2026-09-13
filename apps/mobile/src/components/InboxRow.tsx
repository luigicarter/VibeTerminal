import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { Session } from '../api/types';
import { promptLine } from '../state/needsInput';
import { colors, fontSizes, fonts, spacing } from '../theme/tokens';
import { AgentBadge } from './AgentBadge';
import { RowShell } from './RowShell';

/**
 * One terminal in the "Waiting for you" inbox: what it is, where it is, and the
 * first line of what it is asking. Tapping it opens that terminal.
 */
export function InboxRow({ session, onPress }: { session: Session; onPress: () => void }) {
  const line = promptLine(session);
  return (
    <RowShell
      onPress={onPress}
      accessibilityLabel={`Waiting: ${session.title}`}
      testID={`inbox-row-${session.id}`}
    >
      <View style={styles.marker} />
      <View style={styles.body}>
        <View style={styles.topLine}>
          <Text style={styles.title} numberOfLines={1}>
            {session.title}
          </Text>
          <AgentBadge kind={session.kind} />
        </View>
        <Text style={styles.project} numberOfLines={1}>
          {session.projectName}
        </Text>
        {line ? (
          <Text style={styles.prompt} numberOfLines={1}>
            {line}
          </Text>
        ) : null}
      </View>
    </RowShell>
  );
}

const styles = StyleSheet.create({
  marker: {
    width: 3,
    alignSelf: 'stretch',
    minHeight: 30,
    borderRadius: 2,
    backgroundColor: colors.needsYou,
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xxs,
  },
  topLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  title: {
    flex: 1,
    color: colors.textPrimary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.base,
    fontWeight: '600',
  },
  project: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.micro,
  },
  prompt: {
    color: colors.needsYou,
    fontFamily: fonts.ui,
    fontSize: fontSizes.tiny,
  },
});
