import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, fontSizes, fonts, spacing, terminalBlock } from '../theme/tokens';

/**
 * The raw screen text of a terminal, in the desktop's mono block.
 *
 * This is the fallback the app falls back to, and it obeys the same rule as the
 * live terminal: it never scrolls sideways. Long lines wrap instead.
 */
export function TerminalView({
  text,
  scrollRef,
  onContentSizeChange,
}: {
  text: string;
  scrollRef?: React.RefObject<ScrollView | null>;
  onContentSizeChange?: () => void;
}) {
  const body = text && text.length > 0 ? text : '';
  return (
    <View style={styles.block}>
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.content}
        onContentSizeChange={onContentSizeChange}
        horizontal={false}
        showsHorizontalScrollIndicator={false}
      >
        {body ? (
          <Text style={styles.text} selectable>
            {body}
          </Text>
        ) : (
          <Text style={styles.placeholder}>No output yet.</Text>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    flex: 1,
    backgroundColor: terminalBlock.background,
    margin: spacing.md,
    borderRadius: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHairline,
    overflow: 'hidden',
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: spacing.sm,
  },
  text: {
    color: terminalBlock.color,
    fontFamily: fonts.mono,
    fontSize: terminalBlock.fontSize,
    lineHeight: terminalBlock.lineHeight,
  },
  placeholder: {
    color: colors.textMuted,
    fontFamily: fonts.mono,
    fontSize: fontSizes.small,
  },
});
