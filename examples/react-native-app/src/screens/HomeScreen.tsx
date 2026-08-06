import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { HomeState } from '@jataqi/mobile-app';
import { getController } from '../api';

/**
 * Home — one-call snapshot rendered as cards: device, personas, orgs,
 * conversations, shared/approval counts. Pull-to-refresh hits the server.
 */
export default function HomeScreen() {
  const [home, setHome] = useState<HomeState | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [outboxCount, setOutboxCount] = useState(0);

  const load = useCallback(async (refresh: boolean): Promise<void> => {
    const app = getController();
    const h = await app.loadHome(refresh);
    setHome(h);
    setOutboxCount(await app.pendingMessages().then((m) => m.length));
  }, []);

  useEffect(() => {
    void load(true).catch(() => setHome(null));
  }, [load]);

  const onRefresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await load(true);
    } finally {
      setRefreshing(false);
    }
  };

  if (!home) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#38bdf8" />
        <Text style={styles.muted}>Loading home…</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.root} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor="#38bdf8" />}>
      <Text style={styles.title}>Home</Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>📱 Device</Text>
        <Text style={styles.row}>{home.devices.length} registered device(s)</Text>
        <View style={styles.badges}>
          <View style={styles.badge}><Text style={styles.badgeText}>📥 shared: {home.sharedWithMeCount}</Text></View>
          <View style={styles.badge}><Text style={styles.badgeText}>⏳ approvals: {home.pendingApprovalCount}</Text></View>
          {outboxCount > 0 && <View style={[styles.badge, styles.badgeWarn]}><Text style={styles.badgeText}>✈️ outbox: {outboxCount}</Text></View>}
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>👤 Personas</Text>
        <View style={styles.chips}>
          {home.personas.map((p) => (
            <View key={p.id} style={styles.chip}><Text style={styles.chipText}>{p.name ?? p.id}</Text></View>
          ))}
        </View>
      </View>

      {home.myOrgs.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>🏢 Organizations</Text>
          {home.myOrgs.map((o) => (
            <Text key={o.id} style={styles.row}>• {o.name} {o.role ? `(${o.role})` : ''}</Text>
          ))}
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>💬 Recent conversations</Text>
        {home.recentConversations.length === 0 && <Text style={styles.muted}>No conversations yet — open the Chat tab.</Text>}
        <FlatList
          data={home.recentConversations}
          keyExtractor={(c: HomeState['recentConversations'][number]) => c.id}
          scrollEnabled={false}
          renderItem={({ item }: { item: HomeState['recentConversations'][number] }) => (
            <View style={styles.conv}>
              <Text style={styles.convTitle}>{item.pinned ? '📌 ' : ''}{item.title || '(untitled)'}</Text>
              <Text style={styles.convMeta}>{item.messageCount} messages{item.orgId ? ' · org' : ''}</Text>
            </View>
          )}
        />
      </View>

      <Pressable style={styles.secondary} onPress={() => void onRefresh()}>
        <Text style={styles.secondaryText}>↻ Refresh</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b1220', padding: 16 },
  center: { flex: 1, backgroundColor: '#0b1220', alignItems: 'center', justifyContent: 'center', gap: 12 },
  title: { color: '#f1f5f9', fontSize: 26, fontWeight: '800', marginBottom: 12 },
  muted: { color: '#64748b', fontSize: 13 },
  card: { backgroundColor: '#16213a', borderRadius: 14, padding: 16, marginBottom: 12 },
  cardTitle: { color: '#38bdf8', fontWeight: '700', fontSize: 15, marginBottom: 8 },
  row: { color: '#e2e8f0', fontSize: 14, marginVertical: 2 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  badge: { backgroundColor: '#0f1a30', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  badgeWarn: { backgroundColor: '#3b2f10' },
  badgeText: { color: '#94a3b8', fontSize: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { backgroundColor: '#0f1a30', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  chipText: { color: '#e2e8f0', fontSize: 13 },
  conv: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#1e2c4d' },
  convTitle: { color: '#f1f5f9', fontSize: 15, fontWeight: '600' },
  convMeta: { color: '#64748b', fontSize: 12, marginTop: 2 },
  secondary: { backgroundColor: '#1e293b', borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  secondaryText: { color: '#e2e8f0', fontWeight: '600' },
});
