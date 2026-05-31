/**
 * TypeScript mirrors of the Supabase tables in /supabase/schema.sql.
 * Only the columns the app reads/writes are modelled. The app talks ONLY to
 * Supabase — never to Salesforce.
 */

export type SyncStatus = 'pending' | 'syncing' | 'synced' | 'error';

/** mirror of public.jobs (sked__Job__c working set) */
export interface Job {
  id: string;
  salesforce_id: string;
  job_number: string | null;
  status: string | null;
  job_type: string | null;
  starts_at: string | null;
  ends_at: string | null;
  resource_id: string;
  allocation_status: string | null;
  client_sf_id: string | null;
  salesforce_modified_at: string | null;
  synced_at: string;
}

/** mirror of public.medications (enrtcr__Medication__c — the client's chart) */
export interface Medication {
  id: string;
  salesforce_id: string;
  client_sf_id: string;
  name: string | null;
  dosage: string | null;
  route: string | null;
  support_type: string | null;
  status: string | null;
  start_date: string | null;
  end_date: string | null;
  instructions: string | null;
  salesforce_modified_at: string | null;
  synced_at: string;
}

/** write-back outbox row → enrtcr__Note__c */
export interface JobNote {
  id: string;
  job_id: string;
  author_id: string;
  body: string;
  note_type: string;
  status: SyncStatus;
  salesforce_note_id: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  synced_at: string | null;
}

/** Payload the app inserts into job_notes. status/author_id come from defaults. */
export interface NewJobNote {
  job_id: string;
  body: string;
  note_type: string;
}

export type AdministrationOutcome =
  | 'given'
  | 'refused'
  | 'withheld'
  | 'not_available'
  | 'absent'
  | 'fasting'
  | 'vomiting'
  | 'on_leave'
  | 'missed';

export type AdministrationRoutine = 'Breakfast' | 'Lunch' | 'Dinner' | 'Bed';

/** write-back outbox row → enrtcr__Medication_Administered__c */
export interface MedicationAdministration {
  id: string;
  medication_id: string;
  job_id: string | null;
  administered_by: string;
  outcome: AdministrationOutcome;
  routine: AdministrationRoutine | null;
  dose_given: string | null;
  administered_at: string;
  comments: string | null;
  witness: string | null;
  status: SyncStatus;
  salesforce_id: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  synced_at: string | null;
}

/** Payload the app inserts. status/administered_by come from defaults. */
export interface NewMedicationAdministration {
  medication_id: string;
  job_id: string | null;
  outcome: AdministrationOutcome;
  routine: AdministrationRoutine | null;
  dose_given?: string | null;
  administered_at: string;
  comments?: string | null;
}
