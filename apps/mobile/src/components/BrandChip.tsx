import React from 'react';
import { Image, StyleSheet, View } from 'react-native';

import { brandChip, colors } from '../theme/tokens';
import brandMark from '../../assets/brand/favicon.png';

/** The Lina mark in a rounded chip, as the desktop draws it. */
export function BrandChip({ size = brandChip.size }: { size?: number }) {
  const radius = Math.round((brandChip.radius / brandChip.size) * size);
  return (
    <View style={[styles.chip, { width: size, height: size, borderRadius: radius }]}>
      <Image
        source={brandMark}
        style={{ width: size - 8, height: size - 8 }}
        resizeMode="contain"
        accessibilityIgnoresInvertColors
      />
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: brandChip.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHairline,
    overflow: 'hidden',
  },
});
