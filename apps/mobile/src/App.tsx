import '@expo/metro-runtime';

import { DarkTheme, NavigationContainer, Theme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as ScreenOrientation from 'expo-screen-orientation';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { flushPendingSession, navigationRef, openSession } from './navigation/ref';
import type { RootStackParamList } from './navigation/types';
import { ApproveScreen } from './screens/ApproveScreen';
import { ChatScreen } from './screens/ChatScreen';
import { FindDesktopScreen } from './screens/FindDesktopScreen';
import { LinaScreen } from './screens/LinaScreen';
import { ManualPairScreen } from './screens/ManualPairScreen';
import { ProjectScreen } from './screens/ProjectScreen';
import { ProjectsScreen } from './screens/ProjectsScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { BridgeProvider, useBridge } from './state/bridge';
import { addNotificationTapListener, consumeInitialTap } from './state/notifier';
import { enableLayoutAnimation } from './theme/motion';
import { colors } from './theme/tokens';

const Stack = createNativeStackNavigator<RootStackParamList>();

/** The desktop's palette, handed to React Navigation. */
const navigationTheme: Theme = {
  ...DarkTheme,
  dark: true,
  colors: {
    primary: colors.accent,
    background: colors.app,
    card: colors.sidebar,
    text: colors.textPrimary,
    border: colors.borderHairline,
    notification: colors.waiting,
  },
};

/**
 * Pairing decides which stack exists at all.
 *
 * That is also the stack hygiene: pairing is not a screen the app pushes, it is
 * the condition the whole stack hangs off. Approving a desktop swaps the
 * discovery group for the project group, so Projects is the only screen behind
 * you — Find and Approve are gone rather than buried. Forgetting a desktop, or
 * going to look for another, swaps it back the same way.
 */
function RootNavigator() {
  const { ready, pairing } = useBridge();

  // A notification tapped before the paired stack existed has been held; the
  // moment `Chat` is a route, it is answered.
  useEffect(() => {
    if (ready && pairing) flushPendingSession();
  }, [ready, pairing]);

  if (!ready) {
    return <View style={styles.boot} />;
  }

  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        // Never a white or grey frame between two screens.
        contentStyle: { backgroundColor: colors.app },
        animation: 'slide_from_right',
        // Back is the stack's own: one press pops one screen, and no screen
        // adds a `BackHandler` listener to race it. `app.json` keeps
        // `predictiveBackGestureEnabled` false to match — nothing here
        // intercepts back, so there is nothing for a predictive animation to
        // run ahead of.
        navigationBarColor: colors.app,
        statusBarStyle: 'light',
      }}
    >
      {pairing ? (
        <Stack.Group>
          <Stack.Screen name="Projects" component={ProjectsScreen} />
          <Stack.Screen name="Project" component={ProjectScreen} />
          <Stack.Screen name="Chat" component={ChatScreen} />
          <Stack.Screen name="Lina" component={LinaScreen} />
          <Stack.Screen
            name="Settings"
            component={SettingsScreen}
            options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
          />
        </Stack.Group>
      ) : (
        <Stack.Group>
          <Stack.Screen name="Find" component={FindDesktopScreen} />
          <Stack.Screen name="Approve" component={ApproveScreen} />
          <Stack.Screen name="ManualPair" component={ManualPairScreen} />
        </Stack.Group>
      )}
    </Stack.Navigator>
  );
}

export default function App() {
  // A terminal wants the long edge. `app.json` already says `default`, but a
  // device or a launcher can still have pinned the app to portrait, so ask.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    void ScreenOrientation.unlockAsync().catch(() => {
      /* a tablet-less phone that refuses is no reason to fail the launch */
    });
  }, []);

  // Android does nothing with LayoutAnimation until this is switched on, and it
  // has to be switched on before the first section animates.
  useEffect(enableLayoutAnimation, []);

  // Tapping a notification opens the terminal it is about. Two paths reach
  // here: the app was already running, or the tap is what launched it.
  useEffect(() => {
    void consumeInitialTap().then(openSession);
    return addNotificationTapListener(openSession);
  }, []);

  return (
    <SafeAreaProvider>
      <View style={styles.root}>
        <BridgeProvider>
          <NavigationContainer
            theme={navigationTheme}
            ref={navigationRef}
            onReady={flushPendingSession}
          >
            <StatusBar style="light" />
            <RootNavigator />
          </NavigationContainer>
        </BridgeProvider>
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.app,
  },
  boot: {
    flex: 1,
    backgroundColor: colors.app,
  },
});
