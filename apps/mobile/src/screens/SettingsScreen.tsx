import React, { useCallback, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import appConfig from '../../app.json';
import { formatBytes, getDataUsage, subscribeDataUsage } from '../api/client';
import { AppHeader } from '../components/AppHeader';
import { ConfirmSheet } from '../components/ConfirmSheet';
import { ConnectionDot, connectionToneLabel, useConnectionTone } from '../components/ConnectionDot';
import { Card, SectionTitle, useSideInsets } from '../components/Layout';
import { ModalScreen } from '../components/ModalScreen';
import { PairForm } from '../components/PairForm';
import type { RootScreenProps } from '../navigation/types';
import { useBridge } from '../state/bridge';
import { colors, fontSizes, fonts, layout, radii, spacing } from '../theme/tokens';
import { clockTime, relativeTime } from '../util/time';

const APP_VERSION: string = appConfig?.expo?.version ?? '0.0.0';

/** Which irreversible thing is being asked about; null when nothing is. */
type Asking = null | 'forget' | 'another';

/**
 * Pairing details, re-pairing, and what this build is — presented as a modal.
 *
 * It is reachable from every screen, and closing it must put the person back on
 * the screen they opened it from, so it is pushed rather than switched to: the
 * X, a downward swipe on its header and hardware back all pop this one screen.
 */
export function SettingsScreen({ navigation }: RootScreenProps<'Settings'>) {
  const {
    pairing,
    pair,
    unpair,
    lastSuccessAt,
    error,
    notifyEnabled,
    notifyPermission,
    notifySupported,
    setNotifyEnabled,
  } = useBridge();
  const tone = useConnectionTone();
  const sides = useSideInsets();
  const [changing, setChanging] = useState(false);
  const [asking, setAsking] = useState<Asking>(null);
  const usage = useSyncExternalStore(subscribeDataUsage, getDataUsage, getDataUsage);

  // The X, the swipe and hardware back all close this one screen. A question
  // that is open answers first: the sheet is a `Modal`, so Android gives the
  // press to it and it cancels, leaving Settings where it was.
  const close = useCallback(() => navigation.goBack(), [navigation]);

  return (
    <ModalScreen
      onDismiss={close}
      testID="settings-modal"
      header={<AppHeader title="Settings" onBack={close} backIcon="x" grabber />}
    >
      <ScrollView contentContainerStyle={[styles.content, sides]}>
        <SectionTitle>Connection</SectionTitle>
        <Card>
          <View style={styles.statusRow}>
            <ConnectionDot tone={tone} />
            <Text style={styles.statusText}>{connectionToneLabel(tone)}</Text>
          </View>
          <Detail label="Desktop" value={pairing?.desktopHost || '—'} />
          <Detail label="Desktop id" value={pairing?.desktopId || 'paired by address'} />
          <Detail label="Address" value={pairing ? `${pairing.host}:${pairing.port}` : '—'} />
          <Detail label="Desktop version" value={pairing?.version || 'unknown'} />
          <Detail
            label="Last update"
            value={
              lastSuccessAt
                ? `${clockTime(lastSuccessAt)} (${relativeTime(lastSuccessAt)})`
                : 'no successful poll yet'
            }
          />
          <Detail
            label="Data"
            value={`${formatBytes(usage.state)} state · ${formatBytes(usage.stream)} terminals · ${formatBytes(
              usage.other
            )} other`}
            lines={2}
          />
          {error && tone !== 'connected' ? <Text style={styles.error}>{error}</Text> : null}
        </Card>
        <Text style={styles.hint} testID="settings-data-note">
          Read back since the app started, after decompression. The desktop gzips what it sends, so
          less than this crossed the network.
        </Text>

        <SectionTitle>Notifications</SectionTitle>
        <Card>
          <Toggle
            label="Notify me when a terminal needs me or finishes"
            testID="settings-notify-toggle"
            value={notifyEnabled}
            disabled={!notifySupported}
            onChange={setNotifyEnabled}
          />
        </Card>
        <Text style={styles.hint} testID="settings-notify-note">
          {notifyNote(notifySupported, notifyPermission, notifyEnabled)}
        </Text>

        {/* Both of these throw the pairing away, so both ask the same way. */}
        <Button
          label="Find another desktop"
          testID="settings-find-another"
          onPress={() => setAsking('another')}
        />
        <Button
          label="Forget this desktop"
          tone="danger"
          testID="settings-forget"
          onPress={() => setAsking('forget')}
        />

        <SectionTitle>Advanced</SectionTitle>
        {changing ? (
          <Card>
            <Text style={styles.cardTitle}>Change pairing</Text>
            <PairForm
              initial={pairing}
              submitLabel="Save"
              onCancel={() => setChanging(false)}
              onPaired={async next => {
                await pair(next);
                setChanging(false);
              }}
            />
          </Card>
        ) : (
          <Button label="Change pairing" testID="settings-change-pairing" onPress={() => setChanging(true)} />
        )}
        <Text style={styles.hint}>
          Pairing by typed address is the fallback for a desktop this phone cannot discover.
        </Text>

        <SectionTitle>About</SectionTitle>
        <Card>
          <Detail label="App" value={appConfig?.expo?.name ?? 'Lina Terminal'} />
          <Detail label="Version" value={APP_VERSION} />
          <Detail label="Platform" value={Platform.OS} />
          <Text style={styles.cardBody}>
            A companion remote for the Lina Terminal desktop app. It talks to the desktop over your local
            network; nothing is sent anywhere else.
          </Text>
        </Card>
      </ScrollView>

      <ConfirmSheet
        visible={asking === 'forget'}
        testID="settings-forget-sheet"
        title="Forget this desktop?"
        message="The address and pairing code are deleted from this phone. You can pair again at any time."
        confirmLabel="Forget"
        onCancel={() => setAsking(null)}
        onConfirm={async () => {
          setAsking(null);
          // Dropping the pairing swaps the stack for the discovery group, so
          // Find becomes the root; nothing of this session stays behind it.
          await unpair();
        }}
      />
      <ConfirmSheet
        visible={asking === 'another'}
        testID="settings-another-sheet"
        title="Find another desktop?"
        message="This phone pairs with one desktop at a time, so this pairing is dropped and the search starts again."
        confirmLabel="Find another"
        onCancel={() => setAsking(null)}
        onConfirm={async () => {
          setAsking(null);
          await unpair();
        }}
      />
    </ModalScreen>
  );
}

/** What the line under the toggle can honestly say about this phone. */
function notifyNote(supported: boolean, permission: string, enabled: boolean): string {
  if (!supported) {
    return 'Notifications belong to the installed app; a browser has neither an Android channel nor a background wake.';
  }
  if (permission === 'denied') {
    return 'Android is refusing notifications for this app. Turn them on in Android Settings → Apps → Lina Terminal → Notifications, then switch this back on.';
  }
  if (!enabled) {
    return 'Nothing is posted while this is off. The app still keeps track of what has changed, so turning it back on does not bring a backlog with it.';
  }
  return 'A terminal that starts asking you something, a terminal that finishes or fails, and the Orchestrator answering. Nothing is posted while you are looking at the app. In the background the phone is told at once for the first minute, then roughly every 15 minutes — the shortest interval Android will schedule.';
}

/**
 * A two-state switch in the app's own palette rather than the platform's, for
 * the same reason nothing here raises a platform alert.
 */
function Toggle({
  label,
  value,
  onChange,
  disabled,
  testID,
}: {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
      accessibilityLabel={label}
      testID={testID}
      disabled={disabled}
      onPress={() => onChange(!value)}
      style={({ pressed }) => [styles.toggleRow, pressed && !disabled && styles.togglePressed]}
    >
      <Text style={[styles.toggleLabel, disabled && styles.toggleLabelDisabled]} numberOfLines={2}>
        {label}
      </Text>
      <View style={[styles.track, value && !disabled && styles.trackOn, disabled && styles.trackOff]}>
        <View style={[styles.knob, value && !disabled && styles.knobOn]} />
      </View>
    </Pressable>
  );
}

function Detail({ label, value, lines = 1 }: { label: string; value: string; lines?: number }) {
  return (
    <View style={styles.detail}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue} numberOfLines={lines} selectable>
        {value}
      </Text>
    </View>
  );
}

