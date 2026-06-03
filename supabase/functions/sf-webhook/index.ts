import { createClient } from 'jsr:@supabase/supabase-js@2';
import { readSfEnv, sfToken, sfQuery } from '../_shared/sf.ts';
import { buildRefetchSoql, mapAllocationToJob, mapMedication, type Entity } from '../_shared/model.ts';

const RESOURCE_ID = Deno.env.get('SF_RESOURCE_ID') ?? '';
const WEBHOOK_SECRET = Deno.env.get('SF_WEBHOOK_SECRET') ?? '';

const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
);

function nowSec(): number { return Math.floor(Date.now() / 1000); }

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  if (req.headers.get('x-webhook-secret') !== WEBHOOK_SECRET) {
    return new Response('unauthorized', { status: 401 });
  }

  let body: { entity?: Entity; recordId?: string; changeType?: string };
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
  const { entity, recordId, changeType } = body;
  if (!entity || !recordId || !changeType) return new Response('missing fields', { status: 400 });

  try {
    const isDelete = changeType.toUpperCase() === 'DELETE';

    if (isDelete && entity === 'sked__Job__c') {
      await db.from('jobs').delete().eq('salesforce_id', recordId);
      return json({ ok: true, action: 'delete-job', recordId });
    }
    if (isDelete && entity === 'enrtcr__Medication__c') {
      await db.from('medications').delete().eq('salesforce_id', recordId);
      return json({ ok: true, action: 'delete-med', recordId });
    }
    if (isDelete && entity === 'sked__Job_Allocation__c') {
      // Can't re-fetch a hard-deleted allocation to find its job id → healed by SP3 reconcile.
      return json({ ok: true, action: 'allocation-hard-delete-deferred-to-reconcile', recordId });
    }

    // create/update (and allocation soft-delete handled via re-fetch): re-fetch + upsert.
    const token = await sfToken(readSfEnv(), nowSec());
    const soql = buildRefetchSoql(entity, recordId, RESOURCE_ID);
    if (!soql) return json({ ok: true, action: 'skip', recordId });
    const records = await sfQuery(token, soql);

    if (entity === 'enrtcr__Medication__c') {
      if (!records.length) return json({ ok: true, action: 'med-not-found', recordId });
      const med = mapMedication(records[0]);
      const { data: served } = await db.from('jobs').select('salesforce_id').eq('client_sf_id', med.client_sf_id).limit(1);
      if (!served?.length) return json({ ok: true, action: 'med-client-not-served', recordId });
      await db.from('medications').upsert(med, { onConflict: 'salesforce_id' });
      return json({ ok: true, action: 'upsert-med', recordId });
    }

    const upserts: ReturnType<typeof mapAllocationToJob>[] = [];
    const deletes: string[] = [];
    for (const r of records as Record<string, unknown>[]) {
      const status = String((r as { sked__Status__c?: string }).sked__Status__c ?? '');
      const job = mapAllocationToJob(r, RESOURCE_ID);
      if (status === 'Deleted' || !job.client_sf_id) deletes.push(job.salesforce_id as string);
      else upserts.push(job);
    }
    if (upserts.length) await db.from('jobs').upsert(upserts, { onConflict: 'salesforce_id' });
    for (const sfId of deletes) await db.from('jobs').delete().eq('salesforce_id', sfId);
    return json({ ok: true, action: 'jobs', upserts: upserts.length, deletes: deletes.length, recordId });
  } catch (e) {
    console.error('sf-webhook error', recordId, entity, changeType, (e as Error).message);
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
