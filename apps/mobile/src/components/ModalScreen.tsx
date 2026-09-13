import React, { useCallback, useMemo, useRef } from 'react';
import { Animated, Dimensions, PanResponder, Platform, StyleSheet, View } from 'react-native';

import { colors } from '../theme/tokens';

const NATIVE = Platform.OS !== 'web';

/** A drag this far down, or this fast, closes the modal. */
const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 0.8;

export type ModalScreenProps = {
  /** Called by the swipe; the X and hardware back call the same function. */
  onDismiss: () => void;
  /** The screen's header, which is also the sheet's grab handle. */
  header: React.ReactNode;
  children: React.ReactNode;
  testID?: string;
};

/**
 * A screen presented as a modal, with the swipe-down the platform does not give.
 *
 * The native stack slides a modal up on both platforms and lets iOS swipe it
 * away; Android has no such gesture. This adds one, on the header — a drag that
 * starts there belongs to the sheet, and a drag that starts in the content
 * belongs to the content, which is the same rule the bottom sheets follow. A
 * tap is not a drag, so the header's own buttons keep working.
 */
export function ModalScreen({ onDismiss, header, children, testID }: ModalScreenProps) {
  const offset = useRef(new Animated.Value(0)).current;

  const settle = useCallback(() => {
    Animated.spring(offset, { toValue: 0, bounciness: 0, useNativeDriver: NATIVE }).start();
  }, [offset]);

  const dragging = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_event, gesture) =>
          gesture.dy > 6 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderMove: (_event, gesture) => {
          offset.setValue(Math.max(0, gesture.dy));
        },
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dy > DISMISS_DISTANCE || gesture.vy > DISMISS_VELOCITY) {
            // Carry the sheet off the bottom, then let the stack take it away.
            Animated.timing(offset, {
              toValue: Dimensions.get('window').height,
              duration: 160,
              useNativeDriver: NATIVE,
            }).start(onDismiss);
            return;
          }
          settle();
        },
        onPanResponderTerminate: settle,
      }),
    [offset, onDismiss, settle]
  );

  return (
    <Animated.View style={[styles.screen, { transform: [{ translateY: offset }] }]} testID={testID}>
      <View {...dragging.panHandlers}>{header}</View>
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.app,
  },
});
