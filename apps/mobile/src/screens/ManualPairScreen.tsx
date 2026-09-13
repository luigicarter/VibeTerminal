import React, { useCallback } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, Text } from 'react-native';

import { AppHeader } from '../components/AppHeader';
import { Screen, useSideInsets } from '../components/Layout';
import { PairForm } from '../components/PairForm';
import type { RootScreenProps } from '../navigation/types';
import { useBridge } from '../state/bridge';
import { colors, fontSizes, fonts, layout, spacing } from '../theme/tokens';

/**
 * The escape hatch behind "Enter an address instead": the old typed form, for a
 * desktop discovery cannot see — another subnet, a browser, a tunnel.
 */
export function ManualPairScreen({ navigation }: RootScreenProps<'ManualPair'>) {
  const { pair, pairing } = useBridge();
  const sides = useSideInsets();

  const goBack = useCallback(() => navigation.goBack(), [navigation]);

  return (
    <Screen>
      <AppHeader title="Enter an address" subtitle="Advanced" onBack={goBack} />
      <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={0}>
        <ScrollView contentContainerStyle={[styles.content, sides]} keyboardShouldPersistTaps="handled">
          <Text style={styles.explainer}>
            Open Settings → Phone on your desktop and turn on phone connections. It shows the address, the port
            and a pairing code.
          </Text>
          <PairForm initial={pairing} onPaired={pair} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  content: {
    padding: layout.gutter,
    gap: spacing.lg,
    maxWidth: 520,
    width: '100%',
    alignSelf: 'center',
  },
  explainer: {
    color: colors.textSecondary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.base,
    lineHeight: 19,
  },
});
