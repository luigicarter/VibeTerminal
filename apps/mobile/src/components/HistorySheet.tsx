import React, { useCallback, useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { TranscriptMessage } from '../api/types';
import { colors, fontSizes, fonts, layout, radii, spacing } from '../theme/tokens';
import { Bubble } from './Bubble';
import { EmptyState } from './Layout';
import { Sheet } from './Sheet';

export type HistorySheetProps = {
  visible: boolean;
  title: string;
  messages: TranscriptMessage[];
  /** True while the first page is on its way; the sheet shows a spinner. */
  loading: boolean;
  /** True while an earlier page is on its way. */
  loadingEarlier?: boolean;
  /** Null once the beginning has been reached: the button disappears. */
  canLoadEarlier: boolean;
  /** How many messages the desktop holds in all, when it says. */
  total?: number | null;
  /** Set when the desktop has no transcript for this terminal at all. */
  unsupported?: boolean;
  error?: string | null;
  onLoadEarlier: () => void;
  onClose: () => void;
  testID?: string;
};

/**
 * The conversation, read-only, in a sheet over the terminal.
 *
 * The terminal is the thing; this is the record of it. It is opened by hand and
 * paged by hand, so a phone that never opens it never pays for a transcript.
 * It opens at the newest message, and "Load earlier" prepends without moving
 * what the reader is looking at: the content grows above the viewport, so the
 * scroll offset is pushed down by exactly as much as it grew.
 */
export function HistorySheet({
  visible,
  title,
  messages,
  loading,
  loadingEarlier = false,
  canLoadEarlier,
  total,
  unsupported = false,
  error,
  onLoadEarlier,
  onClose,
  testID = 'history-sheet',
}: HistorySheetProps) {
  const listRef = useRef<ScrollView | null>(null);
  /** The first page is the newest end of the conversation: open there. */
  const stickToEnd = useRef(true);
  const contentHeight = useRef(0);
  const scrollOffset = useRef(0);
  /** Set while an earlier page is being prepended, cleared once it lands. */
  const holdingPlace = useRef(false);

  useEffect(() => {
    if (!visible) return;
    stickToEnd.current = true;
    holdingPlace.current = false;
    contentHeight.current = 0;
    scrollOffset.current = 0;
  }, [visible]);

  const onContentSize = useCallback(
    (_width: number, height: number) => {
      const grewBy = height - contentHeight.current;
      contentHeight.current = height;
      if (stickToEnd.current) {
        if (loading) return;
        stickToEnd.current = false;
        listRef.current?.scrollToEnd({ animated: false });
        return;
      }
      // "Load earlier" put messages above the viewport. Stay where the reader is.
      if (holdingPlace.current && grewBy > 0) {
        holdingPlace.current = false;
        listRef.current?.scrollTo({ y: scrollOffset.current + grewBy, animated: false });
      }
    },
    [loading]
  );

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollOffset.current = event.nativeEvent.contentOffset.y;
  }, []);

  const loadEarlier = useCallback(() => {
    holdingPlace.current = true;
    onLoadEarlier();
  }, [onLoadEarlier]);

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="History"
      subtitle={`${title}${typeof total === 'number' && total > 0 ? ` · ${total} messages` : ''}`}
      testID={testID}
      style={styles.sheet}
    >
      <ScrollView
        ref={listRef}
        style={styles.flex}
        contentContainerStyle={styles.list}
        onContentSizeChange={onContentSize}
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        {canLoadEarlier ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Load earlier messages"
            testID={`${testID}-earlier`}
            disabled={loadingEarlier}
            onPress={loadEarlier}
            style={({ pressed }) => [styles.earlier, pressed && styles.earlierPressed]}
          >
            {loadingEarlier ? (
              <ActivityIndicator size="small" color={colors.textMuted} />
            ) : (
              <Text style={styles.earlierLabel}>Load earlier</Text>
            )}
          </Pressable>
        ) : null}
        {error ? (
          <Text style={styles.error} testID={`${testID}-error`}>
            {error}
          </Text>
        ) : null}
        {loading ? (
          <View style={styles.loading}>
            <ActivityIndicator size="small" color={colors.textMuted} />
          </View>
        ) : unsupported ? (
          <EmptyState title="No conversation history for this terminal." />
        ) : messages.length === 0 ? (
          <EmptyState title="Nothing has been said in this terminal yet." />
        ) : null}
        {messages.map((message, index) => (
          <Bubble key={`${index}-${message.role}`} role={message.role} text={message.text} />
        ))}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  sheet: {
    maxHeight: '82%',
    minHeight: '45%',
  },
  list: {
    paddingVertical: spacing.sm,
    gap: spacing.xxs,
  },
  loading: {
    paddingVertical: spacing.xl,
    alignItems: 'center',
  },
  earlier: {
    alignSelf: 'center',
    marginBottom: spacing.xs,
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: layout.gutter,
    borderRadius: radii.pill,
    backgroundColor: colors.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHairline,
    ...Platform.select({ web: { cursor: 'pointer' as const }, default: {} }),
  },
  earlierPressed: {
    backgroundColor: colors.surface,
  },
  earlierLabel: {
    color: colors.textSecondary,
    fontFamily: fonts.ui,
    fontSize: fontSizes.tiny,
    fontWeight: '600',
  },
  error: {
    color: colors.failed,
    fontFamily: fonts.ui,
    fontSize: fontSizes.tiny,
    textAlign: 'center',
    paddingBottom: spacing.xs,
  },
});
