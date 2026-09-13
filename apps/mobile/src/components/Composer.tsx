import Feather from '@expo/vector-icons/Feather';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TextInputKeyPressEventData,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fontSizes, fonts, layout, radii, spacing, touchArea } from '../theme/tokens';

export type ComposerProps = {
  /** Stable hooks for the capture script: `<testID>-input`, `-send`, `-stop`, `-note`. */
  testID?: string;
  placeholder?: string;
  onSend: (text: string) => void | Promise<void>;
  onStop?: () => void | Promise<void>;
  /** Replaces the send button with a stop button while the agent is working. */
  showStop?: boolean;
  disabled?: boolean;
  /** Shown instead of the input when the terminal cannot take text. */
  disabledNote?: string | null;
};

/** The message box: multiline input plus a send (or stop) button. */
export function Composer({
  testID = 'composer',
  placeholder = 'Message…',
  onSend,
  onStop,
  showStop = false,
  disabled = false,
  disabledNote,
}: ComposerProps) {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    const value = text.trim();
    if (!value || busy || disabled) return;
    setBusy(true);
    try {
      await onSend(value);
      setText('');
    } finally {
      setBusy(false);
    }
  }, [busy, disabled, onSend, text]);

  const handleKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (Platform.OS !== 'web') return;
      const native = event.nativeEvent as TextInputKeyPressEventData & { shiftKey?: boolean };
      if (native.key !== 'Enter' || native.shiftKey) return;
      event.preventDefault?.();
      void submit();
    },
    [submit]
  );

  return (
    <View
      style={[
        styles.wrap,
        {
          paddingBottom: insets.bottom + spacing.xs,
          paddingLeft: layout.gutter + insets.left,
          paddingRight: layout.gutter + insets.right,
        },
      ]}
      testID={testID}
    >
      {disabled && disabledNote ? (
        <Text style={styles.note} testID={`${testID}-note`}>
          {disabledNote}
        </Text>
      ) : (
        <View style={styles.row}>
          <TextInput
            testID={`${testID}-input`}
            style={styles.input}
            value={text}
            onChangeText={setText}
            onKeyPress={handleKeyPress}
            placeholder={placeholder}
            placeholderTextColor={colors.textMuted}
            multiline
            editable={!disabled}
            selectionColor={colors.waiting}
            accessibilityLabel="Message"
          />
          {showStop && onStop ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Stop"
              testID={`${testID}-stop`}
              onPress={() => void onStop()}
              hitSlop={touchArea(40)}
              style={({ pressed }) => [styles.button, styles.stopButton, pressed && styles.buttonPressed]}
            >
              <Feather name="square" size={16} color={colors.working} />
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send"
            testID={`${testID}-send`}
            disabled={disabled || busy || text.trim().length === 0}
            onPress={() => void submit()}
            hitSlop={touchArea(40)}
            style={({ pressed }) => [
              styles.button,
              (disabled || text.trim().length === 0) && styles.buttonDisabled,
              pressed && styles.buttonPressed,
            ]}
          >
            {busy ? (
              <ActivityIndicator size="small" color={colors.textSecondary} />
            ) : (
              <Feather
                name="send"
                size={16}
                color={text.trim().length === 0 ? colors.textMuted : colors.textPrimary}
              />
            )}
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderHairline,
    backgroundColor: colors.sidebar,
    paddingTop: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
  input: {
    flex: 1,
    minHeight: 38,
    maxHeight: 140,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHairline,
    borderRadius: radii.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    color: colors.textPrimary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.base,
    ...Platform.select({ web: { outlineStyle: 'none' as any }, default: {} }),
  },
  button: {
    width: 40,
    height: 40,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.element,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHairline,
    ...Platform.select({ web: { cursor: 'pointer' as const }, default: {} }),
  },
  stopButton: {
    backgroundColor: colors.surface,
    borderColor: colors.workingDim,
  },
  buttonDisabled: {
    backgroundColor: colors.surface,
  },
  buttonPressed: {
    backgroundColor: colors.elementHover,
  },
  note: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.small,
    textAlign: 'center',
    paddingVertical: spacing.sm,
  },
});
