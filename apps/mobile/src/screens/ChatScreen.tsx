import { useIsFocused } from '@react-navigation/native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  TRANSCRIPT_PAGE,
  baseUrl,
  describeError,
  fetchScreen,
  fetchTranscript,
  isBridgeError,
  recordStreamBytes,
  sendKeys,
  terminalPageUrl,
} from '../api/client';
import { TERMINAL_KEYS } from '../api/keys';
import { READ_ONLY_NOTE, isReadOnlyRejection } from '../api/readOnly';
import type { ScreenResponse, TranscriptMessage } from '../api/types';
import { AgentBadge } from '../components/AgentBadge';
import { AppHeader } from '../components/AppHeader';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { HistorySheet } from '../components/HistorySheet';
import { KeyBar } from '../components/KeyBar';
import { Banner, Screen } from '../components/Layout';
import { LiveTerminal } from '../components/LiveTerminal';
import type { LiveTerminalHandle } from '../components/liveTerminalState';
import { PromptChips } from '../components/PromptChips';
import { NeedsYouPill, StatusPill } from '../components/StatusPill';
import { TerminalView } from '../components/TerminalView';
import type { RootScreenProps } from '../navigation/types';
import { useBridge } from '../state/bridge';
import { normalizeNeedsInput } from '../state/needsInput';
import { findSession } from '../state/selectors';
import { animateSection } from '../theme/motion';
import { colors, fontSizes, fonts, layout, spacing } from '../theme/tokens';

/**
 * Only the plain-text fallback polls, and only while it is what is on screen.
 * The live terminal is a stream, so nothing polls for it at all.
 */
const FALLBACK_SCREEN_INTERVAL_MS = 5000;

/**
 * One terminal, as a terminal.
 *
 * Opening a session lands in the desktop's own xterm rendering of it, filling
 * the screen under the header, with the key bar docked underneath. The
 * conversation is still there — it is the record of what happened — but it is
 * behind the History button, because the chat view was an imitation of the
 * terminal and this is the thing itself.
 */
