# Salesforce metadata — `Case_Note_MVP__c`

Org-custom **Case Note (MVP)** object: the mobile-app sync's write-back target for
case notes. We use this instead of the managed Lumary/Skedulo `enrtcr__Note__c`
because the **Salesforce Integration** license can't create the managed object
(`createable=false`), but **can** create org-custom objects. It mirrors the note
fields the drain uses and adds a real **External Id** (`Mobile_Outbox_Id__c`) so the
drain can upsert idempotently instead of scanning the note body.

## Contents (`mdapi/`, Metadata-API format)
- `objects/Case_Note_MVP__c.object` — object + fields:
  `Job__c` (Lookup→`sked__Job__c`), `Client__c` (Lookup→`Contact`), `Description__c`
  (Long Text 32768), `Status__c` (Draft/Completed), `Type__c` (Text), `Service_Note_Date__c`
  (Date), `Mobile_Outbox_Id__c` (Text External Id, unique), `Submitted_By_Resource__c` (Text).
- `permissionsets/Case_Note_MVP_Access.permissionset` — Create/Read/Edit + FLS for the
  integration user (no license, so assignable to the Salesforce Integration user).

## Deploy to **UAT** (needs an admin with "Customize Application")

> ✅ **Deployed 2026-06-02** to `carechoice-uat` (org `00D9p00000B60rpEAB`, AUS24S) — deploy
> `0Af9p00000XI9LBCA1`, 10/10 components. `Case Note MVP Access` assigned to the integration
> user; `npm run write:test` created `aCO9p0000000hhhGAA`. Steps below are the re-deploy runbook.

The JWT integration user can't deploy metadata, so deploy as an admin.

**sf CLI:**
```bash
sf project deploy start --metadata-dir salesforce/mdapi --target-org <UAT_ALIAS>
# verify it lands in UAT (AUS24S), not prod (AUS92)
```

**Workbench (no CLI):** zip the *contents* of `salesforce/mdapi/` (so `package.xml`
is at the zip root) → workbench.developerforce.com → **migration → Deploy** → upload.

## After deploy
1. Assign the **Case Note MVP Access** permission set to the integration user
   (Setup → Permission Sets → *Case Note MVP Access* → Manage Assignments), **or** ask
   Claude to assign it via the UAT connector (it's a custom-object perm set — no PII /
   no permission-set license involved).
2. Run the write test (proves the integration user can create notes here):
   ```bash
   cd sync
   export SF_LOGIN_URL=https://test.salesforce.com
   export SUPABASE_URL=https://xgkvdnaciymazdxxxoxu.supabase.co
   export SF_PRIVATE_KEY_PATH=./server.key
   npm run write:test          # upserts one Case_Note_MVP__c by External Id + verifies
   ```
   It links the note to an already-synced job + its client, upserts by
   `Mobile_Outbox_Id__c` (idempotent — safe to re-run), and prints only record Ids.

## Follow-up
- ✅ **Done 2026-06-02** — `drainOutbox.ts` now targets `Case_Note_MVP__c` (`SF.caseNoteMvp`)
  and upserts by the `Mobile_Outbox_Id__c` External Id (no more body-stamp scan).
  Still to verify against a real pending `job_notes` row (outbox was empty at hand-off).
