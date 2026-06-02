# Live JWT Sync Run — Setup & Runbook (UAT)

Goal: run the real `sync/` service (jsforce + supabase-js) against the **UAT**
Salesforce org using a JWT-bearer **integration user**, from a Claude Code cloud
session. This file lets a fresh session execute without re-deriving context.

## Fixed facts
- **Supabase project:** `Mobile MVP`, ref `xgkvdnaciymazdxxxoxu`, region ap-southeast-2.
  - `SUPABASE_URL=https://xgkvdnaciymazdxxxoxu.supabase.co`
- **Salesforce UAT org:** `CareChoice` / instance **AUS24S** / sandbox. Login host
  `https://test.salesforce.com`. (A **production** org `AUS92` is also reachable via
  one MCP connector — do NOT use it for this.)
- **Resource being synced:** `a2sI80000000UtHIAU` (the deployed test user
  `worker@example.com` maps to it via `profiles.salesforce_resource_id`).
- Schema is already applied; 51 jobs + 45 meds already loaded; one case note was
  drained to UAT earlier. RLS verified for the test worker.

## Prerequisites (done in the Salesforce + environment UIs)
1. **Integration user** (Salesforce Integration license, "Minimum Access - API Only
   Integrations" profile) + a permission set granting: Read+ViewAll on
   `sked__Job_Allocation__c`, `sked__Job__c`, `enrtcr__Medication__c`; Read+Create on
   `enrtcr__Note__c`; API Enabled; FLS on the fields in `sync/src/sf-model.ts`.
2. **External Client App** with **Enable JWT Bearer Flow** + the cert uploaded, and
   **Policies → OAuth → "Admin approved users are pre-authorized"** with the perm set
   authorized. Consumer Key → `SF_CLIENT_ID`.
3. **Environment network access = Custom**, allowed domains include:
   `*.salesforce.com`, `*.my.salesforce.com`, `*.force.com`, `*.supabase.co`
   (keep the default package-manager list checked so `npm install` works).
4. **Environment variables** (`.env` format, no quotes):
   `SF_CLIENT_ID`, `SF_USERNAME`, `SUPABASE_SERVICE_ROLE_KEY`.

## The JWT keypair (regenerate each session — it's ephemeral & gitignored)
The private key must NOT be committed (public repo). Generate in-session:
```bash
cd sync
openssl genrsa -out server.key 2048
openssl req -new -x509 -key server.key -days 365 -out server.crt -subj "/CN=carechoice-mvp-sync"
cat server.crt          # give this to the user to upload to the External Client App
```
Then the user re-uploads `server.crt` (JWT Bearer Flow) and the new cert takes effect.

## Run (after network + secrets + cert are in place)
```bash
cd sync && npm install
# non-secret config (secrets come from injected env vars):
export SF_LOGIN_URL=https://test.salesforce.com
export SF_RESOURCE_ID=a2sI80000000UtHIAU
export SUPABASE_URL=https://xgkvdnaciymazdxxxoxu.supabase.co
export SF_PRIVATE_KEY_PATH=./server.key
DRY_RUN=1 npm run sync:read    # prove JWT auth + read (no writes)
DRY_RUN=0 npm run sync:read    # upsert jobs + meds
DRY_RUN=0 npm run drain        # push pending job_notes -> Case_Note_MVP__c (External-Id upsert)
```
(`sync/.env` already holds the non-secret values too, but it's gitignored so it
won't exist in a fresh clone — re-create it or use the exports above.)

## Known state / gotchas
- **Fixed:** read SOQL relationship was `sked__Job__c__r`; correct is `sked__Job__r`
  (now via `jobRel` in `sf-model.ts`).
- **Fixed:** `clients.ts` called `require('node:crypto')` inside this ESM package
  (`"type": "module"`), throwing `require is not defined` and blocking JWT signing.
  Now imported as ESM at the top of the file. JWT-bearer auth verified against UAT.
- **Fixed:** `drainOutbox.ts` idempotency check filtered `enrtcr__Description__c`
  (a Long Text Area) with `LIKE`, which SOQL rejects (`field ... can not be filtered
  in a query call`), failing every drain. Now filters by the (filterable) Job lookup
  and matches the `outbox:` stamp client-side. Verified: re-matches already-drained
  notes instead of duplicating.
- **RESOLVED (read path):** the integration user (Salesforce Integration license,
  "Minimum Access - API Only Integrations", `0059p00000SbMvtAAF`) needed `Contact`
  **object** read for the client lookups. The fix was **not** the base license/profile:
  assign the **Salesforce API Integration permission-set license** (PSL,
  `0PLI800000000MxOAI`, 4 free seats) to the user, then grant `Contact` Read on
  `MVP_Sync_Integration_Access` (`0PS9p000003lptNGAQ`). FLS on the three client lookups
  was already present. After that the read sync runs clean (53 jobs + 45 meds upserted).
  (Without the PSL, ObjectPermissions Read on a standard object fails with
  `FIELD_INTEGRITY_EXCEPTION: "user license doesn't allow the permission: Read Contact"`.)
- **RESOLVED (2026-06-02) — note write-back via org-custom object:** the Integration-license
  user still **cannot create the managed `enrtcr__Note__c`** (`createable=false`, even with
  `PermissionsCreate=true` — the license caps writes to that managed object). Fix shipped: an
  **org-custom `Case_Note_MVP__c`** object (the Integration license *can* create org-custom
  objects) was deployed to UAT, the `Case Note MVP Access` perm set assigned to the integration
  user, and `npm run write:test` confirmed a create as that user (record `aCO9p0000000hhhGAA`).
  `drainOutbox.ts` now upserts into `Case_Note_MVP__c` by the `Mobile_Outbox_Id__c` External Id.
  No full-license / username-password identity needed for the write path anymore.
- **Gap:** `drainOutbox.ts` drains notes only — no `medication_administrations`
  drainer yet (those rows stay `pending`).
- **Cleanup pending in UAT:** test note `a0x9p000002Xru1AAC` (kept, "Safe to delete")
  and the older `a0x9p000002XGhZAAW` (a delete was blocked by the safety classifier).
- **Auth errors:** `user hasn't approved this consumer` → pre-authorization/profile
  not assigned on the app; `invalid_grant` → key/cert mismatch or `aud` ≠ login host.
