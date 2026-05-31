import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import type { Job, Medication } from '@/lib/types';
import { Field } from '@/components/Field';
import { StatusBadge } from '@/components/StatusBadge';

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
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

export default function JobDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [job, setJob] = useState<Job | null>(null);
  const [medications, setMedications] = useState<Medication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);

    // Fetch the job (RLS already scopes to the worker's resource).
    const { data: jobData, error: jobErr } = await supabase
      .from('jobs')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (jobErr) {
      setError(jobErr.message);
      return;
    }
    if (!jobData) {
      setError('Job not found.');
      return;
    }
    const j = jobData as Job;
    setJob(j);

    // Medications for this job's client. RLS allows reading meds for clients
    // the worker has a job with.
    if (j.client_sf_id) {
      const { data: medData, error: medErr } = await supabase
        .from('medications')
        .select('*')
        .eq('client_sf_id', j.client_sf_id)
        .order('name', { ascending: true });
      if (medErr) {
        setError(medErr.message);
        return;
      }
      setMedications(medData as Medication[]);
    } else {
      setMedications([]);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      setLoading(true);
      load().finally(() => {
        if (active) setLoading(false);
      });
      return () => {
        active = false;
      };
    }, [load]),
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#0E5A8A" />
      </View>
    );
  }

  if (error || !job) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>Could not load job.</Text>
        {error ? <Text style={styles.errorDetail}>{error}</Text> : null}
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.section}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>{job.job_number ?? 'Job'}</Text>
          <StatusBadge value={job.status} />
        </View>
        <Field label="Type" value={job.job_type} />
        <Field label="Starts" value={formatWhen(job.starts_at)} />
        <Field label="Ends" value={formatWhen(job.ends_at)} />
        <Field label="Allocation status" value={job.allocation_status} />
        <Field label="Client" value={job.client_sf_id} />
      </View>

      <TouchableOpacity
        style={styles.primaryBtn}
        onPress={() => router.push(`/job/${job.id}/note`)}
      >
        <Text style={styles.primaryBtnText}>Add note</Text>
      </TouchableOpacity>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Medications</Text>
        {medications.length === 0 ? (
          <Text style={styles.empty}>
            {job.client_sf_id
              ? 'No medications on file for this client.'
              : 'This job has no linked client.'}
          </Text>
        ) : (
          medications.map((med) => (
            <TouchableOpacity
              key={med.id}
              style={styles.medCard}
              onPress={() =>
                router.push(`/job/${job.id}/medication/${med.id}`)
              }
            >
              <View style={styles.headerRow}>
                <Text style={styles.medName}>{med.name ?? 'Medication'}</Text>
                <StatusBadge value={med.status} />
              </View>
              {med.dosage ? (
                <Text style={styles.medMeta}>Dosage: {med.dosage}</Text>
              ) : null}
              {med.route ? (
                <Text style={styles.medMeta}>Route: {med.route}</Text>
              ) : null}
              {med.support_type ? (
                <Text style={styles.medMeta}>Support: {med.support_type}</Text>
              ) : null}
              {med.instructions ? (
                <Text style={styles.medInstructions}>{med.instructions}</Text>
              ) : null}
              <Text style={styles.recordHint}>Tap to record administration →</Text>
            </TouchableOpacity>
          ))
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F3F4F6' },
  content: { padding: 16 },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#F3F4F6',
  },
  section: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  title: { fontSize: 20, fontWeight: '700', color: '#111827' },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 12,
  },
  empty: { color: '#6B7280', fontSize: 14 },
  primaryBtn: {
    backgroundColor: '#0E5A8A',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 16,
  },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  medCard: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  medName: { fontSize: 15, fontWeight: '700', color: '#111827' },
  medMeta: { fontSize: 13, color: '#374151', marginTop: 2 },
  medInstructions: { fontSize: 13, color: '#6B7280', marginTop: 6 },
  recordHint: { fontSize: 12, color: '#0E5A8A', marginTop: 8, fontWeight: '600' },
  errorText: { color: '#991B1B', fontSize: 16, fontWeight: '600' },
  errorDetail: {
    color: '#6B7280',
    fontSize: 13,
    marginTop: 6,
    textAlign: 'center',
  },
});
