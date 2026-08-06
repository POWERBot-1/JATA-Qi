// TANYA Mobile — Expo reference app root.
//
// Boots the MobileAppController from persisted config, gates on session
// validity (silently rotating before expiry when IdP credentials exist), and
// presents the three-tab shell: Home (snapshot), Chat (streaming TANYA),
// Settings (session/device/IdP).

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { buildController, getController } from './src/api';
import LoginScreen from './src/screens/LoginScreen';
import HomeScreen from './src/screens/HomeScreen';
import ChatScreen from './src/screens/ChatScreen';
import SettingsScreen from './src/screens/SettingsScreen';

type Screen = 'home' | 'chat' | 'settings';

const TABS: Array<{ id: Screen; label: string; icon: string }> = [
  { id: 'home', label: 'Home', icon: '🏠' },
  { id: 'chat', label: 'Chat', icon: '💬' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
];

export default function App() {
  const [booting, setBooting] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [screen, setScreen] = useState<Screen>('home');

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const app = await buildController();
        const s = await app.sessionStatus();
        if (s.authenticated) {
          // Rotate silently before expiry, then refresh the home snapshot.
          await app.rotateIfExpiring(60_000);
          await app.registerDevice();
        }
        if (live) setAuthenticated(s.authenticated);
      } catch {
        // Server unreachable at boot — show the login screen.
      }
      if (live) setBooting(false);
    })();
    return () => {
      live = false;
    };
  }, []);

  const onAuthenticated = useCallback(() => setAuthenticated(true), []);
  const onLogout = useCallback(() => {
    getController().close();
    setAuthenticated(false);
  }, []);

  if (booting) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#38bdf8" />
        <Text style={styles.muted}>Booting TANYA…</Text>
      </View>
    );
  }

  if (!authenticated) {
    return (
      <>
        <StatusBar style="light" />
        <LoginScreen onAuthenticated={onAuthenticated} />
      </>
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      {screen === 'home' && <HomeScreen />}
      {screen === 'chat' && <ChatScreen />}
      {screen === 'settings' && <SettingsScreen onLogout={onLogout} />}
      <View style={styles.tabbar}>
        {TABS.map((t) => (
          <Pressable key={t.id} style={[styles.tab, screen === t.id && styles.tabActive]} onPress={() => setScreen(t.id)}>
            <Text style={styles.tabIcon}>{t.icon}</Text>
            <Text style={[styles.tabText, screen === t.id && styles.tabTextActive]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b1220' },
  center: { flex: 1, backgroundColor: '#0b1220', alignItems: 'center', justifyContent: 'center', gap: 12 },
  muted: { color: '#64748b', fontSize: 13 },
  tabbar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#1e2c4d', backgroundColor: '#0f1a30' },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 10, gap: 2 },
  tabActive: { backgroundColor: '#16213a' },
  tabIcon: { fontSize: 18 },
  tabText: { color: '#64748b', fontSize: 12, fontWeight: '600' },
  tabTextActive: { color: '#38bdf8' },
});
