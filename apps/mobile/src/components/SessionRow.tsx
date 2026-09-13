import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { Session } from '../api/types';
import { sessionNeedsInput } from '../state/needsInput';
import { colors, fontSizes, fonts, spacing } from '../theme/tokens';
import { relativeTime } from '../util/time';
import { AgentBadge } from './AgentBadge';
import { SessionDot } from './Dots';
import { RowShell } from './RowShell';
import { NeedsYouPill, StatusPill } from './StatusPill';

export type SessionRowProps = {
  session: Session;
  onPress: () => void;
};

/** One terminal, presented as a chat in a project. */
export function SessionRow({ session, onPress }: SessionRowProps) {
  const time = relativeTime(session.lastActivityAt);
  const needsYou = sessionNeedsInput(session);
  return (
    <RowShell
      onPress={onPress}
      accessibilityLabel={`Terminal ${session.title}`}
      testID={`session-row-${session.kind}-${session.id}`}
    >
      <SessionDot status={session.status} />
      <View style={styles.body}>
        <View style={styles.topLine}>
          <Text style={styles.title} numberOfLines={1}>
            {session.title}
          </Text>
          {needsYou ? (
            <NeedsYouPill testID={`session-needs-you-${session.id}`} />
          ) : (
            <StatusPill status={session.status} label={session.statusLabel} />
          )}
        </View>
        <View style={styles.bottomLine}>
          <AgentBadge kind={session.kind} />
          <Text style={styles.snippet} numberOfLines={1}>
            {session.snippet || ''}
          </Text>
          {time ? <Text style={styles.time}>{time}</Text> : null}
        </View>
      </View>
    </RowShell>
  );
}

const styles = StyleSheet.create({
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
  bottomLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  snippet: {
    flex: 1,
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.tiny,
  },
  time: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.micro,
  },
});
