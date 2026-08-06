import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { getController } from '../api';

interface Conversation {
  id: string;
  title: string;
  updatedAt: number;
  pinned: boolean;
  messageCount: number;
  persona?: string;
}

interface Persona {
  id: string;
  name: string;
  description: string;
}

/**
 * Chat — persona picker, conversation list, and the streaming bubble.
 * Online turns stream word-by-word over /ws (tanya.chunk); when the socket or
 * server is unreachable the message is queued to the offline outbox and
 * flushed with the sync button (or on the next app start).
 */
export default function ChatScreen() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [personaId, setPersonaId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState('');
  const [busy, setBusy] = useState(false);
  const [outboxCount, setOutboxCount] = useState(0);
  const inputRef = useRef<TextInput>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const app = getController();
    const [p, c, outbox] = await Promise.all([
      app.client.tanya.personas(),
      app.listConversations(),
      app.pendingMessages(),
    ]);
    setPersonas(p.personas);
    if (p.personas.length > 0 && personaId === null) setPersonaId(p.personas[0].id);
    setConversations(c.conversations);
    setOutboxCount(outbox.length);
  }, [personaId]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const send = async (): Promise<void> => {
    const message = input.trim();
    if (!message || busy) return;
    setInput('');
    setBusy(true);
    const app = getController();
    const opts = { personaId: personaId ?? undefined, conversationId: activeId ?? undefined };
    try {
      const r = await app.streamMessage(message, {
        ...opts,
        onChunk: (chunk) => setStreaming((prev) => prev + chunk),
      });
      setStreaming('');
      setActiveId(r.conversationId);
      await refresh();
    } catch {
      // Offline path: queue locally; flush later via sync (or next launch).
      await app.enqueueMessage(message, { persona: personaId ?? undefined, conversationId: activeId ?? undefined });
      setStreaming('');
      setOutboxCount(await app.pendingMessages().then((m) => m.length));
      Alert.alert('Offline', 'Message queued in the outbox — it will sync when the server is reachable.');
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const syncOutbox = async (): Promise<void> => {
    try {
      const s = await getController().syncOutbox();
      Alert.alert('Outbox synced', `${s.sent} message(s) delivered, ${s.remaining} remaining.`);
      setOutboxCount(s.remaining);
      await refresh();
    } catch (err) {
      Alert.alert('Sync failed', err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <Text style={styles.title}>Chat</Text>
        <Pressable style={styles.sync} onPress={() => void syncOutbox()}>
          <Text style={styles.syncText}>✈️ {outboxCount > 0 ? `Sync ${outboxCount}` : 'Sync'}</Text>
        </Pressable>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.personaBar} contentContainerStyle={styles.personaRow}>
        {personas.map((p) => (
          <Pressable
            key={p.id}
            style={[styles.chip, personaId === p.id && styles.chipActive]}
            onPress={() => setPersonaId(p.id)}
          >
            <Text style={[styles.chipText, personaId === p.id && styles.chipTextActive]}>{p.name ?? p.id}</Text>
          </Pressable>
        ))}
      </ScrollView>

        <FlatList
          style={styles.convList}
          data={conversations}
          keyExtractor={(c: Conversation) => c.id}
          renderItem={({ item }: { item: Conversation }) => (
            <Pressable style={[styles.conv, activeId === item.id && styles.convActive]} onPress={() => setActiveId(item.id)}>
              <Text style={styles.convTitle} numberOfLines={1}>{item.pinned ? '📌 ' : ''}{item.title || '(untitled)'}</Text>
              <Text style={styles.convMeta}>{item.messageCount} messages</Text>
            </Pressable>
          )}
        />

      <View style={styles.bubble}>
        {streaming.length > 0 && (
          <View style={styles.streamCard}>
            <Text style={styles.streamLabel}>TANYA is replying…</Text>
            <Text style={styles.streamText}>{streaming}</Text>
          </View>
        )}
      </View>

      <View style={styles.composer}>
        <TextInput
          ref={inputRef}
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={busy ? 'TANYA is typing…' : 'Message TANYA'}
          placeholderTextColor="#64748b"
          multiline
          onSubmitEditing={() => void send()}
        />
        <Pressable style={[styles.send, (busy || !input.trim()) && styles.sendDisabled]} onPress={() => void send()}>
          <Text style={styles.sendText}>➤</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b1220' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 },
  title: { color: '#f1f5f9', fontSize: 26, fontWeight: '800' },
  sync: { backgroundColor: '#1e293b', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  syncText: { color: '#e2e8f0', fontSize: 13, fontWeight: '600' },
  personaBar: { maxHeight: 44 },
  personaRow: { paddingHorizontal: 16, gap: 8 },
  chip: { backgroundColor: '#16213a', borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7 },
  chipActive: { backgroundColor: '#38bdf8' },
  chipText: { color: '#94a3b8', fontSize: 13 },
  chipTextActive: { color: '#0b1220', fontWeight: '700' },
  convList: { flex: 1, paddingHorizontal: 16, marginTop: 8 },
  conv: { backgroundColor: '#16213a', borderRadius: 12, padding: 12, marginBottom: 8 },
  convActive: { borderWidth: 1, borderColor: '#38bdf8' },
  convTitle: { color: '#f1f5f9', fontSize: 15, fontWeight: '600' },
  convMeta: { color: '#64748b', fontSize: 12, marginTop: 2 },
  bubble: { paddingHorizontal: 16, paddingBottom: 8 },
  streamCard: { backgroundColor: '#0f2a3d', borderRadius: 12, padding: 12, borderLeftWidth: 3, borderLeftColor: '#38bdf8' },
  streamLabel: { color: '#38bdf8', fontSize: 11, fontWeight: '700', marginBottom: 4 },
  streamText: { color: '#e2e8f0', fontSize: 14, lineHeight: 20 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', padding: 12, gap: 8 },
  input: { flex: 1, backgroundColor: '#16213a', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: '#e2e8f0', fontSize: 15, maxHeight: 110 },
  send: { backgroundColor: '#38bdf8', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12 },
  sendDisabled: { opacity: 0.4 },
  sendText: { color: '#0b1220', fontSize: 16, fontWeight: '800' },
});
