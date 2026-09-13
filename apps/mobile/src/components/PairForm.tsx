import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  describeError,
  formatCode,
  hello,
  isBridgeError,
  normalizeCode,
  normalizeHost,
  normalizePort,
} from '../api/client';
import { DEFAULT_PORT } from '../api/types';
import type { Connection, Pairing } from '../api/types';
import { colors, fontSizes, fonts, radii, spacing } from '../theme/tokens';

export type PairFormProps = {
  initial?: Pairing | null;
  submitLabel?: string;
  onPaired: (pairing: Pairing) => void | Promise<void>;
  onCancel?: () => void;
};

function pairErrorMessage(error: unknown, connection: Connection): string {
  if (isBridgeError(error)) {
    if (error.kind === 'auth') return 'That code did not match';
    if (error.kind === 'network' || error.kind === 'timeout') {
      return `Could not reach ${connection.host}:${connection.port}. Same Wi-Fi? Is phone access on?`;
    }
  }
  return describeError(error, connection);
}

/** The pairing fields, used by the Pair screen and again inside Settings. */
export function PairForm({ initial, submitLabel = 'Connect', onPaired, onCancel }: PairFormProps) {
  const [address, setAddress] = useState(initial?.host ?? '');
  const [port, setPort] = useState(String(initial?.port ?? DEFAULT_PORT));
  const [code, setCode] = useState(initial ? formatCode(initial.code) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connection = useMemo<Connection>(
    () => ({
      host: normalizeHost(address),
      port: normalizePort(port),
      code: normalizeCode(code),
    }),
    [address, port, code]
  );

  const canSubmit = connection.host.length > 0 && connection.port > 0 && connection.code.length > 0 && !busy;

  const connect = useCallback(async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const response = await hello(connection);
      if (response.app !== 'lina-terminal') {
        setError('That address answered, but it is not a Lina Terminal desktop.');
        return;
      }
      await onPaired({
        host: connection.host,
        port: connection.port,
        code: connection.code,
        desktopHost: response.host || connection.host,
        desktopId: '',
        version: response.version || '',
        pairedAt: Date.now(),
        readOnly: response.readOnly === true,
      });
    } catch (caught) {
      setError(pairErrorMessage(caught, connection));
    } finally {
      setBusy(false);
    }
  }, [canSubmit, connection, onPaired]);

  return (
    <View style={styles.form}>
      <Field label="Address" hint="e.g. 192.168.1.20">
        <TextInput
          testID="pair-address"
          style={styles.input}
          value={address}
          onChangeText={setAddress}
          placeholder="192.168.1.20"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          inputMode="url"
          accessibilityLabel="Address"
        />
      </Field>
      <Field label="Port">
        <TextInput
          testID="pair-port"
          style={styles.input}
          value={port}
          onChangeText={value => setPort(value.replace(/[^0-9]/g, ''))}
          placeholder={String(DEFAULT_PORT)}
          placeholderTextColor={colors.textMuted}
          keyboardType="number-pad"
          inputMode="numeric"
          maxLength={5}
          accessibilityLabel="Port"
        />
      </Field>
      <Field label="Pairing code">
        <TextInput
          testID="pair-code"
          style={[styles.input, styles.codeInput]}
          value={code}
          onChangeText={value => setCode(formatCode(value))}
          placeholder="XXXX-XXXX-XXXX-XXXX"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={19}
          accessibilityLabel="Pairing code"
        />
      </Field>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.buttons}>
        {onCancel ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            testID="pair-cancel"
            onPress={onCancel}
            style={({ pressed }) => [styles.button, styles.secondary, pressed && styles.buttonPressed]}
          >
            <Text style={styles.secondaryText}>Cancel</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={submitLabel}
          testID="pair-submit"
          disabled={!canSubmit}
          onPress={() => void connect()}
          style={({ pressed }) => [
            styles.button,
            styles.primary,
            !canSubmit && styles.buttonDisabled,
            pressed && canSubmit && styles.buttonPressed,
          ]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.app} />
          ) : (
            <Text style={styles.primaryText}>{submitLabel}</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>{label}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: spacing.md,
  },
  field: {
    gap: spacing.xxs,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.xs,
  },
  label: {
    color: colors.textSecondary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.tiny,
    fontWeight: '600',
  },
  hint: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.micro,
  },
  input: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHairline,
    borderRadius: radii.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs + 2,
    color: colors.textPrimary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.base,
    ...Platform.select({ web: { outlineStyle: 'none' as any }, default: {} }),
  },
  codeInput: {
    fontFamily: fonts.mono,
    letterSpacing: 1,
  },
  error: {
    color: colors.failed,
    fontFamily: fonts.ui,
    fontSize: fontSizes.small,
  },
  buttons: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  button: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    minHeight: 40,
    ...Platform.select({ web: { cursor: 'pointer' as const }, default: {} }),
  },
  primary: {
    backgroundColor: colors.accent,
  },
  primaryText: {
    color: colors.app,
    fontFamily: fonts.ui,
    fontSize: fontSizes.base,
    fontWeight: '700',
  },
  secondary: {
    backgroundColor: colors.element,
  },
  secondaryText: {
    color: colors.textPrimary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.base,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  buttonPressed: {
    opacity: 0.85,
  },
});