export function ChatScreen({ navigation, route }: RootScreenProps<'Chat'>) {
  const { sessionId } = route.params;
  const { state, connection, readOnly, markReadOnly, appActive } = useBridge();
  const isFocused = useIsFocused();
  const session = findSession(state, sessionId);

  const [screenData, setScreenData] = useState<ScreenResponse | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** What the terminal page said about control; null when it has not said. */
  const [pageControl, setPageControl] = useState<boolean | null>(null);
  /** Set after the live terminal has failed twice: show the plain text instead. */
  const [plainTerminal, setPlainTerminal] = useState(false);

  /** The History sheet: opened by hand, and only then does a transcript load. */
  const [historyOpen, setHistoryOpen] = useState(false);
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [historyBefore, setHistoryBefore] = useState<number | null>(null);
  const [historyTotal, setHistoryTotal] = useState<number | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyEarlier, setHistoryEarlier] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  /**
   * The desktop has no transcript for this terminal. Nothing in `/api/state`
   * says so in advance, so the button stands until the first read answers.
   */
  const [noTranscript, setNoTranscript] = useState(false);

  const terminalScrollRef = useRef<ScrollView | null>(null);
  const liveRef = useRef<LiveTerminalHandle | null>(null);
  /** The page reports a running total; only the increase is new traffic. */
  const streamBytesRef = useRef(0);

  const loadScreen = useCallback(async () => {
    if (!connection) return;
    try {
      setScreenData(await fetchScreen(connection, sessionId));
    } catch {
      /* the text simply stops updating; the connection banner covers outages */
    }
  }, [connection, sessionId]);

  // Nothing polls while the live terminal is up. The fallback is the one thing
  // that has to ask again, and it asks at five seconds, not two.
  const pollScreen = isFocused && appActive && plainTerminal;
  useEffect(() => {
    if (!pollScreen || !connection) return;
    void loadScreen();
    const timer = setInterval(() => void loadScreen(), FALLBACK_SCREEN_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pollScreen, connection, loadScreen]);

  const exited = session?.status === 'exited' || screenData?.exited === true;
  const needsInput = useMemo(() => normalizeNeedsInput(session?.needsInput), [session?.needsInput]);

  // The chips card arrives and leaves as the terminal asks and is answered, and
  // it takes height from the terminal when it does: slide, do not jump.
  const hadChips = useRef(Boolean(needsInput));
  useEffect(() => {
    const present = Boolean(needsInput);
    if (present !== hadChips.current) {
      hadChips.current = present;
      animateSection();
    }
  }, [needsInput]);

  /**
   * One press of back does one thing. While the History sheet is open it is a
   * `Modal`, so Android gives the press to the sheet and it closes; underneath,
   * back leaves this terminal for wherever it was opened from — the project or,
   * from the inbox, the project list — which is the native stack's own pop.
   */
  const goBack = useCallback(() => navigation.goBack(), [navigation]);

  /**
   * May this phone send keys? The terminal page says so itself — it is the thing
   * that knows whether control was granted — and until it does, the pairing's
   * read-only flag is the best answer there is.
   */
  const keysAllowed =
    Boolean(connection) && !readOnly && !exited && (pageControl === null ? true : pageControl);

  /** Every key, chip and typed line goes through here, and nowhere else. */
  const keys = useCallback(
    async (data: string) => {
      if (!connection || !data) return;
      try {
        await sendKeys(connection, sessionId, data);
        setNotice(null);
      } catch (caught) {
        // 403 "control not allowed" and 404 mean the same thing: look, do not touch.
        if (isReadOnlyRejection(caught, 'keys')) {
          setPageControl(false);
          markReadOnly();
          setNotice(null);
          return;
        }
        setNotice(
          isBridgeError(caught) && caught.kind === 'conflict'
            ? 'This terminal has exited'
            : describeError(caught, connection)
        );
        return;
      }
      if (plainTerminal) await loadScreen();
    },
    [connection, loadScreen, markReadOnly, plainTerminal, sessionId]
  );

  const answerPrompt = useCallback((key: string) => keys(`${key}${TERMINAL_KEYS.enter}`), [keys]);

  /** The stream's own bill, as the page reports it every five seconds. */
  const onStats = useCallback((stats: { bytes: number }) => {
    const delta = stats.bytes - streamBytesRef.current;
    if (delta <= 0) return;
    streamBytesRef.current = stats.bytes;
    recordStreamBytes(delta);
  }, []);

  /* ---- History ---------------------------------------------------------- */

  const openHistory = useCallback(async () => {
    setHistoryOpen(true);
    if (!connection || historyLoading) return;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const page = await fetchTranscript(connection, sessionId, { limit: TRANSCRIPT_PAGE });
      const supported = page.status === 'found';
      setNoTranscript(!supported);
      setMessages(supported ? page.messages : []);
      setHistoryBefore(page.nextBefore ?? null);
      setHistoryTotal(typeof page.total === 'number' ? page.total : null);
    } catch (caught) {
      setHistoryError(describeError(caught, connection));
    } finally {
      setHistoryLoading(false);
    }
  }, [connection, historyLoading, sessionId]);

  const loadEarlier = useCallback(async () => {
    if (!connection || historyBefore === null || historyEarlier) return;
    setHistoryEarlier(true);
    setHistoryError(null);
    try {
      const page = await fetchTranscript(connection, sessionId, {
        limit: TRANSCRIPT_PAGE,
        before: historyBefore,
      });
      setMessages(current => [...page.messages, ...current]);
      setHistoryBefore(page.nextBefore ?? null);
      if (typeof page.total === 'number') setHistoryTotal(page.total);
    } catch (caught) {
      setHistoryError(describeError(caught, connection));
    } finally {
      setHistoryEarlier(false);
    }
  }, [connection, historyBefore, historyEarlier, sessionId]);

  /* ---- The terminal itself ----------------------------------------------- */

  const terminalUrl = connection ? terminalPageUrl(connection, sessionId) : '';
  const terminalOrigin = connection ? baseUrl(connection) : '';
  // Closing the stream is the single biggest saving there is, so the view is
  // unmounted — not hidden — the moment this screen stops being looked at.
  const showLive = Boolean(connection) && !plainTerminal && isFocused && appActive;

  const refit = useCallback(() => liveRef.current?.fit(), []);

  return (
    <Screen>
      <AppHeader
        title={session?.title || 'Terminal'}
        onBack={goBack}
        subtitleContent={
          session ? (
            <>
              <AgentBadge kind={session.kind} />
              {needsInput ? (
                <NeedsYouPill />
              ) : (
                <StatusPill status={session.status} label={session.statusLabel} />
              )}
            </>
          ) : (
            <Text style={styles.gone}>no longer open on the desktop</Text>
          )
        }
        actions={[
          ...(noTranscript
            ? []
            : [{ icon: 'clock' as const, label: 'History', onPress: () => void openHistory() }]),
          { icon: 'settings' as const, label: 'Settings', onPress: () => navigation.navigate('Settings') },
        ]}
      />
      <ConnectionBanner />
      {/*
        The key bar and the chips are the point of this screen, so the keyboard
        never covers them: the padding the keyboard needs is taken from the
        terminal, which re-fits itself to whatever height is left. The offset is
        zero because this view starts under the header — it measures its own
        frame against the keyboard, so there is nothing to correct for.
      */}
      <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={0}>
        {/* A rotation, and the keyboard, change this view's size; the page refits. */}
        <View style={styles.live} onLayout={refit}>
          {plainTerminal || !connection ? (
            <TerminalView
              text={screenData?.text ?? ''}
              scrollRef={terminalScrollRef}
              onContentSizeChange={() => terminalScrollRef.current?.scrollToEnd({ animated: false })}
            />
          ) : showLive ? (
            <LiveTerminal
              url={terminalUrl}
              origin={terminalOrigin}
              sessionId={sessionId}
              onControl={setPageControl}
              onFallback={() => setPlainTerminal(true)}
              onStats={onStats}
              handleRef={liveRef}
            />
          ) : (
            <View style={styles.paused} testID="chat-terminal-paused">
              <Text style={styles.pausedText}>
                Paused. The terminal stops streaming while the app is in the background.
              </Text>
            </View>
          )}
        </View>
        {notice ? (
          <View style={styles.noticeWrap}>
            <Banner tone="error" text={notice} />
          </View>
        ) : null}
        {needsInput ? (
          <PromptChips needsInput={needsInput} disabled={!keysAllowed} onChoose={answerPrompt} />
        ) : null}
        <KeyBar
          onKeys={keys}
          onFocusTerminal={() => liveRef.current?.focus()}
          onZoom={delta => liveRef.current?.zoom(delta)}
          disabled={!keysAllowed}
          disabledNote={exited ? 'This terminal has exited' : READ_ONLY_NOTE}
        />
      </KeyboardAvoidingView>
      <HistorySheet
        visible={historyOpen}
        title={session?.title || 'Terminal'}
        messages={messages}
        loading={historyLoading && messages.length === 0}
        loadingEarlier={historyEarlier}
        canLoadEarlier={historyBefore !== null && !noTranscript}
        total={historyTotal}
        unsupported={noTranscript}
        error={historyError}
        onLoadEarlier={() => void loadEarlier()}
        onClose={() => setHistoryOpen(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  live: {
    flex: 1,
    backgroundColor: colors.terminalBackground,
  },
  paused: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  pausedText: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.small,
    textAlign: 'center',
  },
  noticeWrap: {
    paddingHorizontal: layout.gutter,
    paddingBottom: spacing.xs,
  },
  gone: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.tiny,
  },
});
