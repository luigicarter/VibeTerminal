import React from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { colors, layout, spacing } from '../theme/tokens';

/** The shared list-row frame: hairline separator, press feedback, padding. */
export function RowShell({
  onPress,
  children,
  accessibilityLabel,
  testID,
}: {
  onPress: () => void;
  children: React.ReactNode;
  accessibilityLabel?: string;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {children}
    </Pressable>
  );
}

export function RowSeparator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: layout.minTarget,
    paddingHorizontal: layout.gutter,
    paddingVertical: spacing.md,
    backgroundColor: colors.app,
    ...Platform.select({ web: { cursor: 'pointer' as const }, default: {} }),
  },
  pressed: {
    backgroundColor: colors.panel,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: layout.gutter,
    backgroundColor: colors.borderHairline,
  },
});
