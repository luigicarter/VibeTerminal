import Feather from '@expo/vector-icons/Feather';
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fontSizes, fonts, layout, radii, spacing, touchArea } from '../theme/tokens';

export type HeaderAction = {
  icon: keyof typeof Feather.glyphMap;
  /** Also the test hook: `header-action-<label>`, lowercased and hyphenated. */
  label: string;
  onPress: () => void;
};

export type AppHeaderProps = {
  title: string;
  subtitle?: string | null;
  /** Rendered under the title instead of `subtitle` when richer content is needed. */
  subtitleContent?: React.ReactNode;
  /** Rendered to the left of the title, e.g. the brand chip. */
  leading?: React.ReactNode;
  onBack?: () => void;
  /**
   * A screen presented as a modal closes rather than goes back, so it says so:
   * an X instead of a chevron, and "Close" instead of "Back".
   */
  backIcon?: 'chevron-left' | 'x';
  /** A modal screen draws the sheet's grab handle above its title. */
  grabber?: boolean;
  actions?: HeaderAction[];
};

/** Every icon button in the header is drawn this big… */
const ICON_BUTTON = 36;

/**
 * One header for every screen: a `#141414` bar with a hairline bottom edge, a
 * 15px semibold title, an optional subtitle, and icon actions on the right.
 *
 * It owns the top safe-area inset and, in landscape, the side ones, so no
 * screen has to think about the notch or the gesture bar. Its icon buttons are
 * drawn at 36dp because that is what looks right next to a 15px title, and
 * given a hit area of 44dp because that is what a thumb needs.
 */
export function AppHeader({
  title,
  subtitle,
  subtitleContent,
  leading,
  onBack,
  backIcon = 'chevron-left',
  grabber = false,
  actions = [],
}: AppHeaderProps) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.bar,
        {
          paddingTop: insets.top + (grabber ? spacing.xs : spacing.sm),
          paddingLeft: layout.gutter + insets.left,
          paddingRight: layout.gutter + insets.right,
        },
      ]}
    >
      {grabber ? <View style={styles.grabber} /> : null}
      <View style={styles.row}>
        {onBack ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={backIcon === 'x' ? 'Close' : 'Back'}
            testID="header-back"
            onPress={onBack}
            style={({ pressed }) => [
              styles.iconButton,
              styles.backButton,
              pressed && styles.iconButtonPressed,
            ]}
            hitSlop={touchArea(ICON_BUTTON)}
          >
            <Feather name={backIcon} size={backIcon === 'x' ? 18 : 20} color={colors.textPrimary} />
          </Pressable>
        ) : null}
        {leading ? <View style={styles.leading}>{leading}</View> : null}
        <View style={styles.titles}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {subtitleContent ? (
            <View style={styles.subtitleRow}>{subtitleContent}</View>
          ) : subtitle ? (
            <Text style={styles.subtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        <View style={styles.actions}>
          {actions.map(action => (
            <Pressable
              key={action.label}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              testID={`header-action-${action.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
              onPress={action.onPress}
              style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
              hitSlop={touchArea(ICON_BUTTON)}
            >
              <Feather name={action.icon} size={18} color={colors.textSecondary} />
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    paddingBottom: spacing.sm,
    backgroundColor: colors.sidebar,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderHairline,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: layout.headerHeight,
  },
  grabber: {
    alignSelf: 'center',
    width: layout.grabberWidth,
    height: layout.grabberHeight,
    borderRadius: radii.pill,
    backgroundColor: colors.element,
    marginBottom: spacing.xs,
  },
  leading: {
    justifyContent: 'center',
  },
  titles: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  title: {
    color: colors.textPrimary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.title,
    fontWeight: '600',
  },
  subtitle: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.tiny,
  },
  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xxs,
  },
  iconButton: {
    width: ICON_BUTTON,
    height: ICON_BUTTON,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({ web: { cursor: 'pointer' as const }, default: {} }),
  },
  /** The chevron sits in the gutter, so the title keeps its 16dp margin. */
  backButton: {
    marginLeft: -spacing.sm,
  },
  iconButtonPressed: {
    backgroundColor: colors.elementHover,
  },
});
