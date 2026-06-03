// WRITE PATH: drain the medication_administrations outbox into Med_Admin_MVP__c
// (org-custom) as the integration user. Idempotent via an External-Id upsert on
// Mobile_Outbox_Id__c (the Supabase row UUID). Targets the org-custom object because
// the Salesforce Integration license cannot create the managed
// enrtcr__Medication_Administered__c (see salesforce/README.md).
import { pathToFileURL } from 'node:url';
import { SF, REASON_BY_OUTCOME } from './sf-model.js';
import { sfConnect, supabaseAdmin, env } from './clients.js';

const n = SF.medAdminMvp;

export interface MedAdminRow {
  id: string;
  outcome: string;
  routine: string | null;
  dose_given: string | null;
  administered_at: string;
  comments: string | null;
  witness: string | null;
  medication_sf_id: string;
  client_sf_id: string | null;
  job_sf_id: string | null;
  resource_id: string | null;
}

// Pure: build the Med_Admin_MVP__c upsert payload from a resolved outbox row.
// Optional fields are left `undefined` so jsforce omits them from the request.
export function buildMedAdminPayload(row: MedAdminRow): Record<string, unknown> {
  const given = row.outcome === 'given';
  return {
    [n.name]: `Med admin — ${row.medication_sf_id}`,
    [n.medication]: row.medication_sf_id,
    [n.client]: row.client_sf_id ?? undefined,
    [n.job]: row.job_sf_id ?? undefined,
    [n.administered]: given,
    [n.reasonNotAdministered]: given ? null : (REASON_BY_OUTCOME[row.outcome] ?? null),
    [n.administeredAt]: row.administered_at,
    [n.routine]: row.routine ?? undefined,
    [n.doseGiven]: row.dose_given ?? undefined,
    [n.comments]: row.comments ?? undefined,
    [n.witness]: row.witness ?? undefined,
    [n.submittedByResource]: row.resource_id ?? undefined,
    [n.outboxId]: row.id,
  };
}

export async function drainMedAdmins(): Promise<void> {
  throw new Error('not implemented yet');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  drainMedAdmins().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
