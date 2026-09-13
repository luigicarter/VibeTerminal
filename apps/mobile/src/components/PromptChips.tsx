import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import type { NeedsInput } from '../api/types';
import { colors, fontSizes, fonts, layout, radii, spacing, touchArea } from '../theme/tokens';

export type PromptChipsProps = {
  needsInput: NeedsInput;
  /** Read-only desktops show the prompt but cannot answer it. */
  disabled?: boolean;
  /** Called with the key the terminal is waiting for — "1", "y", "n". */
  onChoose: (key: string) => void | Promise<void>;
  testID?: string;
};

/**
 * The prompt a terminal is parked on, with one chip per answer. Tapping a chip
 * sends that key and a Return, which is exactly what a person at the desktop
 * would have typed.
 */
/** A chip is drawn this tall and, through `touchArea`, hit at 44dp. */
const CHIP_HEIGHT = 36;

export function PromptChips({
  needsInput,
  disabled = false,
  onChoose,
  testID = 'prompt-chips',
}: PromptChipsProps) {
  const [busy, setBusy] = useState<string | null>(null);

  const choose = async (key: string) => {
    if (disabled || busy) return;
    setBusy(key);
    try {
      await onChoose(key);
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.card} testID={testID}>
      <Text style={styles.label}>Waiting for you</Text>
      {needsInput.prompt ? (
        <Text style={styles.prompt} numberOfLines={2}>
          {needsInput.prompt}
        </Text>
      ) : null}
      <View style={styles.chips}>
        {needsInput.options.map(option => (
          <Pressable
            key={option.key}
            accessibilityRole="button"
            accessibilityLabel={`${option.key}, ${option.label}`}
            testID={`${testID}-${option.key}`}
            disabled={disabled || busy !== null}
            onPress={() => void choose(option.key)}
            hitSlop={touchArea(88, CHIP_HEIGHT)}
            style={({ pressed }) => [
              styles.chip,
              disabled && styles.chipDisabled,
              pressed && !disabled && styles.chipPressed,
            ]}
          >
            <Text style={styles.chipKey}>{option.key}</Text>
            <Text style={styles.chipDot}>·</Text>
            <Text style={[styles.chipLabel, disabled && styles.chipLabelDisabled]} numberOfLines={1}>
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: layout.gutter,
    marginBottom: spacing.xs,
    padding: spacing.sm,
    gap: spacing.xs,
    backgroundColor: colors.panel,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.needsYou,
  },
  label: {
    color: colors.needsYou,
    fontFamily: fonts.ui,
    fontSize: fontSizes.micro,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  prompt: {
    color: colors.textPrimary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.small,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    maxWidth: '100%',
    minHeight: CHIP_HEIGHT,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    backgroundColor: colors.element,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHairline,
    ...Platform.select({ web: { cursor: 'pointer' as const }, default: {} }),
  },
  chipPressed: {
    backgroundColor: colors.elementHover,
  },
  chipDisabled: {
    backgroundColor: colors.surface,
    opacity: 0.55,
  },
  chipKey: {
    color: colors.needsYou,
    fontFamily: fonts.mono,
    fontSize: fontSizes.small,
    fontWeight: '700',
  },
  chipDot: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.small,
  },
  chipLabel: {
    flexShrink: 1,
    color: colors.textPrimary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.small,
  },
  chipLabelDisabled: {
    color: colors.textMuted,
  },
});
