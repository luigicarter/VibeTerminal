import Feather from '@expo/vector-icons/Feather';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TERMINAL_KEYS, controlCode } from '../api/keys';
import { colors, fontSizes, fonts, layout, radii, spacing, touchArea } from '../theme/tokens';

export type KeyBarProps = {
  /** Stable hooks for the capture script: `<testID>-esc`, `-ctrl`, `-input`… */
  testID?: string;
  /** Every key, every control code and the text field all come through here. */
  onKeys: (data: string) => void | Promise<void>;
  /** Put the caret back in the terminal itself — `/` does this. */
  onFocusTerminal?: () => void;
  /** `A-` and `A+`: step the embedded page's zoom. Hidden when not given. */
  onZoom?: (delta: number) => void;
  disabled?: boolean;
  /** Shown above the keys when the desktop will not take them. */
  disabledNote?: string | null;
};

type KeyButton = {
  id: string;
  label: string;
  data: string;
  wide?: boolean;
  /** Held down, this key repeats: the arrows, and nothing else. */
  repeat?: boolean;
};

/** A held arrow waits this long before it starts repeating. */
export const REPEAT_DELAY_MS = 350;

/** …and then sends one more every this often, until it is let go. */
export const REPEAT_INTERVAL_MS = 80;

/** One step of `A-` / `A+`; the page clamps the total to 0.6x…3x. */
const ZOOM_STEP = 0.2;

/** A key is drawn this big and, through `touchArea`, hit at 44dp. */
const KEY_WIDTH = 38;
const KEY_WIDE_WIDTH = 46;
const KEY_HEIGHT = 34;

/** The keys a phone keyboard does not have, in the order they are shown. */
const BUTTONS: KeyButton[] = [
  { id: 'tab', label: 'Tab', data: TERMINAL_KEYS.tab, wide: true },
  { id: 'up', label: '↑', data: TERMINAL_KEYS.up, repeat: true },
  { id: 'down', label: '↓', data: TERMINAL_KEYS.down, repeat: true },
  { id: 'left', label: '←', data: TERMINAL_KEYS.left, repeat: true },
  { id: 'right', label: '→', data: TERMINAL_KEYS.right, repeat: true },
  { id: 'enter', label: '⏎', data: TERMINAL_KEYS.enter, wide: true },
];

/** The control codes worth their own key: interrupt, end of file, clear. */
const CONTROL_KEYS: KeyButton[] = [
  { id: 'interrupt', label: '^C', data: TERMINAL_KEYS.interrupt },
  { id: 'eof', label: '^D', data: controlCode('d') || '' },
  { id: 'clear', label: '^L', data: controlCode('l') || '' },
];

/** A tap should feel like a key, so every one of them taps back. */
function tap(): void {
  if (Platform.OS === 'web') return;
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {
    /* a device without a taptic engine simply does not buzz */
  });
}

/**
 * The keys a phone keyboard lacks, docked under the live terminal.
 *
 * Ctrl is sticky: arm it, then type one letter in the text field and that
 * letter is sent as its control code instead of as text — `c`, `d` and `l`
 * are the ones that come up, and each also has a key of its own. The chevron
 * folds everything but the text field away when the terminal needs the room.
 */
