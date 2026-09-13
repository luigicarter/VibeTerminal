import { useIsFocused } from '@react-navigation/native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, View } from 'react-native';

import { describeError, fetchOrchestratorHistory, isBridgeError, sendOrchestratorRequest } from '../api/client';
import { READ_ONLY_NOTE, isReadOnlyRejection } from '../api/readOnly';
import type { OrchestratorHistory, OrchestratorMessage, OrchestratorTask } from '../api/types';
import { toMillis } from '../api/types';
import { AppHeader } from '../components/AppHeader';
import { BrandChip } from '../components/BrandChip';
import { Bubble } from '../components/Bubble';
import { Composer } from '../components/Composer';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { Banner, EmptyState, Screen, useSideInsets } from '../components/Layout';
import { TaskCard } from '../components/TaskCard';
import type { RootScreenProps } from '../navigation/types';
import { useBridge } from '../state/bridge';
import { orchestratorStateLabel } from '../state/presence';
import { findProject, findSession } from '../state/selectors';
import { layout, spacing } from '../theme/tokens';

const HISTORY_INTERVAL_MS = 3000;
const PENDING_TTL_MS = 20000;

type TimelineItem =
  | { kind: 'message'; at: number; key: string; message: OrchestratorMessage }
  | { kind: 'task'; at: number; key: string; task: OrchestratorTask };

type Pending = { text: string; at: number };

/** The Orchestrator conversation: what Lina said, and what it set running. */
export function LinaScreen({ navigation }: RootScreenProps<'Lina'>) {
  const { state, connection, readOnly, markReadOnly } = useBridge();
  const isFocused = useIsFocused();
  const sides = useSideInsets();

  const goBack = useCallback(() => navigation.goBack(), [navigation]);

  const [history, setHistory] = useState<OrchestratorHistory | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const listRef = useRef<ScrollView | null>(null);

  const load = useCallback(async () => {
    if (!connection) return;
    try {
      const next = await fetchOrchestratorHistory(connection, { limit: 200 });
      setHistory(next);
      setPending(current => {
        if (!current) return null;
        const wanted = current.text.trim();
        const landed = next.messages.some(
          message => message.role === 'user' && (message.text || '').trim().includes(wanted)
        );
        return landed ? null : current;
      });
    } catch {
      /* keep the last good history */
    }
  }, [connection]);

  useEffect(() => {
    if (!isFocused || !connection) return;
    void load();
    const timer = setInterval(() => void load(), HISTORY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isFocused, connection, load]);

  useEffect(() => {
    if (!pending) return;
    const remaining = Math.max(0, PENDING_TTL_MS - (Date.now() - pending.at));
    const timer = setTimeout(() => setPending(null), remaining);
    return () => clearTimeout(timer);
  }, [pending]);

  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [];
    (history?.messages ?? []).forEach((message, index) => {
      items.push({
        kind: 'message',
        at: toMillis(message.at) ?? index,
        key: message.id || `message-${index}`,
        message,
      });
    });
    (history?.tasks ?? []).forEach((task, index) => {
      items.push({
        kind: 'task',
        at: toMillis(task.createdAt) ?? index,
        key: task.id || `task-${index}`,
        task,
      });
    });
    return items
      .map((item, index) => ({ item, index }))
      .sort((a, b) => (a.item.at === b.item.at ? a.index - b.index : a.item.at - b.item.at))
      .map(entry => entry.item);
  }, [history]);

  // Until the first history read lands, say nothing about readiness.
  const known = history ?? state?.orchestrator ?? null;
  const readinessLabel = orchestratorStateLabel(known) || 'connecting…';
  const enabled = known ? known.enabled !== false : true;

  const send = useCallback(
    async (text: string) => {
      if (!connection) return;
      setPending({ text, at: Date.now() });
      try {
        await sendOrchestratorRequest(connection, text);
        setNotice(null);
      } catch (caught) {
        setPending(null);
        if (isReadOnlyRejection(caught, 'orchestrator-request')) {
          markReadOnly();
          setNotice(null);
        } else if (isBridgeError(caught) && caught.kind === 'conflict') {
          setNotice('Turn the Orchestrator on in the desktop app');
        } else if (isBridgeError(caught) && caught.kind === 'unavailable') {
          setNotice('The desktop window is closed');
        } else {
          setNotice(describeError(caught, connection));
        }
        return;
      }
      await load();
    },
    [connection, load, markReadOnly]
  );

  return (
    <Screen>
      <AppHeader
        title="Ask Lina"
        subtitle={readinessLabel}
        leading={<BrandChip size={26} />}
        onBack={goBack}
        actions={[{ icon: 'settings', label: 'Settings', onPress: () => navigation.navigate('Settings') }]}
      />
      <ConnectionBanner />
      <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={0}>
        <ScrollView
          ref={listRef}
          style={styles.flex}
          contentContainerStyle={[styles.list, sides]}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        >
          {!enabled ? (
            <View style={styles.noticeWrap}>
              <Banner text="The Orchestrator is turned off on the desktop." />
            </View>
          ) : null}
          {history && timeline.length === 0 ? (
            <EmptyState title="Nothing asked yet." detail="Send Lina a goal and it will route the work." />
          ) : null}
          {timeline.map(item =>
            item.kind === 'message' ? (
              <Bubble key={item.key} role={item.message.role} text={item.message.text} />
            ) : (
              <TaskCard
                key={item.key}
                task={item.task}
                terminal={item.task.terminalId ? findSession(state, item.task.terminalId) : null}
                projectName={
                  item.task.projectId ? findProject(state, item.task.projectId)?.name ?? null : null
                }
              />
            )
          )}
          {pending ? <Bubble role="user" text={pending.text} pending /> : null}
        </ScrollView>
        {notice ? (
          <View style={styles.noticeWrap}>
            <Banner tone="error" text={notice} />
          </View>
        ) : null}
        <Composer
          testID="lina-composer"
          placeholder="Ask Lina to do something…"
          onSend={send}
          disabled={readOnly || !connection}
          disabledNote={readOnly ? READ_ONLY_NOTE : null}
        />
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  list: {
    paddingVertical: spacing.sm,
    gap: spacing.xxs,
  },
  noticeWrap: {
    paddingHorizontal: layout.gutter,
    paddingVertical: spacing.xs,
  },
});
