import React, { useCallback, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet } from 'react-native';

import type { Session } from '../api/types';
import { AppHeader } from '../components/AppHeader';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { EmptyState, Screen, useSideInsets } from '../components/Layout';
import { RowSeparator } from '../components/RowShell';
import { SessionRow } from '../components/SessionRow';
import { SkeletonRows } from '../components/Skeleton';
import type { RootScreenProps } from '../navigation/types';
import { useBridge } from '../state/bridge';
import { findProject, sessionsForProject } from '../state/selectors';
import { colors, spacing } from '../theme/tokens';

/** One project: its terminals, newest and neediest first. */
export function ProjectScreen({ navigation, route }: RootScreenProps<'Project'>) {
  const { projectId } = route.params;
  const { state, refresh, status } = useBridge();
  const sides = useSideInsets();
  const [refreshing, setRefreshing] = useState(false);

  const project = findProject(state, projectId);
  const sessions = sessionsForProject(state, projectId);
  const loading = !state && status !== 'offline';

  // Hardware back is the native stack's: one press pops this screen. The header
  // chevron does the same thing, so both routes are one line of code.
  const goBack = useCallback(() => navigation.goBack(), [navigation]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const renderSession = useCallback(
    ({ item }: { item: Session }) => (
      <SessionRow session={item} onPress={() => navigation.navigate('Chat', { sessionId: item.id })} />
    ),
    [navigation]
  );

  return (
    <Screen>
      <AppHeader
        title={project?.name || 'Project'}
        subtitle={project?.path || ''}
        onBack={goBack}
        actions={[{ icon: 'settings', label: 'Settings', onPress: () => navigation.navigate('Settings') }]}
      />
      <ConnectionBanner />
      <FlatList
        data={sessions}
        keyExtractor={item => item.id}
        renderItem={renderSession}
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
        ListEmptyComponent={
          loading ? (
            <SkeletonRows testID="project-skeleton" />
          ) : project ? (
            <EmptyState
              testID="project-empty"
              title="No terminals in this project."
              detail="Open one in Lina Terminal on the desktop."
              actionLabel="Check again"
              onAction={() => void refresh()}
            />
          ) : (
            <EmptyState
              testID="project-gone"
              title="This project is no longer open on the desktop."
              actionLabel="Back to projects"
              onAction={goBack}
            />
          )
        }
        contentContainerStyle={[styles.list, sides]}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: {
    paddingBottom: spacing.xl,
  },
});
