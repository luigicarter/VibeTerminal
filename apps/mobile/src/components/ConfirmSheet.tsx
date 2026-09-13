import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fontSizes, fonts, layout, radii, spacing } from '../theme/tokens';
import { Sheet } from './Sheet';

export type ConfirmSheetProps = {
  visible: boolean;
  /** The question, as a question. */
  title: string;
  /** One line saying what actually happens. Never two. */
  message: string;
  /** The verb, not "OK": "Forget", "Find another". */
  confirmLabel: string;
  /** Draws the action in the failure colour. */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testID?: string;
};

/**
 * The app's one confirmation. Every irreversible action asks the same way — a
 * question, one line of consequence, Cancel and the verb — so nothing in this
 * app ever raises a bare platform alert, whose wording, order and button
 * placement belong to Android rather than to Lina.
 */
export function ConfirmSheet({
  visible,
  title,
  message,
  confirmLabel,
  destructive = true,
  onConfirm,
  onCancel,
  testID = 'confirm-sheet',
}: ConfirmSheetProps) {
  return (
    <Sheet visible={visible} onClose={onCancel} testID={testID}>
      <View style={styles.body}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.message}>{message}</Text>
        <View style={styles.buttons}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            testID={`${testID}-cancel`}
            onPress={onCancel}
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
          >
            <Text style={styles.buttonText}>Cancel</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={confirmLabel}
            testID={`${testID}-confirm`}
            onPress={onConfirm}
            style={({ pressed }) => [
              styles.button,
              destructive && styles.destructive,
              pressed && styles.buttonPressed,
            ]}
          >
            <Text style={[styles.buttonText, destructive && styles.destructiveText]}>
              {confirmLabel}
            </Text>
          </Pressable>
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: {
    paddingHorizontal: layout.gutter,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
    gap: spacing.xs,
  },
  title: {
    color: colors.textPrimary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.title,
    fontWeight: '600',
  },
  message: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.small,
    lineHeight: 18,
  },
  buttons: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingTop: spacing.sm,
  },
  button: {
    flex: 1,
    minHeight: layout.minTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: colors.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHairline,
    ...Platform.select({ web: { cursor: 'pointer' as const }, default: {} }),
  },
  destructive: {
    borderColor: colors.failed,
  },
  buttonPressed: {
    backgroundColor: colors.surface,
  },
  buttonText: {
    color: colors.textPrimary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.base,
    fontWeight: '600',
  },
  destructiveText: {
    color: colors.failed,
  },
});
