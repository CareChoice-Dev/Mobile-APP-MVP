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
  const db = supabaseAdmin();
  const conn = await sfConnect();

  // 1. Claim a batch of pending administrations + the SF ids they need.
  const { data: rows, error } = await db
    .from('medication_administrations')
    .select(
      'id, outcome, routine, dose_given, administered_at, comments, witness, attempts, job_id, administered_by, ' +
        'medications!inner(salesforce_id, client_sf_id), jobs(salesforce_id, resource_id)',
    )
    .eq('status', 'pending')
    .limit(50);
  if (error) throw error;
  if (!rows?.length) {
    console.log('No pending administrations.');
    return;
  }

  // 2. Resolve the Resource id: prefer the linked job's resource_id; otherwise the
  //    author's profile (administered_by -> profiles.salesforce_resource_id). The FK
  //    points at auth.users, so the profile lookup is a separate batched query.
  const needProfile = (rows as any[]).filter((r) => !r.jobs?.resource_id).map((r) => r.administered_by);
  const profileResource = new Map<string, string>();
  if (needProfile.length) {
    const { data: profs, error: pe } = await db
      .from('profiles')
      .select('id, salesforce_resource_id')
      .in('id', [...new Set(needProfile)]);
    if (pe) throw pe;
    for (const p of (profs ?? []) as any[]) profileResource.set(p.id, p.salesforce_resource_id);
  }

  for (const r of rows as any[]) {
    const med = r.medications;
    const payload = buildMedAdminPayload({
      id: r.id,
      outcome: r.outcome,
      routine: r.routine,
      dose_given: r.dose_given,
      administered_at: r.administered_at,
      comments: r.comments,
      witness: r.witness,
      medication_sf_id: med.salesforce_id,
      client_sf_id: med.client_sf_id ?? null,
      job_sf_id: r.jobs?.salesforce_id ?? null,
      resource_id: r.jobs?.resource_id ?? profileResource.get(r.administered_by) ?? null,
    });

    if (env.dryRun) {
      console.log(`[dry-run] would upsert ${n.object} by ${n.outboxId}=${r.id}:`, payload);
      continue;
    }

    await db.from('medication_administrations').update({ status: 'syncing', attempts: (r.attempts ?? 0) + 1 }).eq('id', r.id);
    try {
      // Idempotent External-Id upsert on Mobile_Outbox_Id__c: insert if new, update if
      // already drained — no duplicate administrations.
      const res: any = await conn.sobject(n.object).upsert(payload, n.outboxId);
      const sfId = res?.id ?? res?.Id;
      await db.from('medication_administrations')
        .update({ status: 'synced', salesforce_id: sfId, synced_at: new Date().toISOString() })
        .eq('id', r.id);
      console.log(`Admin ${r.id} -> ${n.object} ${sfId} (created=${res?.created})`);
    } catch (e: any) {
      await db.from('medication_administrations').update({ status: 'error', last_error: String(e?.message ?? e) }).eq('id', r.id);
      console.error(`Admin ${r.id} failed:`, e?.message ?? e);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  drainMedAdmins().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
