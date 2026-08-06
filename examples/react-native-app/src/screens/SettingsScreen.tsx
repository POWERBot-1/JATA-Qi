import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { DeviceInfo, SessionStatus } from '@jataqi/mobile-app';
import { buildController, getController, saveConfig, type IdpCredentials } from '../api';

interface Props {
  onLogout: () => void;
}

/**
 * Settings — session health (live countdown + silent rotation), device
 * management, IdP credentials for refresh-token rotation, and logout.
 */
export default function SettingsScreen({ onLogout }: Props) {
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [idp, setIdp] = useState<IdpCredentials>({ clientId: '', clientSecret: '', refreshToken: '' });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    const app = getController();
    const [s, devices] = await Promise.all([app.sessionStatus(), app.listDevices()]);
    setSession(s);
    setDevice(devices.devices[0] ?? null);
  }, []);

  useEffect(() => {
    void refresh().catch(() => undefined);
    const timer = setInterval(() => void refresh().catch(() => undefined), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const rotate = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await getController().rotateNow();
      Alert.alert(r.rotated ? 'Session refreshed' : 'Rotation skipped', r.reason ?? `remaining ${r.remainingMs ?? 0}ms`);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const saveIdp = async (): Promise<void> => {
    const clean: IdpCredentials = { clientId: idp.clientId.trim(), clientSecret: idp.clientSecret.trim(), refreshToken: idp.refreshToken.trim() };
    await saveConfig({ idp: clean });
    await buildController(); // rebuild with the new credentials
    Alert.alert('Saved', 'IdP credentials stored — silent rotation will use them.');
    await refresh();
  };

  const unregister = async (): Promise<void> => {
    const r = await getController().unregisterDevice();
    Alert.alert('Device removed', r.removed ? 'Push delivery disabled for this device.' : 'No device to remove.');
    await refresh();
  };

  const secondsLeft = session?.authenticated ? Math.max(0, Math.floor(session.remainingMs / 1000)) : 0;

  return (
    <ScrollView style={styles.root}>
      <Text style={styles.title}>Settings</Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>🔐 Session</Text>
        {session?.authenticated ? (
          <>
            <Text style={styles.row}>Signed in as <Text style={styles.strong}>{session.username}</Text></Text>
            <Text style={styles.row}>Expires in {Math.floor(secondsLeft / 60)}m {secondsLeft % 60}s</Text>
            <Pressable style={styles.primary} onPress={() => void rotate()} disabled={busy}>
              <Text style={styles.primaryText}>↻ Refresh session (IdP rotation)</Text>
            </Pressable>
          </>
        ) : (
          <Text style={styles.muted}>Not authenticated.</Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>📱 Device</Text>
        {device ? (
          <>
            <Text style={styles.row}>ID: <Text style={styles.mono}>{device.id.slice(0, 12)}…</Text></Text>
            <Text style={styles.row}>Platform: {device.platform} · last seen {new Date(device.lastSeenAt).toLocaleTimeString()}</Text>
            <Pressable style={styles.danger} onPress={() => void unregister()}>
              <Text style={styles.dangerText}>Unregister device</Text>
            </Pressable>
          </>
        ) : (
          <Text style={styles.muted}>No device registered — sign in again to register.</Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>🗝️ IdP credentials (silent rotation)</Text>
        <Text style={styles.muted}>Provisioned once per user (client-credentials grant). Stored in secure storage.</Text>
        <TextInput style={styles.input} value={idp.clientId} onChangeText={(v: string) => setIdp({ ...idp, clientId: v })} placeholder="clientId" placeholderTextColor="#64748b" autoCapitalize="none" />
        <TextInput style={styles.input} value={idp.clientSecret} onChangeText={(v: string) => setIdp({ ...idp, clientSecret: v })} placeholder="clientSecret" placeholderTextColor="#64748b" autoCapitalize="none" secureTextEntry />
        <TextInput style={styles.input} value={idp.refreshToken} onChangeText={(v: string) => setIdp({ ...idp, refreshToken: v })} placeholder="refreshToken" placeholderTextColor="#64748b" autoCapitalize="none" secureTextEntry />
        <Pressable style={styles.primary} onPress={() => void saveIdp()}>
          <Text style={styles.primaryText}>Save credentials</Text>
        </Pressable>
      </View>

      <Pressable style={styles.logout} onPress={onLogout}>
        <Text style={styles.logoutText}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b1220', padding: 16 },
  title: { color: '#f1f5f9', fontSize: 26, fontWeight: '800', marginBottom: 12 },
  card: { backgroundColor: '#16213a', borderRadius: 14, padding: 16, marginBottom: 12 },
  cardTitle: { color: '#38bdf8', fontWeight: '700', fontSize: 15, marginBottom: 8 },
  row: { color: '#e2e8f0', fontSize: 14, marginVertical: 3 },
  strong: { color: '#f1f5f9', fontWeight: '700' },
  mono: { color: '#94a3b8', fontFamily: 'monospace' },
  muted: { color: '#64748b', fontSize: 13, marginBottom: 6 },
  primary: { backgroundColor: '#38bdf8', borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 12 },
  primaryText: { color: '#0b1220', fontWeight: '700', fontSize: 14 },
  danger: { backgroundColor: '#3b1d1d', borderRadius: 10, paddingVertical: 10, alignItems: 'center', marginTop: 10 },
  dangerText: { color: '#fca5a5', fontWeight: '600', fontSize: 13 },
  logout: { backgroundColor: '#1e293b', borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  logoutText: { color: '#e2e8f0', fontWeight: '700' },
  input: { backgroundColor: '#0f1a30', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 11, color: '#e2e8f0', fontSize: 14, marginTop: 8 },
});
