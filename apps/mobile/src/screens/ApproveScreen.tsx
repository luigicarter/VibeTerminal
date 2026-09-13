import * as Device from 'expo-device';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { describeError, isBridgeError, normalizeCode, pollPairing, requestPairing } from '../api/client';
import { AppHeader } from '../components/AppHeader';
import { BrandChip } from '../components/BrandChip';
import { Ring } from '../components/Dots';
import { Screen } from '../components/Layout';
import type { RootScreenProps } from '../navigation/types';
import { useBridge } from '../state/bridge';
import { describeThisDevice } from '../state/discovery';
import { colors, fontSizes, fonts, layout, radii, spacing } from '../theme/tokens';

type Phase = 'asking' | 'waiting' | 'denied' | 'expired' | 'error';

/** Nothing is typed here: the person presses Allow on the desktop instead. */
export function ApproveScreen({ navigation, route }: RootScreenProps<'Approve'>) {
  const { host, port, desktopId, desktopHost, version, readOnly } = route.params;
  const { pair } = useBridge();
  const [phase, setPhase] = useState<Phase>('asking');
  const [message, setMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  /** Held so Cancel and hardware back can end the long poll, not just leave it. */
  const pollRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    pollRef.current = controller;
    const endpoint = { host, port };
    let cancelled = false;

    const run = async () => {
      setPhase('asking');
      setMessage(null);
      try {
        const device = describeThisDevice(Device.deviceName, Device.modelName);
        const request = await requestPairing(endpoint, device, controller.signal);
        if (cancelled) return;
        setPhase('waiting');

        // Each poll parks on the desktop until somebody answers the prompt.
        for (;;) {
          const answer = await pollPairing(endpoint, request.requestId, {
            wait: 20000,
            signal: controller.signal,
          });
          if (cancelled) return;
          if (answer.status === 'approved') {
            if (!answer.code) {
              setPhase('error');
              setMessage('The desktop approved this phone but sent no code.');
              return;
            }
            // Storing the pairing swaps the whole stack for the project group,
            // so Projects is the root and this screen is gone, not buried.
            await pair({
              host,
              port,
              code: normalizeCode(answer.code),
              desktopHost,
              desktopId,
              version,
              readOnly,
              pairedAt: Date.now(),
            });
            return;
          }
          if (answer.status === 'denied') {
            setPhase('denied');
            return;
          }
          if (answer.status === 'expired') {
            setPhase('expired');
            return;
          }
        }
      } catch (caught) {
        if (cancelled || (isBridgeError(caught) && caught.kind === 'aborted')) return;
        setPhase('error');
        setMessage(
          isBridgeError(caught) && caught.status === 429
            ? 'That desktop already has three pairing requests waiting. Answer one of them, then try again.'
            : describeError(caught, endpoint)
        );
      }
    };

    void run();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [attempt, desktopHost, desktopId, host, pair, port, readOnly, version]);

  /**
   * Leaving this screen abandons the request, and there are three ways to leave
   * it — Cancel, the header chevron and hardware back. `beforeRemove` is the one
   * place all three arrive, so the long poll is ended once, wherever the press
   * came from, rather than left parked on the desktop for twenty seconds.
   */
  useEffect(
    () => navigation.addListener('beforeRemove', () => pollRef.current?.abort()),
    [navigation]
  );

  const cancel = useCallback(() => navigation.goBack(), [navigation]);

  const waiting = phase === 'asking' || phase === 'waiting';

  return (
    <Screen>
      <AppHeader title={`Approve on ${desktopHost}`} subtitle={`${host}:${port}`} onBack={cancel} />
      <View style={styles.body}>
        <BrandChip size={44} />
        {waiting ? (
          <>
            <Ring
              size={32}
              thickness={3}
              color={colors.textSecondary}
              track={colors.element}
              label="Waiting for approval"
            />
            <Text style={styles.headline}>Waiting for you to press Allow on the desktop…</Text>
            <Text style={styles.detail}>
              A prompt naming this phone is showing on {desktopHost}. Approve it there and this screen moves on
              by itself.
            </Text>
          </>
        ) : null}

        {phase === 'denied' ? <Text style={styles.headline}>The desktop said no.</Text> : null}
        {phase === 'expired' ? (
          <Text style={styles.headline}>Nobody answered on the desktop in time.</Text>
        ) : null}
        {phase === 'error' ? <Text style={[styles.headline, styles.error]}>{message}</Text> : null}

        <View style={styles.buttons}>
          {waiting ? (
            <Button label="Cancel" testID="approve-cancel" onPress={cancel} />
          ) : (
            <>
              <Button label="Back" testID="approve-back" onPress={cancel} />
              {phase === 'denied' ? null : (
                <Button
                  label="Try again"
                  primary
                  testID="approve-retry"
                  onPress={() => setAttempt(value => value + 1)}
                />
              )}
            </>
          )}
        </View>
      </View>
    </Screen>
  );
}

function Button({
  label,
  onPress,
  primary = false,
  testID,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [styles.button, primary && styles.primary, pressed && styles.pressed]}
    >
      <Text style={[styles.buttonText, primary && styles.primaryText]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    padding: spacing.xl,
    maxWidth: 520,
    width: '100%',
    alignSelf: 'center',
  },
  headline: {
    color: colors.textPrimary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.title,
    fontWeight: '600',
    textAlign: 'center',
  },
  detail: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.small,
    lineHeight: 18,
    textAlign: 'center',
  },
  error: {
    color: colors.failed,
    fontSize: fontSizes.base,
    fontWeight: '400',
  },
  buttons: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignSelf: 'stretch',
  },
  button: {
    flex: 1,
    minHeight: layout.minTarget,
    justifyContent: 'center',
    backgroundColor: colors.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHairline,
    borderRadius: radii.md,
    alignItems: 'center',
    ...Platform.select({ web: { cursor: 'pointer' as const }, default: {} }),
  },
  primary: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  pressed: {
    opacity: 0.85,
  },
  buttonText: {
    color: colors.textPrimary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.base,
    fontWeight: '600',
  },
  primaryText: {
    color: colors.app,
    fontWeight: '700',
  },
});
