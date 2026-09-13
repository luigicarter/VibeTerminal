import React, { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';

import { colors } from '../theme/tokens';
import { TerminalOverlay } from './TerminalOverlay';
import { useLiveTerminal, type LiveTerminalProps } from './liveTerminalState';

/**
 * The desktop's own xterm rendering of one terminal, live, in a WebView.
 *
 * The page streams the session over server-sent events — protocol 2, changed
 * rows only — and owns the rendering; this app owns the chrome around it.
 * Everything it says comes back through `postMessage` as
 * `{type:'ready'|'exit'|'error'|'stats'}`.
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
  const webRef = useRef<WebView | null>(null);
  const { phase, detail, reloadKey, handleMessage, fail, retry } = useLiveTerminal({
    onControl,
    onFallback,
    onStats,
    resetKey: `${sessionId}|${url}`,
  });

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => handleMessage(event.nativeEvent.data),
    [handleMessage]
  );

  /** Everything the screen around this view can ask the page to do. */
  const call = useCallback((expression: string) => {
    webRef.current?.injectJavaScript(`window.linaTerminal && ${expression}; true;`);
  }, []);

  /** A tap belongs to the terminal, so put the caret back in it. */
  const focusTerminal = useCallback(() => call('window.linaTerminal.focus()'), [call]);

  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      focus: focusTerminal,
      zoom: delta => call(`window.linaTerminal.zoom(${Number(delta) || 0})`),
      resetZoom: () => call('window.linaTerminal.resetZoom()'),
      fit: () => call('window.linaTerminal.fit()'),
    };
    return () => {
      handleRef.current = null;
    };
  }, [call, focusTerminal, handleRef]);

  return (
    <View
      style={styles.fill}
      testID={phase === 'ready' ? `${testID}-ready` : testID}
      onTouchStart={focusTerminal}
    >
      <WebView
        key={reloadKey}
        ref={webRef}
        source={{ uri: url }}
        // The paired desktop and nothing else.
        originWhitelist={[`${origin}/*`]}
        javaScriptEnabled
        domStorageEnabled={false}
        onMessage={onMessage}
        onError={event => fail(event.nativeEvent.description)}
        onHttpError={event => fail(`The desktop answered ${event.nativeEvent.statusCode}.`)}
        onContentProcessDidTerminate={() => fail('The terminal view stopped.')}
        bounces={false}
        overScrollMode="never"
        // The page zooms and pans itself: pinch, drag, and a double tap all
        // belong to the wrapper inside it, not to the WebView's own scroller.
        // Nothing here may ever scroll, least of all sideways.
        scrollEnabled={false}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        setSupportMultipleWindows={false}
        // The dark style keeps a white flash out of the terminal while it loads.
        style={styles.web}
        containerStyle={styles.web}
      />
      <TerminalOverlay
        phase={phase}
        detail={detail}
        onRetry={retry}
        testID={`${testID}-overlay`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.terminalBackground,
  },
  web: {
    flex: 1,
    backgroundColor: colors.terminalBackground,
  },
});
