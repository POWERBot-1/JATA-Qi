import { useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { buildController } from '../api';

interface Props {
  onAuthenticated: () => void;
}

/** Sign in / create account against the JATA Qi gateway. */
export default function LoginScreen({ onAuthenticated }: Props) {
  const [baseUrl, setBaseUrl] = useState('http://localhost:7400');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!username.trim() || !password) {
      Alert.alert('Missing fields', 'Enter a username and password.');
      return;
    }
    setBusy(true);
    try {
      const app = await buildController({ baseUrl: baseUrl.trim() });
      try {
        await app.login(username.trim(), password);
      } catch {
        if (mode !== 'register') throw new Error('Sign in failed — create an account instead.');
        await app.register(username.trim(), password, ['developer']);
      }
      await app.registerDevice(); // idempotent per push token
      onAuthenticated();
    } catch (err) {
      Alert.alert('Authentication failed', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Text style={styles.brand}>TANYA</Text>
      <Text style={styles.subtitle}>JATA Qi · Mobile Reference App</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Gateway URL</Text>
        <TextInput style={styles.input} value={baseUrl} onChangeText={setBaseUrl} autoCapitalize="none" autoCorrect={false} placeholder="http://localhost:7400" placeholderTextColor="#64748b" />

        <Text style={styles.label}>Username</Text>
        <TextInput style={styles.input} value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} placeholder="alice" placeholderTextColor="#64748b" />

        <Text style={styles.label}>Password</Text>
        <TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry placeholder="••••••••" placeholderTextColor="#64748b" />

        <Pressable style={[styles.primary, busy && styles.disabled]} onPress={() => void submit()} disabled={busy}>
          {busy ? <ActivityIndicator color="#0b1220" /> : <Text style={styles.primaryText}>{mode === 'signin' ? 'Sign in' : 'Create account'}</Text>}
        </Pressable>

        <Pressable style={styles.switch} onPress={() => setMode(mode === 'signin' ? 'register' : 'signin')}>
          <Text style={styles.switchText}>{mode === 'signin' ? 'No account? Create one' : 'Have an account? Sign in'}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b1220', justifyContent: 'center', padding: 24 },
  brand: { color: '#38bdf8', fontSize: 42, fontWeight: '800', textAlign: 'center' },
  subtitle: { color: '#94a3b8', textAlign: 'center', marginBottom: 32 },
  card: { backgroundColor: '#16213a', borderRadius: 16, padding: 20, gap: 8 },
  label: { color: '#94a3b8', fontSize: 12, fontWeight: '600', marginTop: 6 },
  input: { backgroundColor: '#0f1a30', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, color: '#e2e8f0', fontSize: 15 },
  primary: { backgroundColor: '#38bdf8', borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 16 },
  disabled: { opacity: 0.6 },
  primaryText: { color: '#0b1220', fontWeight: '700', fontSize: 16 },
  switch: { marginTop: 12, alignItems: 'center' },
  switchText: { color: '#38bdf8', fontSize: 14 },
});
