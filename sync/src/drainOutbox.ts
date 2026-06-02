// WRITE PATH: drain the job_notes outbox into Case_Note_MVP__c (org-custom) in
// Salesforce as the integration user. Idempotent via an External-Id upsert on
// Mobile_Outbox_Id__c (the Supabase note id) — insert if new, update if already
// drained. Targets the org-custom object because the Salesforce Integration
// license cannot create the managed enrtcr__Note__c (see salesforce/README.md).
import { pathToFileURL } from 'node:url';
import type jsforce from 'jsforce';
import { SF } from './sf-model.js';
import { sfConnect, supabaseAdmin, env } from './clients.js';

export async function drainNotes() {
  const db = supabaseAdmin();
  const conn = await sfConnect();
  const n = SF.caseNoteMvp;

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
    const payload = {
      [n.name]: `Mobile note — ${job.salesforce_id}`,
      [n.status]: 'Completed',
      [n.type]: note.note_type ?? 'Case Note',
      [n.job]: job.salesforce_id,
      [n.client]: job.client_sf_id,
      [n.serviceNoteDate]: new Date().toISOString().slice(0, 10),
      [n.description]: note.body,
      [n.submittedByResource]: job.resource_id,
      [n.outboxId]: note.id, // Supabase note id → External Id (stable; idempotent upsert key)
    };

    if (env.dryRun) {
      console.log(`[dry-run] would upsert ${n.object} by ${n.outboxId}=${note.id}:`, payload);
      continue;
    }

    await db.from('job_notes').update({ status: 'syncing', attempts: (note.attempts ?? 0) + 1 }).eq('id', note.id);
    try {
      // Idempotent External-Id upsert on Mobile_Outbox_Id__c: insert if new, update if
      // this note was already drained. Replaces the old body-stamp scan (the managed
      // enrtcr__Note__c had no External Id; this org-custom object does).
      const res: any = await conn.sobject(n.object).upsert(payload, n.outboxId);
      const sfId = res?.id ?? res?.Id;

      await db.from('job_notes')
        .update({ status: 'synced', salesforce_note_id: sfId, synced_at: new Date().toISOString() })
        .eq('id', note.id);
      console.log(`Note ${note.id} -> ${n.object} ${sfId} (created=${res?.created})`);
    } catch (e: any) {
      await db.from('job_notes').update({ status: 'error', last_error: String(e?.message ?? e) }).eq('id', note.id);
      console.error(`Note ${note.id} failed:`, e?.message ?? e);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  drainNotes().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
