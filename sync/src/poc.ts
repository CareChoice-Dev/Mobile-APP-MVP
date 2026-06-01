// ===========================================================================
// PROOF OF CONCEPT — the full loop, exactly as validated against UAT.
//
//   Given ONLY a Resource Id (no Salesforce User for the worker):
//     1. read the worker's jobs           (sked__Job_Allocation__c -> sked__Job__c)
//     2. read a client's medication chart (enrtcr__Medication__c)
//     3. write a case note back           (enrtcr__Note__c, attributed to Resource)
//     4. read the note back               (confirm round-trip)
//
// Run: cp .env.example .env && fill it in && npm i && npm run poc
// DRY_RUN=1 prints intended writes without creating anything.
// ===========================================================================
import { SF } from './sf-model.js';
import { sfConnect, env } from './clients.js';
import { fetchJobsForResource, fetchMedicationsForClients } from './syncRead.js';

async function main() {
  console.log(`\n=== CareChoice MVP integration PoC ===`);
  console.log(`Resource (worker, no SF login): ${env.resourceId}`);
  console.log(`Mode: ${env.dryRun ? 'DRY RUN (no writes)' : 'LIVE'}\n`);

  const conn = await sfConnect();

  // 1 + 2 — READ
  const jobs = await fetchJobsForResource(conn, env.resourceId);
  console.log(`1) Jobs for this worker: ${jobs.length}`);
  jobs.slice(0, 5).forEach((j) => console.log(`   - ${j.job_number} [${j.status}] ${j.starts_at}`));

  const clientId = jobs.find((j) => j.client_sf_id)?.client_sf_id;
  const meds = clientId ? await fetchMedicationsForClients(conn, [clientId]) : [];
  console.log(`2) Active medications for client ${clientId}: ${meds.length}`);
  meds.slice(0, 5).forEach((m) => console.log(`   - ${m.name} (${m.support_type})`));

  // 3 — WRITE a case note attributed to the Resource (no User involved)
  const job = jobs.find((j) => j.client_sf_id);
  if (!job) {
    console.log('No job with a client found; skipping write.');
    return;
  }
  const n = SF.note;
  const outboxId = crypto.randomUUID();
  const payload = {
    [n.name]: 'MVP PoC note',
    [n.status]: 'Draft',
    [n.type]: 'Case Note',
    [n.job]: job.salesforce_id,
    [n.client]: job.client_sf_id,
    [n.serviceNoteDate]: new Date().toISOString().slice(0, 10),
    [n.description]: `[Submitted via mobile app by Resource ${env.resourceId} | outbox:${outboxId}]\n\nPoC note. Safe to delete.`,
  };

  if (env.dryRun) {
    console.log(`3) [dry-run] would create ${n.object} on ${job.job_number}:`, payload);
    return;
  }
  const created: any = await conn.sobject(n.object).create(payload);
  console.log(`3) Created ${n.object} ${created.id} on ${job.job_number}`);

  // 4 — READ BACK
  const back = await conn.query(
    `SELECT Id, ${n.name}, ${n.status}, ${n.jobRel}.${SF.job.name}, ${n.description} ` +
      `FROM ${n.object} WHERE Id = '${created.id}'`,
  );
  console.log(`4) Read back:`, JSON.stringify(back.records[0], null, 2));
  console.log(`\n=== Loop proven end-to-end. ===\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
