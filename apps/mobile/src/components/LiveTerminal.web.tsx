import React, { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';

import { colors } from '../theme/tokens';
import { TerminalOverlay } from './TerminalOverlay';
import { useLiveTerminal, type LiveTerminalProps } from './liveTerminalState';

/**
 * The browser build of the live terminal: the same page, in an iframe.
 *
 * react-native-webview has no web implementation, and does not need one — the
 * terminal page is a web page. It talks back through `window.postMessage`
 * instead of `ReactNativeWebView.postMessage`, and only messages from the
 * paired desktop's origin are believed. Commands go the other way as
 * `{type:'focus'|'zoom'|'resetZoom'|'fit'}`, because a cross-origin frame
 * cannot be scripted the way `injectJavaScript` scripts a WebView.
 */
export function LiveTerminal({
  url,
  origin,
  sessionId,
  onControl,
  onFallback,
  onStats,
  handleRef,
  testID = 'chat-terminal',
}: LiveTerminalProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const { phase, detail, reloadKey, handleMessage, fail, retry } = useLiveTerminal({
    onControl,
    onFallback,
    onStats,
    resetKey: `${sessionId}|${url}`,
  });

  useEffect(() => {
    const onWindowMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return;
      handleMessage(event.data);
    };
    window.addEventListener('message', onWindowMessage);
    return () => window.removeEventListener('message', onWindowMessage);
  }, [handleMessage, origin]);

  const command = useCallback(
    (message: Record<string, unknown>) => {
      frameRef.current?.contentWindow?.postMessage(JSON.stringify(message), origin);
    },
    [origin]
  );

  const focusTerminal = useCallback(() => command({ type: 'focus' }), [command]);

  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      focus: focusTerminal,
      zoom: delta => command({ type: 'zoom', delta }),
      resetZoom: () => command({ type: 'resetZoom' }),
      fit: () => command({ type: 'fit' }),
    };
    return () => {
      handleRef.current = null;
    };
  }, [command, focusTerminal, handleRef]);

  return (
    <View style={styles.fill} testID={phase === 'ready' ? `${testID}-ready` : testID}>
      <iframe
        key={reloadKey}
        ref={frameRef}
        src={url}
        title="Terminal"
        onLoad={focusTerminal}
        onError={() => fail()}
        style={IFRAME_STYLE}
      />
      <TerminalOverlay phase={phase} detail={detail} onRetry={retry} testID={`${testID}-overlay`} />
    </View>
  );
}

const IFRAME_STYLE: React.CSSProperties = {
  border: 'none',
  width: '100%',
  height: '100%',
  display: 'block',
  flexGrow: 1,
  flexShrink: 1,
  minHeight: 0,
  backgroundColor: colors.terminalBackground,
};

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: colors.terminalBackground,
  },
});
