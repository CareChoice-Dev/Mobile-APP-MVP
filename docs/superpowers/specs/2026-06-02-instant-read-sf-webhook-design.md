# Design — Instant read sync (SP1): Salesforce → Supabase webhook push

**Date:** 2026-06-02
**Status:** Approved (brainstorming) — pending implementation plan
**Backlog ref:** §7.4 read-path scheduling, reframed to **instant** (event-driven) reads.

## 0. Scope & decomposition

The user's requirement evolved from "scheduled read sync" to: **users must see Salesforce
creates/updates/deletes in the app within seconds**, while note write-back can stay a 5-min
batch. That is bigger than one spec, so the work is decomposed into three sub-projects sharing a
**Deno Salesforce client** (jsforce can't run in Supabase Edge Functions):

- **SP1 (this spec) — Instant read:** SF pushes changes → Supabase Edge Function webhook → upsert/delete.
- **SP2 — 5-min write-back:** `drain` Edge Function (port `drainOutbox` + `drainMedAdmin`) + `pg_cron`.
- **SP3 — Reconcile safety net:** periodic poll Edge Function + `pg_cron` to heal missed callouts.

### Why webhook-push and not CDC
True Salesforce CDC requires a persistent subscriber (Pub/Sub/Streaming API); Supabase Edge
Functions are request/response and can't hold that subscription, and Supabase has no always-on
worker product. To get instant push **on a Supabase-only stack**, Salesforce itself POSTs on
change (record-triggered Flow → HTTP callout → Edge Function). True CDC was considered and
rejected because it would force a non-Supabase host (decision: stay on Supabase).

## 1. Architecture & data flow

```
SF record create/update/delete
  → record-triggered Flow (async path)
  → HTTP callout via Named Credential  (POST { entity, recordId, changeType } + shared secret)
  → Supabase `sf-webhook` Edge Function (Deno)
      → verify shared secret
      → re-fetch canonical record via SF REST (as the integration user, existing read perms)
      → upsert (create/update) or delete (delete) the matching Supabase row
  → row changes in Supabase  → (app sees it once Supabase Realtime / §7.5 is wired)
```

Idempotent throughout (upsert by `salesforce_id`); duplicate/retried callouts are safe.

## 2. Salesforce side (admin-deployed metadata, UAT `carechoice-uat`)

- **External Credential + Named Credential** targeting the deployed `sf-webhook` URL, injecting a
  shared-secret header (e.g. `x-webhook-secret`). The callout auth is the Named Credential's, so it
  works regardless of which user triggered the change.
- **Record-triggered Flows** on `sked__Job__c`, `sked__Job_Allocation__c`, `enrtcr__Medication__c`:
  - create/update: **after-save, async path** (callouts can't run in the triggering transaction).
  - delete: Flow delete trigger (or a small after-delete Apex if the Flow path is insufficient).
  - Action: HTTP callout to the Named Credential posting `{ entity, recordId, changeType }`.
- Deployed by an admin (the integration user can't deploy metadata), same as the object deploys.
- **No CDC** → no CDC licensing/enablement dependency.

## 3. Supabase side (Deno Edge Functions)

### 3.1 `_shared/sf.ts` — Deno Salesforce client (foundation SP2/SP3 reuse)
- **Auth:** JWT-bearer. Sign the assertion with **Web Crypto** (`crypto.subtle`, `RSASSA-PKCS1-v1_5`/
  SHA-256). The private key is a function **secret in PKCS#8** (convert `sync/server.key`, which is
  PKCS#1, via `openssl pkcs8 -topk8 -nocrypt`). POST to `${SF_LOGIN_URL}/services/oauth2/token`
  (`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`) → `{ access_token, instance_url }`.
- **`query(soql)`** helper over `${instance_url}/services/data/v64.0/query`.
- Reuses the same field model as `sync/src/sf-model.ts` (mirror the constants in Deno).

### 3.2 `sf-webhook` Edge Function
- Deployed `--no-verify-jwt`; **gate on the shared-secret header** (Salesforce has no Supabase JWT).
- Parse `{ entity, recordId, changeType }`; create a service-role Supabase client (auto-injected env).
- Route + **single-resource scope** (`SF_RESOURCE_ID`):
  - `sked__Job_Allocation__c` change → re-fetch the allocation (+ its job, contact) for our resource;
    upsert the `jobs` row (keyed by **job** `salesforce_id`). If the allocation's status is `Deleted`
    (soft-delete, the Skedulo norm) → delete the `jobs` row.
  - `sked__Job__c` change → re-fetch the job + its allocation(s) for our resource → upsert `jobs`
    row(s); hard delete → delete `jobs` where `salesforce_id = recordId`.
  - `enrtcr__Medication__c` change → upsert `medications` (keyed by med `salesforce_id`), only if the
    med's client is one we serve; hard delete → delete `medications` where `salesforce_id = recordId`.
- Upserts populate `salesforce_modified_at` from SF `LastModifiedDate`. Same mapping as `syncRead`.

### 3.3 Delete handling (explicit)
- **Common case** — allocation removed = status → `Deleted` (an UPDATE event) → handled live (delete row).
- **Job / Medication hard delete** → handled live (delete by the record id, which is the table's key).
- **Allocation hard delete** (uncommon; can't re-fetch a deleted allocation to find its job) → **healed
  by SP3's reconcile poll**, not live. Documented limitation; avoids adding an `allocation_sf_id`
  column for a rare case (YAGNI).

## 4. Security & errors
- Shared secret stored as a Supabase secret AND in the SF External Credential; webhook rejects on mismatch.
- Webhook is **idempotent** (upsert by `salesforce_id`); safe under Flow async retries / duplicate events.
- A failed callout or webhook error leaves Supabase stale until **SP3's reconcile poll** heals it.
- The webhook re-fetches as the **integration user** — no new SF read perms (jobs/meds/Contact already granted).

## 5. Out of scope (SP1)
- SP2 (5-min write drain), SP3 (reconcile poll), app-side **Supabase Realtime** (§7.5 — required for the
  *full* "user sees it instantly" UX; this spec only guarantees data lands in Supabase in seconds).
- Multi-resource (org-wide) sync — single `SF_RESOURCE_ID` for now.
- Porting the SF **write** path to Deno (that's SP2).

## 6. Deploy order & secrets
1. Deploy `sf-webhook` to Supabase → obtain its URL. Set secrets: `SF_CLIENT_ID`, `SF_USERNAME`,
   `SF_LOGIN_URL`, `SF_RESOURCE_ID`, `SF_PRIVATE_KEY` (PKCS#8 PEM), `SF_WEBHOOK_SECRET`.
   (`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are auto-injected.) — secret-setting is the **user's** action.
2. Admin deploys the SF External/Named Credential (using the webhook URL + secret) + the record-triggered Flows.
3. Controller drives the Supabase deploy with user checkpoints; SF metadata deploy is admin-gated.

## 7. Testing
- **Unit:** the Deno SF client's JWT assertion builder + the entity→table/SOQL routing (pure logic), via Deno's test runner.
- **Webhook integration:** `curl` the deployed function with sample `create`/`update`/`delete` payloads for each entity → assert the Supabase row upserts/deletes + idempotency (second identical call = no dup).
- **End-to-end (UAT):** change a Job / Medication in `carechoice-uat` → confirm the Supabase row updates within seconds; set an allocation status to `Deleted` → confirm the `jobs` row is removed.

## 8. Open / flagged
- **CDC availability** is moot (not used).
- **Flow delete-trigger vs Apex** for hard deletes — confirm the Flow delete path supports an async callout in this org during the plan; fall back to a tiny after-delete Apex trigger if not.
- **Supabase secret for the private key** — confirm Edge Function secret size limits accommodate the PEM (they do; ~1.7 KB).
- Re-fetch SOQL for the single-resource job/allocation join reuses `syncRead`'s proven query shape.
