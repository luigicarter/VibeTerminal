import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, StyleSheet, View } from 'react-native';

import { colors, dotSizes, layout, radii, spacing } from '../theme/tokens';

const NATIVE = Platform.OS !== 'web';

/** One shimmering bar: `element` underneath, `elementHover` pulsing over it. */
function Bar({ width, height = 11 }: { width: number | `${number}%`; height?: number }) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: NATIVE,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: NATIVE,
        }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [pulse]);

  return (
    <View style={[styles.bar, { width, height, borderRadius: height / 2 }]}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.barPulse, { opacity: pulse }]} />
    </View>
  );
}

/**
 * What a list shows while its first state is on its way.
 *
 * Three rows shaped like the rows that are coming, rather than the word
 * "Loading…": the screen does not change shape when the data lands, and the
 * shimmer says the app is waiting on the desktop rather than stuck.
 */
export function SkeletonRows({ count = 3, testID = 'skeleton' }: { count?: number; testID?: string }) {
  return (
    <View testID={testID} accessibilityLabel="Loading" accessibilityRole="progressbar">
      {Array.from({ length: count }, (_, index) => (
        <View key={index} style={styles.row}>
          <View style={styles.dot} />
          <View style={styles.body}>
            <Bar width={index === 1 ? '52%' : '38%'} height={12} />
            <Bar width={index === 2 ? '64%' : '76%'} height={9} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: layout.gutter,
    paddingVertical: spacing.md,
  },
  dot: {
    width: dotSizes.session,
    height: dotSizes.session,
    borderRadius: dotSizes.session / 2,
    backgroundColor: colors.element,
  },
  body: {
    flex: 1,
    gap: spacing.xs,
  },
  bar: {
    backgroundColor: colors.element,
    overflow: 'hidden',
    borderRadius: radii.pill,
  },
  barPulse: {
    backgroundColor: colors.elementHover,
  },
});
