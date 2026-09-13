import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { ProjectCounts } from '../api/types';
import { colors, dotSizes, fontSizes, fonts, spacing } from '../theme/tokens';

type Bucket = {
  key: keyof ProjectCounts;
  label: string;
  color: string;
  glyph: string | null;
};

const BUCKETS: Bucket[] = [
  { key: 'working', label: 'working', color: colors.working, glyph: null },
  { key: 'done', label: 'done', color: colors.done, glyph: '✓' },
  { key: 'waiting', label: 'waiting', color: colors.waiting, glyph: '△' },
  { key: 'failed', label: 'failed', color: colors.failed, glyph: '✕' },
];

/** "2 working · 1 done" — empty buckets are left out, as on the desktop. */
export function ProjectTally({ counts }: { counts: ProjectCounts }) {
  const present = BUCKETS.filter(bucket => (counts?.[bucket.key] ?? 0) > 0);
  if (present.length === 0) return null;
  return (
    <View style={styles.row}>
      {present.map(bucket => (
        <View key={bucket.key} style={styles.item}>
          {bucket.glyph === null ? (
            <View style={[styles.ring, { borderColor: bucket.color }]} />
          ) : (
            <Text style={[styles.glyph, { color: bucket.color }]}>{bucket.glyph}</Text>
          )}
          <Text style={styles.label}>
            {counts[bucket.key]} {bucket.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  ring: {
    width: dotSizes.tallyGlyph,
    height: dotSizes.tallyGlyph,
    borderRadius: dotSizes.tallyGlyph / 2,
    borderWidth: 2,
  },
  glyph: {
    fontFamily: fonts.ui,
    fontSize: dotSizes.tallyGlyph,
    lineHeight: dotSizes.tallyGlyph + 2,
  },
  label: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.tiny,
  },
});
