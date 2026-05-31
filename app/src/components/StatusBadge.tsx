import { StyleSheet, Text, View } from 'react-native';

const COLORS: Record<string, { bg: string; fg: string }> = {
  pending: { bg: '#FEF3C7', fg: '#92400E' },
  syncing: { bg: '#DBEAFE', fg: '#1E40AF' },
  synced: { bg: '#D1FAE5', fg: '#065F46' },
  error: { bg: '#FEE2E2', fg: '#991B1B' },
};

const DEFAULT = { bg: '#E5E7EB', fg: '#374151' };

/**
 * Small pill for a status string. Used both for sync status of outbox rows
 * (pending/syncing/synced/error) and for free-text job/medication statuses.
 */
export function StatusBadge({ value }: { value: string | null | undefined }) {
  const label = value ?? 'unknown';
  const c = COLORS[label.toLowerCase()] ?? DEFAULT;
  return (
    <View style={[styles.badge, { backgroundColor: c.bg }]}>
      <Text style={[styles.text, { color: c.fg }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  text: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
});