function Button({
  label,
  onPress,
  tone = 'normal',
  testID,
}: {
  label: string;
  onPress: () => void;
  tone?: 'normal' | 'danger';
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
    >
      <Text style={[styles.buttonText, tone === 'danger' && styles.buttonTextDanger]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: layout.gutter,
    paddingBottom: spacing.xl,
    gap: spacing.xs,
    maxWidth: 520,
    width: '100%',
    alignSelf: 'center',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingBottom: spacing.xxs,
  },
  statusText: {
    color: colors.textSecondary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.small,
  },
  detail: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.xs,
  },
  detailLabel: {
    width: 120,
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.tiny,
  },
  detailValue: {
    flex: 1,
    color: colors.textPrimary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.small,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: layout.minTarget,
    borderRadius: radii.sm,
    ...Platform.select({ web: { cursor: 'pointer' as const }, default: {} }),
  },
  togglePressed: {
    backgroundColor: colors.surface,
  },
  toggleLabel: {
    flex: 1,
    color: colors.textPrimary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.small,
  },
  toggleLabelDisabled: {
    color: colors.textMuted,
  },
  track: {
    width: 42,
    height: 24,
    borderRadius: radii.pill,
    backgroundColor: colors.element,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHairline,
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  trackOn: {
    backgroundColor: colors.needsYou,
    borderColor: colors.needsYou,
  },
  trackOff: {
    opacity: 0.4,
  },
  knob: {
    width: 18,
    height: 18,
    borderRadius: radii.pill,
    backgroundColor: colors.textSecondary,
  },
  knobOn: {
    backgroundColor: '#181818',
    alignSelf: 'flex-end',
  },
  cardTitle: {
    color: colors.textPrimary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.base,
    fontWeight: '600',
    paddingBottom: spacing.xxs,
  },
  cardBody: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.tiny,
    lineHeight: 16,
  },
  button: {
    minHeight: layout.minTarget,
    justifyContent: 'center',
    backgroundColor: colors.panel,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHairline,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    ...Platform.select({ web: { cursor: 'pointer' as const }, default: {} }),
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
  buttonTextDanger: {
    color: colors.failed,
  },
  hint: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.micro,
    paddingHorizontal: spacing.xs,
  },
  error: {
    color: colors.failed,
    fontFamily: fonts.ui,
    fontSize: fontSizes.tiny,
    paddingTop: spacing.xxs,
  },
});
