// WRITE TEST — proves the Salesforce Integration user can create case notes on the
// org-custom Case_Note_MVP__c object (which it can, unlike the managed enrtcr__Note__c).
// Upserts one record by the Mobile_Outbox_Id__c External Id (idempotent — safe to
// re-run; it updates rather than duplicates). Prints only record Ids, never PII.
//
// Prereq: Case_Note_MVP__c deployed to UAT + the integration user assigned the
// "Case Note MVP Access" permission set. Run sync:read first so a linkable job exists.
import { SF } from './sf-model.js';
import { sfConnect, supabaseAdmin, env } from './clients.js';

async function main() {
  const conn = await sfConnect();
  const db = supabaseAdmin();
  const n = SF.caseNoteMvp;

  // Link the test note to a real, already-synced job that has a client.
  const { data: jobs, error } = await db
    .from('jobs')
    .select('salesforce_id, client_sf_id, resource_id')
    .not('client_sf_id', 'is', null)
    .limit(1);
  if (error) throw error;
  if (!jobs?.length) throw new Error('No synced job with a client found — run `npm run sync:read` first.');
  const job = jobs[0] as any;

  const outboxId = process.env.TEST_OUTBOX_ID ?? 'writetest-0001'; // stable → idempotent
  const record: Record<string, unknown> = {
    [n.name]: `MVP write test — ${job.salesforce_id}`,
    [n.job]: job.salesforce_id,
    [n.client]: job.client_sf_id,
    [n.description]: `Write-back smoke test via ${n.object}. outbox:${outboxId}`,
    [n.status]: 'Completed',
    [n.type]: 'Case Note',
    [n.serviceNoteDate]: new Date().toISOString().slice(0, 10),
    [n.submittedByResource]: job.resource_id,
    [n.outboxId]: outboxId,
  };

  if (env.dryRun) {
    console.log(`[dry-run] would upsert ${n.object} by ${n.outboxId}=${outboxId} (job ${job.salesforce_id})`);
    return;
  }

  const res: any = await conn.sobject(n.object).upsert(record, n.outboxId);
  console.log(`upsert ok: created=${res?.created} id=${res?.id ?? res?.Id}`);

  const check = await conn.query(
    `SELECT Id, ${n.job}, ${n.client}, ${n.status} FROM ${n.object} WHERE ${n.outboxId} = '${outboxId}' LIMIT 1`,
  );
  const r: any = check.records[0];
  console.log(`verify: id=${r?.Id} jobLinked=${!!r?.[n.job]} clientLinked=${!!r?.[n.client]} status=${r?.[n.status]}`);
}

main().catch((e) => {
  console.error('WRITE TEST FAILED:', e?.errorCode ?? '', e?.message ?? e);
  process.exit(1);
});
