import Feather from '@expo/vector-icons/Feather';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { Project, ProjectCounts } from '../api/types';
import { colors, fontSizes, fonts } from '../theme/tokens';
import { AttentionDot, DotSpacer } from './Dots';
import { ProjectTally } from './ProjectTally';
import { RowShell } from './RowShell';

export type ProjectRowProps = {
  project: Project;
  attention: boolean;
  /** The tally to show, when it is not simply the desktop's own counts. */
  counts?: ProjectCounts;
  onPress: () => void;
};

/** One project in the home list. */
export function ProjectRow({ project, attention, counts, onPress }: ProjectRowProps) {
  const tally = counts ?? project.counts;
  const working = (tally?.working ?? 0) > 0;
  return (
    <RowShell
      onPress={onPress}
      accessibilityLabel={`Project ${project.name}`}
      testID={`project-row-${project.id}`}
    >
      {attention ? <AttentionDot /> : working ? <AttentionDot working /> : <DotSpacer />}
      <Feather name="folder" size={16} color={colors.textMuted} />
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={1}>
          {project.name}
        </Text>
        <Text style={styles.path} numberOfLines={1} ellipsizeMode="head">
          {project.path}
        </Text>
        <ProjectTally counts={tally} />
      </View>
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
  name: {
    color: colors.textPrimary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.base,
    fontWeight: '600',
  },
  path: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.tiny,
  },
});
