import { useState } from 'react';
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
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import type { JobNote, NewJobNote } from '@/lib/types';
import { StatusBadge } from '@/components/StatusBadge';

const NOTE_TYPES = ['Case Note', 'Incident', 'Observation', 'Handover'];

export default function AddNoteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [body, setBody] = useState('');
  const [noteType, setNoteType] = useState<string>(NOTE_TYPES[0]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Optimistic record returned from the insert; status starts 'pending'.
  const [saved, setSaved] = useState<JobNote | null>(null);

  async function onSubmit() {
    if (!id || body.trim().length === 0) return;
    setError(null);
    setSubmitting(true);

    // INSERT-only outbox row. author_id + status default server-side, but we
    // omit them here so RLS defaults (auth.uid(), 'pending') apply.
    const payload: NewJobNote = {
      job_id: id,
      body: body.trim(),
      note_type: noteType,
    };

    const { data, error } = await supabase
      .from('job_notes')
      .insert(payload)
      .select()
      .single();

    setSubmitting(false);

    if (error) {
      setError(error.message);
      return;
    }
    setSaved(data as JobNote);
  }

  // Confirmation state: the note is queued for sync to Salesforce.
  if (saved) {
    return (
      <View style={styles.confirm}>
        <Text style={styles.confirmTitle}>Note saved</Text>
        <View style={styles.statusRow}>
          <Text style={styles.confirmText}>Sync status:</Text>
          <StatusBadge value={saved.status} />
        </View>
        <Text style={styles.confirmHint}>
          Your note is queued and will sync to Salesforce automatically.
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
        <Text style={styles.label}>Note type</Text>
        <View style={styles.chips}>
          {NOTE_TYPES.map((t) => {
            const active = t === noteType;
            return (
              <TouchableOpacity
                key={t}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => setNoteType(t)}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>
                  {t}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={styles.label}>Note</Text>
        <TextInput
          style={styles.textarea}
          value={body}
          onChangeText={setBody}
          multiline
          numberOfLines={6}
          placeholder="Write your note…"
          placeholderTextColor="#9CA3AF"
          textAlignVertical="top"
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[
            styles.primaryBtn,
            (body.trim().length === 0 || submitting) && styles.btnDisabled,
          ]}
          onPress={onSubmit}
          disabled={body.trim().length === 0 || submitting}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryBtnText}>Save note</Text>
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
  label: {
    fontSize: 13,
    color: '#374151',
    marginBottom: 8,
    marginTop: 12,
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
  chipText: { fontSize: 13, color: '#374151' },
  chipTextActive: { color: '#fff', fontWeight: '600' },
  textarea: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
    color: '#111827',
    minHeight: 140,
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
