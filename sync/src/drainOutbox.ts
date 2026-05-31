// WRITE PATH: drain the job_notes outbox and create enrtcr__Note__c records in
// Salesforce as the integration user. Append-only + idempotent (check-before-
// create on the body stamp, since the current org has no External Id field;
// the new org should add Mobile_Outbox_Id__c (External Id) for a clean upsert).
import type jsforce from 'jsforce';
import { SF } from './sf-model.js';
import { sfConnect, supabaseAdmin, env } from './clients.js';

const STAMP = (outboxId: string, resourceId: string) =>
  `[Submitted via mobile app by Resource ${resourceId} | outbox:${outboxId}]`;

export async function drainNotes() {
  const db = supabaseAdmin();
  const conn = await sfConnect();

  // 1. Claim a batch of pending notes (join to job for the SF job id + resource).
  const { data: notes, error } = await db
    .from('job_notes')
    .select('id, body, note_type, job_id, jobs!inner(salesforce_id, client_sf_id, resource_id)')
    .eq('status', 'pending')
    .limit(50);
  if (error) throw error;
  if (!notes?.length) {
    console.log('No pending notes.');
    return;
  }

  for (const note of notes as any[]) {
    const job = note.jobs;
    const stamp = STAMP(note.id, job.resource_id);
    const n = SF.note;
    const payload = {
      [n.name]: `Mobile note — ${job.salesforce_id}`,
      [n.status]: 'Completed',
      [n.type]: note.note_type ?? 'Case Note',
      [n.job]: job.salesforce_id,
      [n.client]: job.client_sf_id,
      [n.serviceNoteDate]: new Date().toISOString().slice(0, 10),
      [n.description]: `${stamp}\n\n${note.body}`,
    };

    if (env.dryRun) {
      console.log(`[dry-run] would create ${n.object}:`, payload);
      continue;
    }

    await db.from('job_notes').update({ status: 'syncing', attempts: (note.attempts ?? 0) + 1 }).eq('id', note.id);
    try {
      // Idempotency: skip if a note with this outbox stamp already exists.
      const existing = await conn.query(
        `SELECT Id FROM ${n.object} WHERE ${n.description} LIKE '%outbox:${note.id}%' LIMIT 1`,
      );
      const sfId = existing.totalSize > 0
        ? (existing.records[0] as any).Id
        : ((await conn.sobject(n.object).create(payload)) as any).id;

      await db.from('job_notes')
        .update({ status: 'synced', salesforce_note_id: sfId, synced_at: new Date().toISOString() })
        .eq('id', note.id);
      console.log(`Note ${note.id} -> ${n.object} ${sfId}`);
    } catch (e: any) {
      await db.from('job_notes').update({ status: 'error', last_error: String(e?.message ?? e) }).eq('id', note.id);
      console.error(`Note ${note.id} failed:`, e?.message ?? e);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  drainNotes().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
