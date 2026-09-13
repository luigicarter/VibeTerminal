import Feather from '@expo/vector-icons/Feather';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fontSizes, fonts, layout, radii, spacing, touchArea } from '../theme/tokens';

export type SheetProps = {
  visible: boolean;
  /** Called by the X, the backdrop, a downward swipe and hardware back alike. */
  onClose: () => void;
  title?: string;
  subtitle?: string;
  /** A sheet that is only an answer to a question has nothing to close to. */
  showClose?: boolean;
  children: React.ReactNode;
  testID?: string;
  style?: ViewStyle;
};

/** Far enough that the sheet is off the bottom of any phone before it opens. */
const TRAVEL = 720;

/** A drag this far down, or this fast, is a dismissal rather than a wobble. */
const DISMISS_DISTANCE = 96;
const DISMISS_VELOCITY = 0.7;

const NATIVE = Platform.OS !== 'web';

/**
 * The one bottom sheet in the app: History, and every confirmation.
 *
 * It closes four ways and they are all the same way — the X, a tap on the
 * backdrop, a downward swipe on its head, and the hardware back button — so
 * there is nothing to learn twice. The swipe is bound to the head rather than
 * the whole sheet so that a list inside it still scrolls; that is also why this
 * needs no gesture library.
 */
export function Sheet({
  visible,
  onClose,
  title,
  subtitle,
  showClose = true,
  children,
  testID = 'sheet',
  style,
}: SheetProps) {
  const insets = useSafeAreaInsets();
  const [mounted, setMounted] = useState(visible);
  const offset = useRef(new Animated.Value(TRAVEL)).current;
  const backdrop = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      offset.setValue(TRAVEL);
      Animated.parallel([
        Animated.timing(offset, {
          toValue: 0,
          duration: 240,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: NATIVE,
        }),
        Animated.timing(backdrop, { toValue: 1, duration: 180, useNativeDriver: NATIVE }),
      ]).start();
      return;
    }
    Animated.parallel([
      Animated.timing(offset, {
        toValue: TRAVEL,
        duration: 200,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: NATIVE,
      }),
      Animated.timing(backdrop, { toValue: 0, duration: 200, useNativeDriver: NATIVE }),
    ]).start(({ finished }) => {
      if (finished) setMounted(false);
    });
  }, [backdrop, offset, visible]);

  const settle = useCallback(() => {
    Animated.spring(offset, { toValue: 0, bounciness: 0, useNativeDriver: NATIVE }).start();
  }, [offset]);

  // The head is the handle: a drag that starts there belongs to the sheet, and
  // a drag that starts in the list below belongs to the list.
  const dragging = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          gesture.dy > 4 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderMove: (_event, gesture) => {
          offset.setValue(Math.max(0, gesture.dy));
        },
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dy > DISMISS_DISTANCE || gesture.vy > DISMISS_VELOCITY) onClose();
          else settle();
        },
        onPanResponderTerminate: settle,
      }),
    [offset, onClose, settle]
  );

  if (!mounted) return null;

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        <Animated.View style={[styles.backdropFill, { opacity: backdrop }]} pointerEvents="none" />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          testID={`${testID}-backdrop`}
          style={styles.backdropTouch}
          onPress={onClose}
        />
        <Animated.View
          style={[
            styles.sheet,
            {
              paddingBottom: insets.bottom + spacing.sm,
              paddingLeft: insets.left,
              paddingRight: insets.right,
              transform: [{ translateY: offset }],
            },
            style,
          ]}
          testID={testID}
        >
          <View {...dragging.panHandlers}>
            <View style={styles.grabber} />
            {title ? (
              <View style={styles.head}>
                <View style={styles.headTitles}>
                  <Text style={styles.headTitle} numberOfLines={1}>
                    {title}
                  </Text>
                  {subtitle ? (
                    <Text style={styles.headSubtitle} numberOfLines={1}>
                      {subtitle}
                    </Text>
                  ) : null}
                </View>
                {showClose ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Close"
                    testID={`${testID}-close`}
                    onPress={onClose}
                    style={({ pressed }) => [styles.close, pressed && styles.closePressed]}
                    hitSlop={touchArea(36)}
                  >
                    <Feather name="x" size={18} color={colors.textSecondary} />
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </View>
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdropFill: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  backdropTouch: {
    flex: 1,
    ...Platform.select({ web: { cursor: 'pointer' as const }, default: {} }),
  },
  sheet: {
    backgroundColor: colors.app,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderHairline,
  },
  grabber: {
    alignSelf: 'center',
    width: layout.grabberWidth,
    height: layout.grabberHeight,
    borderRadius: radii.pill,
    backgroundColor: colors.element,
    marginTop: spacing.sm,
    marginBottom: spacing.xxs,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: layout.headerHeight,
    paddingHorizontal: layout.gutter,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderHairline,
  },
  headTitles: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  headTitle: {
    color: colors.textPrimary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.title,
    fontWeight: '600',
  },
  headSubtitle: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.tiny,
  },
  close: {
    width: 36,
    height: 36,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({ web: { cursor: 'pointer' as const }, default: {} }),
  },
  closePressed: {
    backgroundColor: colors.elementHover,
  },
});
