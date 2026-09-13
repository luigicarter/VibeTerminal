import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fontSizes, fonts, layout, radii, spacing } from '../theme/tokens';

/** Every screen sits on the app background. */
export function Screen({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.screen, style]}>{children}</View>;
}

/**
 * The left and right safe-area insets, for the scrolling content of a screen.
 *
 * In portrait these are zero. In landscape a notch takes one side and the
 * gesture bar the other, and a list that ignores them puts its text under the
 * cut-out. Headers and bars apply their own; this is for everything between.
 */
export function useSideInsets(): { paddingLeft: number; paddingRight: number } {
  const insets = useSafeAreaInsets();
  return { paddingLeft: insets.left, paddingRight: insets.right };
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export type EmptyStateProps = {
  title: string;
  detail?: string;
  /** Every empty state offers the one thing there is to do next. */
  actionLabel?: string;
  onAction?: () => void;
  testID?: string;
};

/** One short line saying what is not here, and one thing to do about it. */
export function EmptyState({ title, detail, actionLabel, onAction, testID }: EmptyStateProps) {
  return (
    <View style={styles.empty} testID={testID}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {detail ? <Text style={styles.emptyDetail}>{detail}</Text> : null}
      {actionLabel && onAction ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          testID={testID ? `${testID}-action` : undefined}
          onPress={onAction}
          style={({ pressed }) => [styles.emptyAction, pressed && styles.emptyActionPressed]}
        >
          <Text style={styles.emptyActionLabel}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Divider() {
  return <View style={styles.divider} />;
}

export function Banner({ tone = 'muted', text }: { tone?: 'muted' | 'error'; text: string }) {
  return (
    <View style={[styles.banner, tone === 'error' && styles.bannerError]}>
      <Text style={[styles.bannerText, tone === 'error' && styles.bannerTextError]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.app,
  },
  sectionTitle: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.tiny,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    paddingHorizontal: layout.gutter,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
  },
  empty: {
    paddingHorizontal: layout.gutter,
    paddingVertical: spacing.xl,
    alignItems: 'center',
    gap: spacing.xs,
  },
  emptyTitle: {
    color: colors.textSecondary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.base,
    textAlign: 'center',
  },
  emptyDetail: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.tiny,
    textAlign: 'center',
  },
  emptyAction: {
    marginTop: spacing.xs,
    minHeight: layout.minTarget,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    borderRadius: radii.md,
    backgroundColor: colors.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHairline,
    ...Platform.select({ web: { cursor: 'pointer' as const }, default: {} }),
  },
  emptyActionPressed: {
    backgroundColor: colors.surface,
  },
  emptyActionLabel: {
    color: colors.textPrimary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.base,
    fontWeight: '600',
  },
  card: {
    backgroundColor: colors.panel,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHairline,
    padding: spacing.md,
    gap: spacing.xs,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderHairline,
  },
  banner: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHairline,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  bannerError: {
    borderColor: colors.failed,
  },
  bannerText: {
    color: colors.textSecondary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.small,
  },
  bannerTextError: {
    color: colors.failed,
  },
});
