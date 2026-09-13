import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, StyleSheet, View } from 'react-native';

import { sessionDotColor } from '../theme/status';
import { colors, dotSizes } from '../theme/tokens';

/** The 7px dot the desktop puts in front of every session row. */
export function SessionDot({ status }: { status: string }) {
  return (
    <View
      style={[
        styles.sessionDot,
        { backgroundColor: sessionDotColor(status) },
      ]}
    />
  );
}

/**
 * A spinning ring, drawn rather than borrowed.
 *
 * Android's own `ActivityIndicator` is a ring at rest and a moving arc while it
 * spins, and a screenshot of it — or a frame drawn before its animator has
 * started — is a dash rather than a ring. This is two rounded borders and a
 * rotation, so it is a ring in every frame, on both platforms.
 */
export function Ring({
  size = dotSizes.workingRing,
  thickness = 2,
  color = colors.working,
  track = colors.workingDim,
  label,
}: {
  size?: number;
  thickness?: number;
  color?: string;
  track?: string;
  label?: string;
}) {
  const spin = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        // react-native-web has no native animation module.
        useNativeDriver: Platform.OS !== 'web',
      })
    );
    animation.start();
    return () => animation.stop();
  }, [spin]);

  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <Animated.View
      accessibilityRole={label ? 'progressbar' : undefined}
      accessibilityLabel={label}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: thickness,
        borderColor: track,
        borderTopColor: color,
        transform: [{ rotate }],
      }}
    />
  );
}

/** A 9px ring that spins while work is running. */
export function WorkingRing({ size = dotSizes.workingRing }: { size?: number }) {
  return <Ring size={size} />;
}

/**
 * The desktop's attention marker: a blue dot inside a soft halo, or the
 * spinning ring while the terminal is working.
 */
export function AttentionDot({ working = false }: { working?: boolean }) {
  if (working) {
    return (
      <View style={styles.attentionBox}>
        <WorkingRing />
      </View>
    );
  }
  return (
    <View style={styles.attentionBox}>
      <View style={styles.halo}>
        <View style={styles.attentionDot} />
      </View>
    </View>
  );
}

/** Keeps rows aligned when a project has nothing to signal. */
export function DotSpacer() {
  return <View style={styles.attentionBox} />;
}

/** The small accent dot in front of an agent label. */
export function AgentDot({ color }: { color: string }) {
  return <View style={[styles.agentDot, { backgroundColor: color }]} />;
}

const haloSize = dotSizes.attention + dotSizes.attentionHalo * 2;

const styles = StyleSheet.create({
  sessionDot: {
    width: dotSizes.session,
    height: dotSizes.session,
    borderRadius: dotSizes.session / 2,
  },
  attentionBox: {
    width: haloSize,
    height: haloSize,
    alignItems: 'center',
    justifyContent: 'center',
  },
  halo: {
    width: haloSize,
    height: haloSize,
    borderRadius: haloSize / 2,
    backgroundColor: colors.waitingDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attentionDot: {
    width: dotSizes.attention,
    height: dotSizes.attention,
    borderRadius: dotSizes.attention / 2,
    backgroundColor: colors.waiting,
  },
  agentDot: {
    width: dotSizes.agent,
    height: dotSizes.agent,
    borderRadius: dotSizes.agent / 2,
  },
});