export function KeyBar({
  testID = 'keybar',
  onKeys,
  onFocusTerminal,
  onZoom,
  disabled = false,
  disabledNote,
}: KeyBarProps) {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const send = useCallback(
    (data: string) => {
      if (disabled || !data) return;
      void onKeys(data);
    },
    [disabled, onKeys]
  );

  /** A key press: the buzz and the bytes, in that order. */
  const press = useCallback(
    (data: string) => {
      if (disabled) return;
      tap();
      send(data);
    },
    [disabled, send]
  );

  const pressCtrl = useCallback(() => {
    if (disabled) return;
    tap();
    setCtrlArmed(current => !current);
  }, [disabled]);

  const pressSlash = useCallback(() => {
    press(TERMINAL_KEYS.slash);
    onFocusTerminal?.();
  }, [onFocusTerminal, press]);

  /** The clipboard goes in as keys, exactly as if it had been typed. */
  const pressPaste = useCallback(async () => {
    if (disabled) return;
    tap();
    try {
      const clip = await Clipboard.getStringAsync();
      if (clip) send(clip);
    } catch {
      /* no clipboard permission, or nothing in it: silently do nothing */
    }
  }, [disabled, send]);

  // While Ctrl is armed the next letter typed is a control code, not text.
  const changeText = useCallback(
    (next: string) => {
      if (ctrlArmed && next.length > text.length) {
        const typed = next.slice(text.length).slice(-1);
        const code = controlCode(typed);
        setCtrlArmed(false);
        if (code) {
          setText('');
          send(code);
          return;
        }
      }
      setText(next);
    },
    [ctrlArmed, send, text]
  );

  const submit = useCallback(() => {
    const value = text;
    if (!value || disabled) return;
    setText('');
    // Raw keys, then Return — exactly what typing it at the desktop would do.
    send(`${value}${TERMINAL_KEYS.enter}`);
  }, [disabled, send, text]);

  const escKey = (
    <Key
      testID={`${testID}-esc`}
      label="Esc"
      wide
      prominent
      disabled={disabled}
      onPress={() => press(TERMINAL_KEYS.escape)}
    />
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
      testID={collapsed ? `${testID}-collapsed` : testID}
    >
      {disabled && disabledNote ? (
        <Text style={styles.note} testID={`${testID}-note`}>
          {disabledNote}
        </Text>
      ) : null}
      {collapsed ? null : (
        <View style={styles.keys}>
          {escKey}
          {BUTTONS.map(button => (
            <Key
              key={button.id}
              testID={`${testID}-${button.id}`}
              label={button.label}
              wide={button.wide}
              disabled={disabled}
              repeat={button.repeat}
              onPress={() => press(button.data)}
            />
          ))}
          <Key
            testID={ctrlArmed ? `${testID}-ctrl-armed` : `${testID}-ctrl`}
            label="Ctrl"
            wide
            armed={ctrlArmed}
            disabled={disabled}
            onPress={pressCtrl}
          />
          {CONTROL_KEYS.map(button => (
            <Key
              key={button.id}
              testID={`${testID}-${button.id}`}
              label={button.label}
              disabled={disabled}
              onPress={() => press(button.data)}
            />
          ))}
          <Key testID={`${testID}-slash`} label="/" disabled={disabled} onPress={pressSlash} />
          <Key
            testID={`${testID}-paste`}
            label="Paste"
            wide
            disabled={disabled}
            onPress={() => void pressPaste()}
          />
          {onZoom ? (
            <>
              {/* Zoom is the page's, not the desktop's: it works read-only too. */}
              <Key
                testID={`${testID}-zoom-out`}
                label="A−"
                onPress={() => {
                  tap();
                  onZoom(-ZOOM_STEP);
                }}
              />
              <Key
                testID={`${testID}-zoom-in`}
                label="A+"
                onPress={() => {
                  tap();
                  onZoom(ZOOM_STEP);
                }}
              />
            </>
          ) : null}
        </View>
      )}
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={collapsed ? 'Show the keys' : 'Hide the keys'}
          accessibilityState={{ expanded: !collapsed }}
          testID={`${testID}-collapse`}
          onPress={() => {
            tap();
            setCollapsed(current => !current);
          }}
          style={({ pressed }) => [styles.chevron, pressed && styles.buttonPressed]}
          hitSlop={touchArea(28, 40)}
        >
          <Feather
            name={collapsed ? 'chevron-up' : 'chevron-down'}
            size={16}
            color={colors.textSecondary}
          />
        </Pressable>
        {collapsed ? escKey : null}
        <TextInput
          testID={`${testID}-input`}
          style={[styles.input, disabled && styles.inputDisabled]}
          value={text}
          onChangeText={changeText}
          onSubmitEditing={submit}
          placeholder={ctrlArmed ? 'Ctrl + a letter — c, d, l…' : 'Type into the terminal'}
          placeholderTextColor={ctrlArmed ? colors.needsYou : colors.textMuted}
          editable={!disabled}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          blurOnSubmit={false}
          returnKeyType="send"
          selectionColor={colors.waiting}
          accessibilityLabel="Type into the terminal"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send to the terminal"
          testID={`${testID}-send`}
          disabled={disabled || text.length === 0}
          onPress={() => {
            tap();
            submit();
          }}
          hitSlop={touchArea(40)}
          style={({ pressed }) => [
            styles.button,
            (disabled || text.length === 0) && styles.buttonDisabled,
            pressed && !disabled && styles.buttonPressed,
          ]}
        >
          <Feather
            name="corner-down-left"
            size={16}
            color={disabled || text.length === 0 ? colors.textMuted : colors.textPrimary}
          />
        </Pressable>
      </View>
    </View>
  );
}

