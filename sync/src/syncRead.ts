// READ PATH: pull a worker's jobs + their clients' medication charts from
// Salesforce (as the integration user) and upsert into Supabase.
// Uses the exact SOQL proven against UAT in docs/architecture.md §11.
import { pathToFileURL } from 'node:url';
import type jsforce from 'jsforce';
import { SF } from './sf-model.js';
import { sfConnect, supabaseAdmin, env } from './clients.js';

export async function fetchJobsForResource(conn: jsforce.Connection, resourceId: string) {
  const a = SF.jobAllocation;
  const j = SF.job;
  const soql =
    `SELECT ${a.job}, ${a.jobRel}.${j.name}, ${a.jobRel}.${j.status}, ` +
    `${a.jobRel}.${j.type}, ${a.jobRel}.${j.start}, ${a.jobRel}.${j.finish}, ` +
    `${a.jobRel}.${j.contact}, ${a.status} ` +
    `FROM ${a.object} ` +
    `WHERE ${a.resource} = '${resourceId}' AND ${a.status} != 'Deleted' ` +
    `AND ${a.jobRel}.${j.contact} != null ` +
    `ORDER BY ${a.jobRel}.${j.start} DESC LIMIT 200`;
  const res = await conn.query(soql);
  return res.records.map((r: any) => ({
    salesforce_id: r[a.job],
    job_number: r[a.jobRel]?.[j.name],
    status: r[a.jobRel]?.[j.status],
    job_type: r[a.jobRel]?.[j.type],
    starts_at: r[a.jobRel]?.[j.start],
    ends_at: r[a.jobRel]?.[j.finish],
    client_sf_id: r[a.jobRel]?.[j.contact],
    resource_id: resourceId,
    allocation_status: r[a.status],
    synced_at: new Date().toISOString(),
  }));
}

export async function fetchMedicationsForClients(conn: jsforce.Connection, clientIds: string[]) {
  if (clientIds.length === 0) return [];
  const m = SF.medication;
  const ids = clientIds.map((id) => `'${id}'`).join(',');
  const soql =
    `SELECT Id, ${m.client}, ${m.name}, ${m.dosage}, ${m.route}, ${m.support}, ` +
    `${m.status}, ${m.startDate}, ${m.endDate}, ${m.instructions} ` +
    `FROM ${m.object} WHERE ${m.client} IN (${ids}) AND ${m.status} = 'Active' LIMIT 500`;
  const res = await conn.query(soql);
  return res.records.map((r: any) => ({
    salesforce_id: r.Id,
    client_sf_id: r[m.client],
    name: r[m.name],
    dosage: r[m.dosage],
    route: r[m.route],
    support_type: r[m.support],
    status: r[m.status],
    start_date: r[m.startDate],
    end_date: r[m.endDate],
    instructions: r[m.instructions],
    synced_at: new Date().toISOString(),
  }));
}

export async function syncRead(resourceId = env.resourceId) {
  const conn = await sfConnect();
  const jobs = await fetchJobsForResource(conn, resourceId);
  const clientIds = [...new Set(jobs.map((j) => j.client_sf_id).filter(Boolean))] as string[];
  const meds = await fetchMedicationsForClients(conn, clientIds);

  if (env.dryRun) {
    console.log(`[dry-run] would upsert ${jobs.length} jobs, ${meds.length} medications`);
    return { jobs, meds };
  }
  const db = supabaseAdmin();
  await db.from('jobs').upsert(jobs, { onConflict: 'salesforce_id' });
  await db.from('medications').upsert(meds, { onConflict: 'salesforce_id' });
  console.log(`Synced ${jobs.length} jobs, ${meds.length} medications for ${resourceId}`);
  return { jobs, meds };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  syncRead().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
