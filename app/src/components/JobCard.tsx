import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Job } from '@/lib/types';
import { StatusBadge } from './StatusBadge';

function formatWhen(iso: string | null): string {
  if (!iso) return 'No time set';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function JobCard({ job, onPress }: { job: Job; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={styles.headerRow}>
        <Text style={styles.jobNumber}>{job.job_number ?? 'Untitled job'}</Text>
        <StatusBadge value={job.status} />
      </View>
      {job.job_type ? <Text style={styles.type}>{job.job_type}</Text> : null}
      <Text style={styles.time}>{formatWhen(job.starts_at)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  pressed: {
    opacity: 0.6,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  jobNumber: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
  },
  type: {
    fontSize: 14,
    color: '#374151',
    marginBottom: 4,
  },
  time: {
    fontSize: 13,
    color: '#6B7280',
  },
});