function Key({
  testID,
  label,
  onPress,
  disabled,
  armed,
  wide,
  prominent,
  repeat,
}: {
  testID: string;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  armed?: boolean;
  wide?: boolean;
  /** Esc: the one key that has to be found without looking. */
  prominent?: boolean;
  /** Held down, fire again after `REPEAT_DELAY_MS`, then every interval. */
  repeat?: boolean;
}) {
  const delayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pressRef = useRef(onPress);
  pressRef.current = onPress;

  const stopRepeat = useCallback(() => {
    if (delayRef.current) clearTimeout(delayRef.current);
    if (intervalRef.current) clearInterval(intervalRef.current);
    delayRef.current = null;
    intervalRef.current = null;
  }, []);

  // A finger lifted off-screen still has to stop the repeat.
  useEffect(() => stopRepeat, [stopRepeat]);

  const startRepeat = useCallback(() => {
    if (!repeat || disabled) return;
    stopRepeat();
    delayRef.current = setTimeout(() => {
      intervalRef.current = setInterval(() => pressRef.current(), REPEAT_INTERVAL_MS);
    }, REPEAT_DELAY_MS);
  }, [disabled, repeat, stopRepeat]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected: armed }}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      onPressIn={startRepeat}
      onPressOut={stopRepeat}
      // Drawn key-sized; hit at thumb size.
      hitSlop={touchArea(wide ? KEY_WIDE_WIDTH : KEY_WIDTH, KEY_HEIGHT)}
      style={({ pressed }) => [
        styles.key,
        wide && styles.keyWide,
        prominent && styles.keyProminent,
        armed && styles.keyArmed,
        disabled && styles.keyDisabled,
        pressed && !disabled && !armed && styles.keyPressed,
      ]}
    >
      <Text
        style={[
          styles.keyLabel,
          prominent && styles.keyLabelProminent,
          armed && styles.keyLabelArmed,
          disabled && styles.keyLabelDisabled,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderHairline,
    backgroundColor: colors.sidebar,
    paddingTop: spacing.xs,
    gap: spacing.xs,
  },
  keys: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  key: {
    minWidth: KEY_WIDTH,
    height: KEY_HEIGHT,
    paddingHorizontal: spacing.xs,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.element,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHairline,
    ...Platform.select({ web: { cursor: 'pointer' as const }, default: {} }),
  },
  keyWide: {
    minWidth: KEY_WIDE_WIDTH,
  },
  keyProminent: {
    backgroundColor: colors.elementHover,
    borderColor: colors.borderStrong,
    borderWidth: 1,
  },
  keyArmed: {
    backgroundColor: colors.needsYouDim,
    borderColor: colors.needsYou,
  },
  keyPressed: {
    backgroundColor: colors.elementHover,
  },
  keyDisabled: {
    backgroundColor: colors.surface,
    opacity: 0.5,
  },
  keyLabel: {
    color: colors.textPrimary,
    fontFamily: fonts.mono,
    fontSize: fontSizes.small,
  },
  keyLabelProminent: {
    fontWeight: '700',
  },
  keyLabelArmed: {
    color: colors.needsYou,
    fontWeight: '700',
  },
  keyLabelDisabled: {
    color: colors.textMuted,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  input: {
    flex: 1,
    height: 40,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHairline,
    borderRadius: radii.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 0,
    color: colors.textPrimary,
    fontFamily: fonts.mono,
    fontSize: fontSizes.small,
    ...Platform.select({ web: { outlineStyle: 'none' as any }, default: {} }),
  },
  inputDisabled: {
    opacity: 0.5,
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
  chevron: {
    width: 28,
    height: 40,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({ web: { cursor: 'pointer' as const }, default: {} }),
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
    fontSize: fontSizes.tiny,
    textAlign: 'center',
    paddingBottom: spacing.xxs,
  },
});
