import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import type {
  AdministrationOutcome,
  AdministrationRoutine,
  Medication,
  MedicationAdministration,
  NewMedicationAdministration,
} from '@/lib/types';
import { Field } from '@/components/Field';
import { StatusBadge } from '@/components/StatusBadge';

const OUTCOMES: AdministrationOutcome[] = [
  'given',
  'refused',
  'withheld',
  'not_available',
  'absent',
  'fasting',
  'vomiting',
  'on_leave',
  'missed',
];

const ROUTINES: AdministrationRoutine[] = ['Breakfast', 'Lunch', 'Dinner', 'Bed'];

export default function RecordMedicationScreen() {
  const { id, medId } = useLocalSearchParams<{ id: string; medId: string }>();
  const router = useRouter();

  const [medication, setMedication] = useState<Medication | null>(null);
  const [loadingMed, setLoadingMed] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [outcome, setOutcome] = useState<AdministrationOutcome>('given');
  const [routine, setRoutine] = useState<AdministrationRoutine | null>(null);
  const [doseGiven, setDoseGiven] = useState('');
  const [comments, setComments] = useState('');
  // Captured on device at the moment the screen opens; editable text is overkill
  // for the MVP, so we record "now" at submit time.
  const [administeredAt] = useState(() => new Date());

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<MedicationAdministration | null>(null);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      setLoadingMed(true);
      (async () => {
        if (!medId) return;
        const { data, error } = await supabase
          .from('medications')
          .select('*')
          .eq('id', medId)
          .maybeSingle();
        if (!active) return;
        if (error) setLoadError(error.message);
        else if (!data) setLoadError('Medication not found.');
        else setMedication(data as Medication);
      })().finally(() => {
        if (active) setLoadingMed(false);
      });
      return () => {
        active = false;
      };
    }, [medId]),
  );

  async function onSubmit() {
    if (!medId) return;
    setError(null);
    setSubmitting(true);

    // INSERT-only outbox row. administered_by + status default server-side.
    const payload: NewMedicationAdministration = {
      medication_id: medId,
      job_id: id ?? null,
      outcome,
      routine,
      dose_given: doseGiven.trim() || null,
      administered_at: new Date().toISOString(),
      comments: comments.trim() || null,
    };

    const { data, error } = await supabase
      .from('medication_administrations')
      .insert(payload)
      .select()
      .single();

    setSubmitting(false);

    if (error) {
      setError(error.message);
      return;
    }
    setSaved(data as MedicationAdministration);
  }

  if (loadingMed) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#0E5A8A" />
      </View>
    );
  }

  if (loadError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>Could not load medication.</Text>
        <Text style={styles.errorDetail}>{loadError}</Text>
      </View>
    );
  }

  if (saved) {
    return (
      <View style={styles.confirm}>
        <Text style={styles.confirmTitle}>Administration recorded</Text>
        <View style={styles.statusRow}>
          <Text style={styles.confirmText}>Sync status:</Text>
          <StatusBadge value={saved.status} />
        </View>
        <Text style={styles.confirmHint}>
          This record is queued and will sync to Salesforce automatically.
        </Text>
        <TouchableOpacity style={styles.primaryBtn} onPress={() => router.back()}>
          <Text style={styles.primaryBtnText}>Back to job</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <View style={styles.section}>
          <Text style={styles.medName}>{medication?.name ?? 'Medication'}</Text>
          <Field label="Dosage" value={medication?.dosage} />
          <Field label="Route" value={medication?.route} />
          {medication?.instructions ? (
            <Field label="Instructions" value={medication.instructions} />
          ) : null}
        </View>

        <Text style={styles.label}>Outcome</Text>
        <View style={styles.chips}>
          {OUTCOMES.map((o) => {
            const active = o === outcome;
            return (
              <TouchableOpacity
                key={o}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => setOutcome(o)}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>
                  {o.replace(/_/g, ' ')}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={styles.label}>Routine</Text>
        <View style={styles.chips}>
          {ROUTINES.map((r) => {
            const active = r === routine;
            return (
              <TouchableOpacity
                key={r}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => setRoutine(active ? null : r)}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>
                  {r}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={styles.label}>Dose given</Text>
        <TextInput
          style={styles.input}
          value={doseGiven}
          onChangeText={setDoseGiven}
          placeholder="e.g. 1 tablet"
          placeholderTextColor="#9CA3AF"
        />

        <Text style={styles.label}>Administered at</Text>
        <Text style={styles.timestamp}>
          {administeredAt.toLocaleString(undefined, {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          })}{' '}
          (recorded at submit)
        </Text>

        <Text style={styles.label}>Comments</Text>
        <TextInput
          style={styles.textarea}
          value={comments}
          onChangeText={setComments}
          multiline
          numberOfLines={4}
          placeholder="Optional notes…"
          placeholderTextColor="#9CA3AF"
          textAlignVertical="top"
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.primaryBtn, submitting && styles.btnDisabled]}
          onPress={onSubmit}
          disabled={submitting}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryBtnText}>Record administration</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
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
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  medName: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 8,
  },
  label: {
    fontSize: 13,
    color: '#374151',
    marginBottom: 8,
    marginTop: 16,
    fontWeight: '600',
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
    backgroundColor: '#fff',
  },
  chipActive: { backgroundColor: '#0E5A8A', borderColor: '#0E5A8A' },
  chipText: { fontSize: 13, color: '#374151', textTransform: 'capitalize' },
  chipTextActive: { color: '#fff', fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#111827',
    backgroundColor: '#fff',
  },
  timestamp: { fontSize: 14, color: '#111827' },
  textarea: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
    color: '#111827',
    minHeight: 100,
    backgroundColor: '#fff',
  },
  error: { color: '#991B1B', marginTop: 12, fontSize: 13 },
  primaryBtn: {
    backgroundColor: '#0E5A8A',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 24,
  },
  btnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  errorText: { color: '#991B1B', fontSize: 16, fontWeight: '600' },
  errorDetail: {
    color: '#6B7280',
    fontSize: 13,
    marginTop: 6,
    textAlign: 'center',
  },
  confirm: {
    flex: 1,
    backgroundColor: '#F3F4F6',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  confirmTitle: { fontSize: 22, fontWeight: '700', color: '#065F46' },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 16,
  },
  confirmText: { fontSize: 15, color: '#374151' },
  confirmHint: {
    fontSize: 13,
    color: '#6B7280',
    textAlign: 'center',
    marginTop: 12,
  },
});
