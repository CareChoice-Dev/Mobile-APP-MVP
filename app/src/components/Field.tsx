import { type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

/** Labelled read-only key/value row used on detail screens. */
export function Field({
  label,
  value,
  children,
}: {
  label: string;
  value?: string | null;
  children?: ReactNode;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      {children ?? <Text style={styles.value}>{value ?? '—'}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingVertical: 6,
  },
  label: {
    fontSize: 12,
    color: '#6B7280',
    marginBottom: 2,
  },
  value: {
    fontSize: 15,
    color: '#111827',
  },
});
