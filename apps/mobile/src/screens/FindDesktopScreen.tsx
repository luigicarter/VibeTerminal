import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { AppHeader } from '../components/AppHeader';
import { BrandChip } from '../components/BrandChip';
import { Banner, EmptyState, Screen, useSideInsets } from '../components/Layout';
import { RowSeparator, RowShell } from '../components/RowShell';
import type { RootScreenProps } from '../navigation/types';
import { useBridge } from '../state/bridge';
import { Discovered, discoverDesktops } from '../state/discovery';
import { colors, fontSizes, fonts, layout, radii, spacing, touchArea } from '../theme/tokens';

/**
 * The front door: the phone looks for desktops itself. Typing an address is
 * still possible, but it is the escape hatch at the bottom, not the ask.
 */
export function FindDesktopScreen({ navigation }: RootScreenProps<'Find'>) {
  const { authError } = useBridge();
  const sides = useSideInsets();
  const [found, setFound] = useState<Discovered[]>([]);
  const [scanning, setScanning] = useState(true);
  const [progress, setProgress] = useState('Looking for desktops…');
  const [run, setRun] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setFound([]);
    setScanning(true);
    setProgress('Looking for desktops…');
    discoverDesktops({
      signal: controller.signal,
      onFound: desktop =>
        setFound(current =>
          current.some(entry => entry.desktopId === desktop.desktopId) ? current : [...current, desktop]
        ),
      onProgress: label => {
        if (!controller.signal.aborted) setProgress(label);
      },
    })
      .catch(() => undefined)
      .finally(() => {
        if (controller.signal.aborted) return;
        setScanning(false);
        setProgress('');
      });
    return () => controller.abort();
  }, [run]);

  const openDesktop = useCallback(
    (desktop: Discovered) => {
      navigation.navigate('Approve', {
        host: desktop.host,
        port: desktop.port,
        desktopId: desktop.desktopId,
        desktopHost: desktop.desktopHost,
        version: desktop.version,
        readOnly: desktop.readOnly,
      });
    },
    [navigation]
  );

  return (
    <Screen>
      <AppHeader title="Find your desktop" leading={<BrandChip size={26} />} />
      <ScrollView contentContainerStyle={[styles.content, sides]}>
        {authError ? (
          <View style={styles.bannerWrap}>
            <Banner tone="error" text={authError} />
          </View>
        ) : null}

        {found.map((desktop, index) => (
          <View key={desktop.desktopId}>
            {index === 0 ? null : <RowSeparator />}
            <RowShell
              onPress={() => openDesktop(desktop)}
              accessibilityLabel={`Desktop ${desktop.desktopHost}`}
              testID={`discover-row-${desktop.desktopId}`}
            >
              <Feather name="monitor" size={18} color={colors.textMuted} />
              <View style={styles.rowBody}>
                <View style={styles.rowTop}>
                  <Text style={styles.name} numberOfLines={1}>
                    {desktop.desktopHost}
                  </Text>
                  {desktop.readOnly ? (
                    <View style={styles.tag}>
                      <Text style={styles.tagText}>READ-ONLY</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={styles.detail} numberOfLines={1}>
                  {desktop.host}:{desktop.port}
                  {desktop.version ? ` · ${desktop.version}` : ''}
                </Text>
              </View>
              <Feather name="chevron-right" size={16} color={colors.textMuted} />
            </RowShell>
          </View>
        ))}

        {scanning ? (
          <View style={styles.progressRow}>
            <ActivityIndicator size="small" color={colors.textMuted} />
            <Text style={styles.progress} numberOfLines={1}>
              {progress || 'Looking for desktops…'}
            </Text>
          </View>
        ) : null}

        {!scanning && found.length === 0 ? (
          <EmptyState
            title="No desktop found on this network."
            detail="On the desktop, open Settings → Phone and turn on phone connections."
            testID="discover-empty"
            actionLabel="Scan again"
            onAction={() => setRun(value => value + 1)}
          />
        ) : null}

        {!scanning && found.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Scan again"
            testID="discover-scan-again"
            onPress={() => setRun(value => value + 1)}
            style={({ pressed }) => [styles.button, styles.buttonQuiet, pressed && styles.buttonPressed]}
          >
            <Text style={styles.buttonQuietText}>Scan again</Text>
          </Pressable>
        ) : null}

        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Enter an address instead"
          testID="discover-manual-link"
          onPress={() => navigation.navigate('ManualPair')}
          hitSlop={touchArea(200, 44)}
          style={styles.link}
        >
          <Text style={styles.linkText}>Enter an address instead</Text>
        </Pressable>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: spacing.xl,
    maxWidth: 520,
    width: '100%',
    alignSelf: 'center',
  },
  bannerWrap: {
    padding: layout.gutter,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  name: {
    color: colors.textPrimary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.base,
    fontWeight: '600',
    flexShrink: 1,
  },
  tag: {
    borderWidth: 1,
    borderColor: '#4f4f4f',
    borderRadius: radii.pill,
    paddingVertical: 1,
    paddingHorizontal: 6,
  },
  tagText: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.micro,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  detail: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.tiny,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: layout.gutter,
    paddingVertical: spacing.md,
  },
  progress: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.small,
    flexShrink: 1,
  },
  button: {
    marginHorizontal: layout.gutter,
    marginTop: spacing.xs,
    minHeight: layout.minTarget,
    justifyContent: 'center',
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    alignItems: 'center',
    ...Platform.select({ web: { cursor: 'pointer' as const }, default: {} }),
  },
  buttonQuiet: {
    backgroundColor: colors.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHairline,
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonText: {
    color: colors.app,
    fontFamily: fonts.ui,
    fontSize: fontSizes.base,
    fontWeight: '700',
  },
  buttonQuietText: {
    color: colors.textPrimary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.base,
    fontWeight: '600',
  },
  link: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: layout.minTarget,
    marginVertical: spacing.md,
    ...Platform.select({ web: { cursor: 'pointer' as const }, default: {} }),
  },
  linkText: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.tiny,
    textDecorationLine: 'underline',
  },
});
