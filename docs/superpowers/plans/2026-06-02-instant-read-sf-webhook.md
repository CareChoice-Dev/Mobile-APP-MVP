# SP1 — Instant Read (SF → Supabase webhook) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Salesforce record-triggered Flows push create/update/delete to a Supabase `sf-webhook` Edge Function that re-fetches the record and upserts/deletes the matching `jobs`/`medications` row — so app data reflects Salesforce within seconds, on a Supabase-only stack.

**Architecture:** A Deno Edge Function (`sf-webhook`) gated by a shared secret receives `{entity, recordId, changeType}`, authenticates to Salesforce via a JWT-bearer client (`_shared/sf.ts`, Web Crypto — `jsforce` can't run in Deno), re-fetches the canonical record(s) for the single configured resource, and upserts (or deletes) into Supabase by `salesforce_id`. Salesforce-side Flows + a Named Credential do the pushing.

**Tech Stack:** Deno (Supabase Edge Functions), Web Crypto API, Salesforce REST v64.0 + JWT-bearer, Supabase service-role client, Salesforce Flows/Named Credentials, `supabase` CLI.

**Spec:** `docs/superpowers/specs/2026-06-02-instant-read-sf-webhook-design.md`. **Branch:** `claude/read-path-scheduling`.

**Org safety:** All Salesforce/Supabase deploys target UAT only — Salesforce `carechoice-uat` (org `00D9p00000B60rpEAB`), Supabase project `xgkvdnaciymazdxxxoxu`. NEVER prod (`00D5g0000062TbVEAU`).

**Reference (in repo, proven this session):** `sync/src/clients.ts` (Node JWT to mirror), `sync/src/syncRead.ts` (read SOQL + row mapping to mirror), `sync/src/sf-model.ts` (field constants), `supabase/schema.sql` (`jobs`/`medications` columns), `salesforce/mdapi/*` (deploy pattern).

---

## File Structure

- **Create** `supabase/functions/_shared/sf.ts` — Deno SF client: env, pure JWT-assertion builder, RS256 signing, token, `query()`.
- **Create** `supabase/functions/_shared/sf.test.ts` — Deno unit tests for the pure builders.
- **Create** `supabase/functions/_shared/model.ts` — the SF object/field constants + pure `buildRefetchSoql()` and row→table mappers.
- **Create** `supabase/functions/_shared/model.test.ts` — Deno unit tests for SOQL building + mapping.
- **Create** `supabase/functions/sf-webhook/index.ts` — the HTTP handler (verify secret, route, re-fetch, upsert/delete).
- **Create** `supabase/functions/sf-webhook/deno.json` — function config (if needed for imports).
- **Create** `docs/salesforce-flows-setup.md` — admin runbook for the Named Credential + Flows (built in Setup UI; Flow/NamedCredential MDAPI XML is impractical to hand-author and brittle — UI build is the realistic path, optionally retrieved to `salesforce/mdapi/` after).
- **Modify** `docs/local-dev.md` — record SP1 status.

**Conventions:** Deno uses URL/`npm:` imports (no `node_modules`). The Supabase service-role client + URL are auto-injected as `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` in deployed functions.

---

## Task 1: Tooling prerequisites + PKCS#8 key

**Files:** none (environment + a gitignored key file)

- [ ] **Step 1: Verify/install Deno**

Run: `deno --version`
If "command not found", install (Windows PowerShell): `irm https://deno.land/install.ps1 | iex` then reopen the shell. Expected: `deno 1.x`/`2.x`.

- [ ] **Step 2: Verify/install the Supabase CLI**

Run: `supabase --version`
If missing, install via scoop (`scoop install supabase`) or download from https://github.com/supabase/cli/releases. Expected: a version string.

- [ ] **Step 3: Convert the JWT private key to PKCS#8 (Web Crypto needs PKCS#8; `openssl genrsa` emits PKCS#1)**

Run from repo root:
```bash
openssl pkcs8 -topk8 -nocrypt -in sync/server.key -out sync/server.pkcs8.key
head -1 sync/server.pkcs8.key   # expect: -----BEGIN PRIVATE KEY-----
```
`sync/server.pkcs8.key` is gitignored (`*.key`). Its contents become the `SF_PRIVATE_KEY` Supabase secret in Task 6. No commit (key is gitignored). Expected output: `-----BEGIN PRIVATE KEY-----`.

---

## Task 2: Deno SF client — pure JWT-assertion builder (TDD)

**Files:**
- Create: `supabase/functions/_shared/sf.ts`
- Test: `supabase/functions/_shared/sf.test.ts`

- [ ] **Step 1: Write the failing test**

`supabase/functions/_shared/sf.test.ts`:
```ts
import { assertEquals } from 'jsr:@std/assert';
import { buildJwtParts, type SfEnv } from './sf.ts';

const env: SfEnv = {
  loginUrl: 'https://test.salesforce.com',
  clientId: 'CONSUMER_KEY',
  username: 'svc@example.com',
  privateKeyPkcs8Pem: '',
};

Deno.test('buildJwtParts encodes header+claim as two base64url segments', () => {
  const parts = buildJwtParts(env, 1_000_000);
  const [h, c] = parts.split('.');
  assertEquals(parts.split('.').length, 2);
  const header = JSON.parse(atob(h.replace(/-/g, '+').replace(/_/g, '/')));
  const claim = JSON.parse(atob(c.replace(/-/g, '+').replace(/_/g, '/')));
  assertEquals(header, { alg: 'RS256', typ: 'JWT' });
  assertEquals(claim.iss, 'CONSUMER_KEY');
  assertEquals(claim.sub, 'svc@example.com');
  assertEquals(claim.aud, 'https://test.salesforce.com');
  assertEquals(claim.exp, 1_000_000 + 180);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `deno test supabase/functions/_shared/sf.test.ts`
Expected: FAIL — cannot find module `./sf.ts` / `buildJwtParts`.

- [ ] **Step 3: Create `sf.ts` with the pure builder + env reader**

```ts
// Deno Salesforce client (mirrors sync/src/clients.ts). JWT-bearer via Web Crypto,
// since jsforce can't run in Supabase Edge Functions.
export interface SfEnv {
  loginUrl: string;
  clientId: string;
  username: string;
  privateKeyPkcs8Pem: string;
}

export function readSfEnv(): SfEnv {
  return {
    loginUrl: Deno.env.get('SF_LOGIN_URL') ?? 'https://test.salesforce.com',
    clientId: Deno.env.get('SF_CLIENT_ID') ?? '',
    username: Deno.env.get('SF_USERNAME') ?? '',
    privateKeyPkcs8Pem: Deno.env.get('SF_PRIVATE_KEY') ?? '',
  };
}

const b64urlFromString = (s: string) =>
  btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlFromBytes = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Pure: the signing input `header.claim` (base64url), testable without crypto.
export function buildJwtParts(env: SfEnv, nowSec: number): string {
  const header = b64urlFromString(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64urlFromString(
    JSON.stringify({ iss: env.clientId, sub: env.username, aud: env.loginUrl, exp: nowSec + 180 }),
  );
  return `${header}.${claim}`;
}

function pkcs8PemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function signRs256(unsigned: string, pkcs8Pem: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8', pkcs8PemToDer(pkcs8Pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return b64urlFromBytes(sig);
}

export interface SfToken { access_token: string; instance_url: string; }

export async function sfToken(env: SfEnv, nowSec: number): Promise<SfToken> {
  const unsigned = buildJwtParts(env, nowSec);
  const assertion = `${unsigned}.${await signRs256(unsigned, env.privateKeyPkcs8Pem)}`;
  const res = await fetch(`${env.loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) throw new Error(`SF token failed: ${res.status} ${await res.text()}`);
  return await res.json() as SfToken;
}

export async function sfQuery<T = Record<string, unknown>>(token: SfToken, soql: string): Promise<T[]> {
  const url = `${token.instance_url}/services/data/v64.0/query?q=${encodeURIComponent(soql)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token.access_token}` } });
  if (!res.ok) throw new Error(`SF query failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.records as T[];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno test supabase/functions/_shared/sf.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/sf.ts supabase/functions/_shared/sf.test.ts
git commit -m "feat(edge): Deno SF client (JWT-bearer via Web Crypto + REST query)"
```

---

## Task 3: Entity routing + row mapping (TDD)

**Files:**
- Create: `supabase/functions/_shared/model.ts`
- Test: `supabase/functions/_shared/model.test.ts`

- [ ] **Step 1: Write the failing test**

`supabase/functions/_shared/model.test.ts`:
```ts
import { assertEquals, assertThrows } from 'jsr:@std/assert';
import { buildRefetchSoql, mapAllocationToJob, type Entity } from './model.ts';

const RES = 'a2sI80000000UtHIAU';

Deno.test('buildRefetchSoql: allocation filters by Id + resource', () => {
  const soql = buildRefetchSoql('sked__Job_Allocation__c', 'a2X1', RES);
  assertEquals(soql!.includes("WHERE Id = 'a2X1'"), true);
  assertEquals(soql!.includes(`sked__Resource__c = '${RES}'`), true);
  assertEquals(soql!.includes('FROM sked__Job_Allocation__c'), true);
});

Deno.test('buildRefetchSoql: job filters by job lookup + resource', () => {
  const soql = buildRefetchSoql('sked__Job__c', 'a2J1', RES);
  assertEquals(soql!.includes("sked__Job__c = 'a2J1'"), true);
  assertEquals(soql!.includes(`sked__Resource__c = '${RES}'`), true);
});

Deno.test('buildRefetchSoql: medication filters by Id', () => {
  const soql = buildRefetchSoql('enrtcr__Medication__c', 'a0M1', RES);
  assertEquals(soql!.includes("WHERE Id = 'a0M1'"), true);
  assertEquals(soql!.includes('FROM enrtcr__Medication__c'), true);
});

Deno.test('buildRefetchSoql: unknown entity throws', () => {
  assertThrows(() => buildRefetchSoql('Bogus__c' as Entity, 'x', RES), Error, 'Unknown entity');
});

Deno.test('mapAllocationToJob maps the joined row to a jobs upsert', () => {
  const row = {
    sked__Job__c: 'a2J1',
    sked__Status__c: 'Confirmed',
    sked__Job__r: {
      Name: 'JOB-1', sked__Job_Status__c: 'Dispatched', sked__Type__c: 'Visit',
      sked__Start__c: '2026-06-02T01:00:00.000+0000', sked__Finish__c: '2026-06-02T02:00:00.000+0000',
      sked__Contact__c: '0031',
    },
  };
  const job = mapAllocationToJob(row, RES);
  assertEquals(job.salesforce_id, 'a2J1');
  assertEquals(job.job_number, 'JOB-1');
  assertEquals(job.status, 'Dispatched');
  assertEquals(job.client_sf_id, '0031');
  assertEquals(job.resource_id, RES);
  assertEquals(job.allocation_status, 'Confirmed');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `deno test supabase/functions/_shared/model.test.ts`
Expected: FAIL — cannot find `./model.ts`.

- [ ] **Step 3: Create `model.ts`**

```ts
// SF object/field constants (mirror of sync/src/sf-model.ts, the subset SP1 needs)
// + pure helpers for the webhook: re-fetch SOQL and row→table mapping.
export type Entity = 'sked__Job_Allocation__c' | 'sked__Job__c' | 'enrtcr__Medication__c';

const JOB_FIELDS =
  'sked__Job__c, sked__Status__c, LastModifiedDate, ' +
  'sked__Job__r.Name, sked__Job__r.sked__Job_Status__c, sked__Job__r.sked__Type__c, ' +
  'sked__Job__r.sked__Start__c, sked__Job__r.sked__Finish__c, sked__Job__r.sked__Contact__c';

const MED_FIELDS =
  'Id, Client__c, Name, Dosage__c, Route__c, Medication_Support__c, Status__c, ' +
  'Start_Date__c, End_Date__c, Instructions_to_administer_medicines__c, LastModifiedDate';

// Pure: SOQL to re-fetch the canonical record(s) for a change event, scoped to one resource.
// (Note: includes Deleted allocations so the handler can detect soft-deletes; null = skip.)
export function buildRefetchSoql(entity: Entity, recordId: string, resourceId: string): string | null {
  switch (entity) {
    case 'sked__Job_Allocation__c':
      return `SELECT Id, ${JOB_FIELDS} FROM sked__Job_Allocation__c ` +
        `WHERE Id = '${recordId}' AND sked__Resource__c = '${resourceId}'`;
    case 'sked__Job__c':
      return `SELECT Id, ${JOB_FIELDS} FROM sked__Job_Allocation__c ` +
        `WHERE sked__Job__c = '${recordId}' AND sked__Resource__c = '${resourceId}'`;
    case 'enrtcr__Medication__c':
      return `SELECT ${MED_FIELDS} FROM enrtcr__Medication__c WHERE Id = '${recordId}'`;
    default:
      throw new Error(`Unknown entity: ${entity}`);
  }
}

// deno-lint-ignore no-explicit-any
export function mapAllocationToJob(r: any, resourceId: string) {
  const j = r.sked__Job__r ?? {};
  return {
    salesforce_id: r.sked__Job__c,
    job_number: j.Name,
    status: j.sked__Job_Status__c,
    job_type: j.sked__Type__c,
    starts_at: j.sked__Start__c,
    ends_at: j.sked__Finish__c,
    client_sf_id: j.sked__Contact__c,
    resource_id: resourceId,
    allocation_status: r.sked__Status__c,
    salesforce_modified_at: r.LastModifiedDate ?? null,
    synced_at: new Date().toISOString(),
  };
}

// deno-lint-ignore no-explicit-any
export function mapMedication(r: any) {
  return {
    salesforce_id: r.Id,
    client_sf_id: r.Client__c,
    name: r.Name,
    dosage: r.Dosage__c,
    route: r.Route__c,
    support_type: r.Medication_Support__c,
    status: r.Status__c,
    start_date: r.Start_Date__c,
    end_date: r.End_Date__c,
    instructions: r.Instructions_to_administer_medicines__c,
    salesforce_modified_at: r.LastModifiedDate ?? null,
    synced_at: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno test supabase/functions/_shared/model.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/model.ts supabase/functions/_shared/model.test.ts
git commit -m "feat(edge): entity refetch-SOQL + row mapping for sf-webhook"
```

---

## Task 4: `sf-webhook` Edge Function handler

**Files:**
- Create: `supabase/functions/sf-webhook/index.ts`

- [ ] **Step 1: Create the handler**

```ts
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

    // Hard deletes we can act on directly by the table's salesforce_id key.
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
      // Single-resource scope: only sync meds for a client we have a job with.
      const { data: served } = await db.from('jobs').select('salesforce_id').eq('client_sf_id', med.client_sf_id).limit(1);
      if (!served?.length) return json({ ok: true, action: 'med-client-not-served', recordId });
      await db.from('medications').upsert(med, { onConflict: 'salesforce_id' });
      return json({ ok: true, action: 'upsert-med', recordId });
    }

    // jobs path (allocation or job entity)
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
```

- [ ] **Step 2: Type-check the function**

Run: `deno check supabase/functions/sf-webhook/index.ts`
Expected: no errors. (If `Deno.serve`/remote-import type warnings appear, they're acceptable for Edge Functions; only fix real type errors.)

- [ ] **Step 3: Re-run all Deno tests**

Run: `deno test supabase/functions/`
Expected: PASS (6 tests across sf.test.ts + model.test.ts; the handler has no unit test — it's verified by curl/e2e in Tasks 7–8).

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/sf-webhook/index.ts
git commit -m "feat(edge): sf-webhook handler (verify secret, re-fetch, upsert/delete)"
```

---

## Task 5: Deploy `sf-webhook` to Supabase (UAT project)

**Files:** none (deploy)

- [ ] **Step 1: Link the Supabase project (if not already)**

Run: `supabase link --project-ref xgkvdnaciymazdxxxoxu`
(Authenticates via `supabase login` if needed — that login is the **user's** action.)

- [ ] **Step 2: Deploy the function with JWT verification OFF (Salesforce has no Supabase JWT; we gate on the shared secret)**

Run: `supabase functions deploy sf-webhook --no-verify-jwt`
Expected: a deployed function URL like `https://xgkvdnaciymazdxxxoxu.supabase.co/functions/v1/sf-webhook`. Record it for Tasks 6–7.

---

## Task 6: Set function secrets (USER action)

**Files:** none

The private key + consumer key are secrets; the **user** sets them (don't print them).

- [ ] **Step 1: Set secrets**

```bash
supabase secrets set \
  SF_LOGIN_URL=https://test.salesforce.com \
  SF_CLIENT_ID=<UAT External Client App consumer key> \
  SF_USERNAME=svc-mvp-sync@carechoice.com.au \
  SF_RESOURCE_ID=a2sI80000000UtHIAU \
  SF_WEBHOOK_SECRET=<generate a strong random string> \
  --project-ref xgkvdnaciymazdxxxoxu
supabase secrets set SF_PRIVATE_KEY="$(cat sync/server.pkcs8.key)" --project-ref xgkvdnaciymazdxxxoxu
```
(`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are auto-injected — do NOT set them.) Keep `SF_WEBHOOK_SECRET`; it goes into the Salesforce External Credential in Task 7.

- [ ] **Step 2: Redeploy so secrets load, then smoke-test auth**

```bash
supabase functions deploy sf-webhook --no-verify-jwt --project-ref xgkvdnaciymazdxxxoxu
# Expect 401 (secret gate works) — no body needed:
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://xgkvdnaciymazdxxxoxu.supabase.co/functions/v1/sf-webhook
```
Expected: `401`.

---

## Task 7: Salesforce side — Named Credential + Flows (admin, UAT)

**Files:**
- Create: `docs/salesforce-flows-setup.md` (the runbook below)

Flows + Named/External Credentials are built in **Setup UI** (hand-authored Flow MDAPI XML is brittle); capture to `salesforce/mdapi/` afterward if version control is wanted. An **admin** does this in `carechoice-uat`.

- [ ] **Step 1: Write `docs/salesforce-flows-setup.md`** with these exact steps:

```markdown
# SP1 — Salesforce push setup (UAT carechoice-uat)

## 1. External Credential (shared-secret auth to the webhook)
Setup → Named Credentials → External Credentials → New:
- Label/Name: `Supabase_Webhook`; Authentication Protocol: **Custom**.
- Principal: add an Identity-type Named Principal `webhook` with a Custom Header:
  - Name: `x-webhook-secret`  Value: `<SF_WEBHOOK_SECRET from Task 6>`
- Add a Permission Set (e.g. the integration/admin running the Flow) to the External Credential's "Enabled Principals".

## 2. Named Credential
Setup → Named Credentials → New:
- Label/Name: `Supabase_Webhook`
- URL: `https://xgkvdnaciymazdxxxoxu.supabase.co`
- External Credential: `Supabase_Webhook`
- Enable "Allow Formulas in HTTP Header".

## 3. One record-triggered Flow per object (repeat for the three)
For each of `sked__Job__c`, `sked__Job_Allocation__c`, `enrtcr__Medication__c`:
Setup → Flows → New → **Record-Triggered Flow**:
- Object: the object; Trigger: **A record is created or updated**; Optimize for: **Actions and Related Records** (after-save); set **"Include a Run Asynchronously path"** (callouts must be async).
- On the **Asynchronous** path add an **HTTP Callout** (or Action → "Call External Service"/Apex) using Named Credential `Supabase_Webhook`:
  - Method: POST; Path: `/functions/v1/sf-webhook`
  - Header: `Content-Type: application/json`
  - Body (text template):
    `{ "entity": "<OBJECT_API_NAME>", "recordId": "{!$Record.Id}", "changeType": "{!$Record.IsNew? 'CREATE':'UPDATE'}" }`
    (or just `"UPDATE"`/`"CREATE"` — the webhook treats both as upsert).
- Activate.
- **Delete:** create a second Record-Triggered Flow on the same object with Trigger **A record is deleted** → Async path → same HTTP Callout but `"changeType": "DELETE"`. (If the org's Flow delete-trigger can't make a callout, use a small after-delete Apex trigger that enqueues a Queueable callout instead — see fallback below.)

## Fallback (delete via Apex, if Flow delete callout is unavailable)
A trigger `after delete` on the object collects `Trigger.old` Ids and enqueues a Queueable that POSTs each `{entity, recordId, changeType:'DELETE'}` to the Named Credential endpoint.
```

- [ ] **Step 2: Commit the runbook**

```bash
git add docs/salesforce-flows-setup.md
git commit -m "docs(salesforce): SP1 Named Credential + Flow setup runbook"
```

- [ ] **Step 3: Admin builds the above in `carechoice-uat`**

This is the admin's action (not the integration user). Confirm the three create/update Flows + delete handling are Active before Task 8.

---

## Task 8: Verification — curl + end-to-end (UAT)

**Files:** none

- [ ] **Step 1: Curl the webhook with a real record id (create/update path)**

Find a synced job's SF id (e.g. `a2Z9p000001dUfBEAU` from this session) and:
```bash
URL=https://xgkvdnaciymazdxxxoxu.supabase.co/functions/v1/sf-webhook
SECRET=<SF_WEBHOOK_SECRET>
curl -s -X POST "$URL" -H "x-webhook-secret: $SECRET" -H "Content-Type: application/json" \
  -d '{"entity":"sked__Job__c","recordId":"a2Z9p000001dUfBEAU","changeType":"UPDATE"}'
```
Expected: `{"ok":true,"action":"jobs","upserts":1,"deletes":0,...}`. Run it twice — second call is idempotent (still upserts 1, no duplicate row).

- [ ] **Step 2: Verify the row in Supabase**

Via the Supabase MCP `execute_sql` (read-only) on project `xgkvdnaciymazdxxxoxu`:
```sql
select salesforce_id, status, salesforce_modified_at, synced_at from public.jobs where salesforce_id = 'a2Z9p000001dUfBEAU';
```
Expected: one row, `synced_at` just now. (A second `synced_at` after re-running Step 1 confirms update-in-place, not duplication.)

- [ ] **Step 3: End-to-end via Salesforce**

In `carechoice-uat`, edit that Job (e.g. change a field) and save. Within seconds, re-run the Step 2 query → `salesforce_modified_at`/`synced_at` advanced without any manual sync. Then set an allocation's `sked__Status__c` to `Deleted` → confirm the `jobs` row is removed.

- [ ] **Step 4: Confirm the Edge Function logs**

Run: `supabase functions logs sf-webhook --project-ref xgkvdnaciymazdxxxoxu`
Expected: 200 responses for the test calls; no unhandled errors.

---

## Task 9: Docs

**Files:**
- Modify: `docs/local-dev.md`

- [ ] **Step 1: Add an SP1 status note under §7**

Append after the §7 backlog list:
```markdown

### Read-path automation (decomposed)
- **SP1 — instant read (done/in-progress):** Salesforce Flows push create/update/delete →
  Supabase `sf-webhook` Edge Function (`supabase/functions/sf-webhook`) → upsert/delete `jobs`/
  `medications` by `salesforce_id`. Shared Deno SF client at `supabase/functions/_shared/sf.ts`.
  Admin setup runbook: `docs/salesforce-flows-setup.md`. Full instant UX also needs app-side
  Supabase Realtime (§7.5).
- **SP2 — 5-min write drain (todo):** port `drainOutbox`/`drainMedAdmin` to an Edge Function + `pg_cron`.
- **SP3 — reconcile poll (todo):** periodic `syncRead` Edge Function + `pg_cron` to heal missed callouts
  (incl. allocation hard-deletes).
```

- [ ] **Step 2: Commit**

```bash
git add docs/local-dev.md
git commit -m "docs: record SP1 instant-read read-path automation"
```

---

## Done-When
- `deno test supabase/functions/` passes (6 unit tests); `deno check` clean for the handler.
- `sf-webhook` deployed to the UAT Supabase project with secrets set; unauthorized calls → 401.
- Salesforce Flows (create/update + delete) on the three objects are active in `carechoice-uat`, calling the webhook.
- E2E: editing a Job/Medication in UAT updates the Supabase row within seconds; soft-deleting an allocation removes the `jobs` row; webhook is idempotent.
- Docs updated. Out of scope (SP2 write drain, SP3 reconcile, app Realtime) explicitly deferred.

## Self-Review notes
- Spec coverage: §1→T2–4/T7, §2→T7, §3.1→T2, §3.2→T4, §3.3→T4 (+ allocation hard-delete deferred to SP3), §4→T4/T5/T6, §6→T5–7, §7→T2/T3/T8. No gaps.
- Allocation **hard delete** is intentionally deferred to SP3 reconcile (spec §3.3) — the handler returns a no-op action for it (the common allocation removal is a soft `Deleted` status = an update, handled live).
- `LastModifiedDate` is included in both `JOB_FIELDS` and `MED_FIELDS` so the mappers' `r.LastModifiedDate` populates `salesforce_modified_at`. (Fixed inline.)
- Type/name consistency checked: `SfEnv`/`sfToken`/`sfQuery` and `buildRefetchSoql`/`mapAllocationToJob`/`mapMedication`/`Entity` match across `sf.ts`, `model.ts`, their tests, and `sf-webhook/index.ts`; `jobs`/`medications` columns match `supabase/schema.sql`.
