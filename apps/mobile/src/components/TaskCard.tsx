import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { OrchestratorTask, Session } from '../api/types';
import { taskStatusDescriptor } from '../theme/status';
import { colors, fontSizes, fonts, pill, radii, spacing } from '../theme/tokens';

export type TaskCardProps = {
  task: OrchestratorTask;
  /** Used to name the terminal the task was handed to. */
  terminal?: Session | null;
  projectName?: string | null;
};

/** One Orchestrator task, shown inline in the Ask Lina conversation. */
export function TaskCard({ task, terminal, projectName }: TaskCardProps) {
  const { label, color } = taskStatusDescriptor(task.status);
  const target = [terminal?.title || (task.terminalId ? 'a terminal' : null), projectName || null]
    .filter(Boolean)
    .join(' · ');
  const detail = task.error || task.result || task.summary || '';
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.title} numberOfLines={3} selectable>
          {task.text}
        </Text>
        <View style={[styles.chip, { borderColor: color }]}>
          <Text style={[styles.chipText, { color }]}>{label.toUpperCase()}</Text>
        </View>
      </View>
      {target ? (
        <Text style={styles.meta} numberOfLines={1}>
          {target}
        </Text>
      ) : null}
      {detail ? (
        <Text style={[styles.detail, task.error ? styles.detailError : null]} selectable>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing.md,
    marginVertical: spacing.xxs,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHairline,
    padding: spacing.sm,
    gap: spacing.xxs,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
  },
  title: {
    flex: 1,
    color: colors.textPrimary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.small,
    fontWeight: '600',
  },
  chip: {
    borderWidth: pill.borderWidth,
    borderRadius: pill.radius,
    paddingVertical: pill.paddingVertical,
    paddingHorizontal: pill.paddingHorizontal,
  },
  chipText: {
    fontFamily: fonts.ui,
    fontSize: pill.fontSize,
    fontWeight: pill.fontWeight,
    letterSpacing: 0.4,
  },
  meta: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.tiny,
  },
  detail: {
    color: colors.textSecondary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.small,
    lineHeight: 17,
  },
  detailError: {
    color: colors.failed,
  },
});
