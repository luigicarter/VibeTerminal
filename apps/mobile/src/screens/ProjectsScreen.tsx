import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import type { Project } from '../api/types';
import { AppHeader } from '../components/AppHeader';
import { AskLinaRow } from '../components/AskLinaRow';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { ConnectionDot, connectionToneLabel, useConnectionTone } from '../components/ConnectionDot';
import { InboxRow } from '../components/InboxRow';
import { EmptyState, Screen, SectionTitle, useSideInsets } from '../components/Layout';
import { ProjectRow } from '../components/ProjectRow';
import { RowSeparator } from '../components/RowShell';
import { SkeletonRows } from '../components/Skeleton';
import type { RootScreenProps } from '../navigation/types';
import { useBridge } from '../state/bridge';
import { inboxSessions, projectAttention, projectCounts } from '../state/selectors';
import { animateSection } from '../theme/motion';
import { colors, fontSizes, fonts, spacing } from '../theme/tokens';

/**
 * Home: the Orchestrator on top, then every project open on the desktop.
 *
 * This is a root screen, so it registers no back handler: one press there is
 * Android's to answer, and Android sends the task to the back.
 */
export function ProjectsScreen({ navigation }: RootScreenProps<'Projects'>) {
  const { state, pairing, refresh, orchestratorSnippet, status } = useBridge();
  const tone = useConnectionTone();
  const sides = useSideInsets();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const projects = state?.projects ?? [];
  const loading = !state && status !== 'offline';
  // Everything holding for the person, wherever it is. Nothing to show, no section.
  const inbox = inboxSessions(state);

  // The inbox appears and disappears on its own as terminals ask and are
  // answered, so the list slides rather than jumping.
  const inboxSize = useRef(inbox.length);
  useEffect(() => {
    const present = inbox.length > 0;
    const was = inboxSize.current > 0;
    inboxSize.current = inbox.length;
    if (present !== was) animateSection();
  }, [inbox.length]);

  const renderProject = useCallback(
    ({ item }: { item: Project }) => (
      <ProjectRow
        project={item}
        attention={projectAttention(state, item.id)}
        counts={projectCounts(state, item)}
        onPress={() => navigation.navigate('Project', { projectId: item.id })}
      />
    ),
    [navigation, state]
  );

  return (
    <Screen>
      <AppHeader
        title="Lina"
        subtitleContent={
          <>
            <ConnectionDot tone={tone} />
            <Text style={styles.host} numberOfLines={1}>
              {pairing?.desktopHost || pairing?.host || 'desktop'}
              {tone === 'connected' ? '' : ` · ${connectionToneLabel(tone)}`}
            </Text>
          </>
        }
        actions={[{ icon: 'settings', label: 'Settings', onPress: () => navigation.navigate('Settings') }]}
      />
      <ConnectionBanner />
      <FlatList
        data={projects}
        keyExtractor={item => item.id}
        renderItem={renderProject}
        ItemSeparatorComponent={RowSeparator}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.textMuted}
            colors={[colors.textMuted]}
            progressBackgroundColor={colors.panel}
          />
        }
        ListHeaderComponent={
          <View>
            <AskLinaRow
              orchestrator={state?.orchestrator ?? null}
              snippet={orchestratorSnippet}
              onPress={() => navigation.navigate('Lina')}
            />
            <RowSeparator />
            {inbox.length > 0 ? (
              <View testID="inbox-section">
                <SectionTitle>Waiting for you · {inbox.length}</SectionTitle>
                {inbox.map((session, index) => (
                  <View key={session.id}>
                    {index === 0 ? null : <RowSeparator />}
                    <InboxRow
                      session={session}
                      onPress={() => navigation.navigate('Chat', { sessionId: session.id })}
                    />
                  </View>
                ))}
                <RowSeparator />
              </View>
            ) : null}
            <SectionTitle>Projects{loading ? '' : ` · ${projects.length}`}</SectionTitle>
          </View>
        }
        ListEmptyComponent={
          loading ? (
            <SkeletonRows testID="projects-skeleton" />
          ) : (
            <EmptyState
              testID="projects-empty"
              title="No projects open on the desktop."
              detail="Open a folder in Lina Terminal and it appears here."
              actionLabel="Check again"
              onAction={() => void refresh()}
            />
          )
        }
        contentContainerStyle={[styles.list, sides]}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  host: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: fontSizes.tiny,
    flexShrink: 1,
  },
  list: {
    paddingBottom: spacing.xl,
  },
});
