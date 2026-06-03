# Medication-Administration Drainer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drain the Supabase `medication_administrations` outbox into a new org-custom `Med_Admin_MVP__c` Salesforce object via an idempotent External-Id upsert.

**Architecture:** Mirror the already-proven `Case_Note_MVP__c` + `drainOutbox.ts` pattern. A new org-custom object (the Salesforce Integration license can't create the managed `enrtcr__Medication_Administered__c`) carries the same fields plus a `Mobile_Outbox_Id__c` External Id. A focused `drainMedAdmin.ts` reads pending rows, resolves Salesforce references, and upserts by External Id. Pure payload-building logic is unit-tested; integration is verified by dry-run + an end-to-end UAT test.

**Tech Stack:** TypeScript (ESM) run via `tsx`, `jsforce` v3, `@supabase/supabase-js` v2, Salesforce Metadata API (sf CLI v2), Node built-in test runner (`node:test`).

**Reference (proven this session):** `salesforce/mdapi/objects/Case_Note_MVP__c.object`, `salesforce/mdapi/permissionsets/Case_Note_MVP_Access.permissionset`, `sync/src/drainOutbox.ts`, `sync/src/sf-model.ts` (`SF.caseNoteMvp`, `REASON_BY_OUTCOME`). Spec: `docs/superpowers/specs/2026-06-02-med-admin-drainer-design.md`.

**Org safety:** Deploy ONLY to alias `carechoice-uat` (org `00D9p00000B60rpEAB`). NEVER `PROD` (`00D5g0000062TbVEAU`).

---

## File Structure

- **Create** `salesforce/mdapi/objects/Med_Admin_MVP__c.object` — object + 12 custom fields.
- **Create** `salesforce/mdapi/permissionsets/Med_Admin_MVP_Access.permissionset` — CRUD + FLS.
- **Modify** `salesforce/mdapi/package.xml` — add the two new members.
- **Modify** `sync/src/sf-model.ts` — add `SF.medAdminMvp`.
- **Create** `sync/src/drainMedAdmin.ts` — pure `buildMedAdminPayload()` + `drainMedAdmins()` + CLI entry.
- **Create** `sync/src/drainMedAdmin.test.ts` — unit tests for the pure mapping.
- **Modify** `sync/package.json` — add `drain:meds` and `test` scripts.
- **Modify** `salesforce/README.md`, `docs/local-dev.md` — status updates.

**Gotchas to respect (learned this session):**
- Custom fields deploy with **FLS hidden by default** → only the perm set grants access; the deploying admin won't see them in Data-API SOQL (expected).
- **Do NOT put a `required` field in the permission set's `fieldPermissions`** — Salesforce rejects FLS on universally-required fields. `Administered_At__c` is required, so it is omitted from FLS.
- The sf CLI on this Windows box intermittently splits `C:\Program Files` when `sf data query` output is piped; prefer the MCP `run_soql_query` for verification SOQL, or redirect to a file.
- `medication_administrations`' SF id column is **`salesforce_id`** (not `salesforce_note_id`).

---

## Task 1: Author the `Med_Admin_MVP__c` object metadata

**Files:**
- Create: `salesforce/mdapi/objects/Med_Admin_MVP__c.object`

- [ ] **Step 1: Create the object file**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <deploymentStatus>Deployed</deploymentStatus>
    <description>MVP medication-administration write-back target for the mobile-app sync. Mirrors the managed enrtcr__Medication_Administered__c fields the drain uses, plus an External Id for idempotent upsert. Exists because the Salesforce Integration license cannot create the managed enrtcr__Medication_Administered__c, but can write to org-custom objects.</description>
    <enableActivities>false</enableActivities>
    <enableHistory>false</enableHistory>
    <enableReports>true</enableReports>
    <label>Med Admin (MVP)</label>
    <pluralLabel>Med Admins (MVP)</pluralLabel>
    <nameField>
        <label>Med Admin Name</label>
        <type>Text</type>
    </nameField>
    <sharingModel>ReadWrite</sharingModel>
    <fields>
        <fullName>Medication__c</fullName>
        <label>Medication</label>
        <type>Lookup</type>
        <referenceTo>enrtcr__Medication__c</referenceTo>
        <relationshipLabel>Med Admins (MVP)</relationshipLabel>
        <relationshipName>Med_Admins_MVP</relationshipName>
        <deleteConstraint>SetNull</deleteConstraint>
        <required>false</required>
    </fields>
    <fields>
        <fullName>Client__c</fullName>
        <label>Client</label>
        <type>Lookup</type>
        <referenceTo>Contact</referenceTo>
        <relationshipLabel>Med Admins (MVP)</relationshipLabel>
        <relationshipName>Med_Admins_MVP</relationshipName>
        <deleteConstraint>SetNull</deleteConstraint>
        <required>false</required>
    </fields>
    <fields>
        <fullName>Job__c</fullName>
        <label>Job</label>
        <type>Lookup</type>
        <referenceTo>sked__Job__c</referenceTo>
        <relationshipLabel>Med Admins (MVP)</relationshipLabel>
        <relationshipName>Med_Admins_MVP</relationshipName>
        <deleteConstraint>SetNull</deleteConstraint>
        <required>false</required>
    </fields>
    <fields>
        <fullName>Administered__c</fullName>
        <label>Administered</label>
        <type>Checkbox</type>
        <defaultValue>false</defaultValue>
    </fields>
    <fields>
        <fullName>Reason_Not_Administered__c</fullName>
        <label>Reason Not Administered</label>
        <type>Picklist</type>
        <valueSet>
            <valueSetDefinition>
                <sorted>false</sorted>
                <value><fullName>R - Refused</fullName><default>false</default><label>R - Refused</label></value>
                <value><fullName>A - Absent</fullName><default>false</default><label>A - Absent</label></value>
                <value><fullName>F - Fasting</fullName><default>false</default><label>F - Fasting</label></value>
                <value><fullName>V - Vomiting</fullName><default>false</default><label>V - Vomiting</label></value>
                <value><fullName>L - On Leave</fullName><default>false</default><label>L - On Leave</label></value>
                <value><fullName>N - Not Available</fullName><default>false</default><label>N - Not Available</label></value>
                <value><fullName>W - Withheld</fullName><default>false</default><label>W - Withheld</label></value>
                <value><fullName>M - Missed</fullName><default>false</default><label>M - Missed</label></value>
            </valueSetDefinition>
        </valueSet>
    </fields>
    <fields>
        <fullName>Administered_At__c</fullName>
        <label>Administered At</label>
        <type>DateTime</type>
        <required>true</required>
    </fields>
    <fields>
        <fullName>Routine__c</fullName>
        <label>Routine</label>
        <type>Picklist</type>
        <valueSet>
            <valueSetDefinition>
                <sorted>false</sorted>
                <value><fullName>Breakfast</fullName><default>false</default><label>Breakfast</label></value>
                <value><fullName>Lunch</fullName><default>false</default><label>Lunch</label></value>
                <value><fullName>Dinner</fullName><default>false</default><label>Dinner</label></value>
                <value><fullName>Bed</fullName><default>false</default><label>Bed</label></value>
            </valueSetDefinition>
        </valueSet>
    </fields>
    <fields>
        <fullName>Dose_Given__c</fullName>
        <label>Dose Given</label>
        <type>Text</type>
        <length>255</length>
    </fields>
    <fields>
        <fullName>Comments__c</fullName>
        <label>Comments</label>
        <type>LongTextArea</type>
        <length>32768</length>
        <visibleLines>5</visibleLines>
    </fields>
    <fields>
        <fullName>Witness__c</fullName>
        <label>Witness</label>
        <type>Text</type>
        <length>255</length>
    </fields>
    <fields>
        <fullName>Submitted_By_Resource__c</fullName>
        <label>Submitted By (Resource)</label>
        <type>Text</type>
        <length>255</length>
    </fields>
    <fields>
        <fullName>Mobile_Outbox_Id__c</fullName>
        <label>Mobile Outbox Id</label>
        <type>Text</type>
        <length>36</length>
        <externalId>true</externalId>
        <unique>true</unique>
        <caseSensitive>false</caseSensitive>
        <required>false</required>
    </fields>
</CustomObject>
```

- [ ] **Step 2: Commit**

```bash
git add salesforce/mdapi/objects/Med_Admin_MVP__c.object
git commit -m "feat(salesforce): add Med_Admin_MVP__c object metadata"
```

---

## Task 2: Author the `Med_Admin_MVP_Access` permission set

**Files:**
- Create: `salesforce/mdapi/permissionsets/Med_Admin_MVP_Access.permissionset`

Note: `Administered_At__c` is **required** → it is intentionally omitted from `fieldPermissions` (Salesforce rejects FLS on required fields). All other custom fields get read+edit.

- [ ] **Step 1: Create the permission set file**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Med Admin MVP Access</label>
    <description>Create/Read/Edit on Med_Admin_MVP__c + FLS, for the mobile-app sync integration user. No license (custom object) so it is assignable to the Salesforce Integration user.</description>
    <hasActivationRequired>false</hasActivationRequired>
    <objectPermissions>
        <object>Med_Admin_MVP__c</object>
        <allowCreate>true</allowCreate>
        <allowRead>true</allowRead>
        <allowEdit>true</allowEdit>
        <allowDelete>false</allowDelete>
        <viewAllRecords>true</viewAllRecords>
        <modifyAllRecords>false</modifyAllRecords>
    </objectPermissions>
    <fieldPermissions><field>Med_Admin_MVP__c.Medication__c</field><readable>true</readable><editable>true</editable></fieldPermissions>
    <fieldPermissions><field>Med_Admin_MVP__c.Client__c</field><readable>true</readable><editable>true</editable></fieldPermissions>
    <fieldPermissions><field>Med_Admin_MVP__c.Job__c</field><readable>true</readable><editable>true</editable></fieldPermissions>
    <fieldPermissions><field>Med_Admin_MVP__c.Administered__c</field><readable>true</readable><editable>true</editable></fieldPermissions>
    <fieldPermissions><field>Med_Admin_MVP__c.Reason_Not_Administered__c</field><readable>true</readable><editable>true</editable></fieldPermissions>
    <fieldPermissions><field>Med_Admin_MVP__c.Routine__c</field><readable>true</readable><editable>true</editable></fieldPermissions>
    <fieldPermissions><field>Med_Admin_MVP__c.Dose_Given__c</field><readable>true</readable><editable>true</editable></fieldPermissions>
    <fieldPermissions><field>Med_Admin_MVP__c.Comments__c</field><readable>true</readable><editable>true</editable></fieldPermissions>
    <fieldPermissions><field>Med_Admin_MVP__c.Witness__c</field><readable>true</readable><editable>true</editable></fieldPermissions>
    <fieldPermissions><field>Med_Admin_MVP__c.Submitted_By_Resource__c</field><readable>true</readable><editable>true</editable></fieldPermissions>
    <fieldPermissions><field>Med_Admin_MVP__c.Mobile_Outbox_Id__c</field><readable>true</readable><editable>true</editable></fieldPermissions>
</PermissionSet>
```

- [ ] **Step 2: Commit**

```bash
git add salesforce/mdapi/permissionsets/Med_Admin_MVP_Access.permissionset
git commit -m "feat(salesforce): add Med_Admin_MVP_Access permission set"
```

---

## Task 3: Add both components to the deploy manifest

**Files:**
- Modify: `salesforce/mdapi/package.xml`

- [ ] **Step 1: Add the new members**

Replace the file contents with:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
        <members>Case_Note_MVP__c</members>
        <members>Med_Admin_MVP__c</members>
        <name>CustomObject</name>
    </types>
    <types>
        <members>Case_Note_MVP_Access</members>
        <members>Med_Admin_MVP_Access</members>
        <name>PermissionSet</name>
    </types>
    <version>64.0</version>
</Package>
```

(Re-deploying the existing `Case_Note_MVP__c` components is harmless — identical metadata.)

- [ ] **Step 2: Commit**

```bash
git add salesforce/mdapi/package.xml
git commit -m "chore(salesforce): add Med_Admin_MVP components to package.xml"
```

---

## Task 4: Validate the deploy (dry-run, no commit)

- [ ] **Step 1: Dry-run validate against UAT**

Run (from repo root):
```bash
sf project deploy start --metadata-dir salesforce/mdapi --target-org carechoice-uat --dry-run --json > "$TEMP/maddry.json" 2>/dev/null; node -e "const j=require('fs').readFileSync(process.env.TEMP+'/maddry.json','utf8');const r=JSON.parse(j.slice(j.indexOf('{'))).result;console.log('status',r.status,'errors',r.numberComponentErrors,'target',r.createdByName)"
```
Expected: `status Succeeded errors 0 target <admin name>`. If any `componentFailures`, fix the metadata before proceeding (do NOT continue to Task 5).

---

## Task 5: Deploy for real + assign the permission set (USER action)

- [ ] **Step 1: Deploy to UAT**

```bash
sf project deploy start --metadata-dir salesforce/mdapi --target-org carechoice-uat --json > "$TEMP/maddep.json" 2>/dev/null; node -e "const j=require('fs').readFileSync(process.env.TEMP+'/maddep.json','utf8');const r=JSON.parse(j.slice(j.indexOf('{'))).result;console.log('status',r.status,'errors',r.numberComponentErrors,'id',r.id)"
```
Expected: `status Succeeded errors 0 id 0Af...`.

- [ ] **Step 2: USER assigns the permission set**

The auto-mode classifier blocks agent-driven permission grants on the shared org. Ask the user to run ONE of:
```bash
sf org assign permset --name Med_Admin_MVP_Access --on-behalf-of svc-mvp-sync@carechoice.com.au --target-org carechoice-uat
```
…or Setup → Permission Sets → **Med Admin MVP Access** → Manage Assignments → add `svc-mvp-sync@carechoice.com.au`.

- [ ] **Step 3: Verify assignment (read-only)**

Use the MCP connector (avoids the CLI pipe bug):
`run_soql_query` on `carechoice-uat`:
```sql
SELECT Id, AssigneeId FROM PermissionSetAssignment WHERE PermissionSet.Name = 'Med_Admin_MVP_Access'
```
Expected: one row with `AssigneeId = 0059p00000SbMvtAAF` (the integration user). Do not proceed to the end-to-end test until this returns a row.

---

## Task 6: Add the `SF.medAdminMvp` model

**Files:**
- Modify: `sync/src/sf-model.ts` (insert before the closing `} as const;`, after the `caseNoteMvp` block)

- [ ] **Step 1: Add the model block**

```ts
  // Org-custom MVP write-back target for medication administrations (NOT the
  // managed enrtcr__Medication_Administered__c, which the Integration license
  // cannot create). Mirrors the managed shape + an External Id for idempotent upsert.
  medAdminMvp: {
    object: 'Med_Admin_MVP__c',
    name: 'Name',
    medication: 'Medication__c', // → enrtcr__Medication__c (Lookup)
    client: 'Client__c', // → Contact
    job: 'Job__c', // → sked__Job__c
    administered: 'Administered__c', // checkbox; true when outcome === 'given'
    reasonNotAdministered: 'Reason_Not_Administered__c', // REASON_BY_OUTCOME value
    administeredAt: 'Administered_At__c', // required datetime
    routine: 'Routine__c', // Breakfast|Lunch|Dinner|Bed
    doseGiven: 'Dose_Given__c',
    comments: 'Comments__c',
    witness: 'Witness__c',
    submittedByResource: 'Submitted_By_Resource__c',
    outboxId: 'Mobile_Outbox_Id__c', // External Id (unique) — idempotent upsert key
  },
```

- [ ] **Step 2: Typecheck**

Run: `cd sync && npx tsc --noEmit`
Expected: no NEW errors mentioning `sf-model.ts` (pre-existing `jsforce` namespace / implicit-any errors in `clients.ts`/`poc.ts`/`syncRead.ts` are unrelated and acceptable).

- [ ] **Step 3: Commit**

```bash
git add sync/src/sf-model.ts
git commit -m "feat(sync): add SF.medAdminMvp model"
```

---

## Task 7: Write the failing unit test for `buildMedAdminPayload`

**Files:**
- Create: `sync/src/drainMedAdmin.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMedAdminPayload } from './drainMedAdmin.js';

const base = {
  id: 'abc-123-uuid',
  routine: 'Breakfast' as string | null,
  dose_given: '5mg' as string | null,
  administered_at: '2026-06-02T08:00:00.000Z',
  comments: 'note' as string | null,
  witness: 'RN Jo' as string | null,
  medication_sf_id: 'a0xMED000000001',
  client_sf_id: '0035g00000c6xZEAAY' as string | null,
  job_sf_id: 'a2Z9p000001dUfBEAU' as string | null,
  resource_id: 'a2sI80000000UtHIAU' as string | null,
};

test('given → Administered__c true, reason null, key fields mapped', () => {
  const p = buildMedAdminPayload({ ...base, outcome: 'given' });
  assert.equal(p.Administered__c, true);
  assert.equal(p.Reason_Not_Administered__c, null);
  assert.equal(p.Mobile_Outbox_Id__c, 'abc-123-uuid');
  assert.equal(p.Medication__c, 'a0xMED000000001');
  assert.equal(p.Administered_At__c, '2026-06-02T08:00:00.000Z');
  assert.equal(p.Submitted_By_Resource__c, 'a2sI80000000UtHIAU');
});

test('refused → Administered__c false, mapped reason', () => {
  const p = buildMedAdminPayload({ ...base, outcome: 'refused' });
  assert.equal(p.Administered__c, false);
  assert.equal(p.Reason_Not_Administered__c, 'R - Refused');
});

test('every non-given outcome maps to a non-empty reason', () => {
  for (const o of ['refused', 'withheld', 'not_available', 'absent', 'fasting', 'vomiting', 'on_leave', 'missed']) {
    const p = buildMedAdminPayload({ ...base, outcome: o });
    assert.equal(p.Administered__c, false, `${o} should be not-administered`);
    assert.ok(p.Reason_Not_Administered__c, `expected a reason for ${o}`);
  }
});

test('null optional fields are omitted (undefined), not sent as null', () => {
  const p = buildMedAdminPayload({ ...base, outcome: 'given', client_sf_id: null, job_sf_id: null, routine: null, dose_given: null, comments: null, witness: null, resource_id: null });
  assert.equal('Client__c' in p && p.Client__c === undefined, true);
  assert.equal(p.Job__c, undefined);
  assert.equal(p.Routine__c, undefined);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd sync && node --import tsx --test src/drainMedAdmin.test.ts`
Expected: FAIL — cannot resolve `./drainMedAdmin.js` / `buildMedAdminPayload` is not exported (file doesn't exist yet).

---

## Task 8: Implement the pure `buildMedAdminPayload` + create `drainMedAdmin.ts`

**Files:**
- Create: `sync/src/drainMedAdmin.ts`

- [ ] **Step 1: Create the file with the pure function and a placeholder drainer**

```ts
// WRITE PATH: drain the medication_administrations outbox into Med_Admin_MVP__c
// (org-custom) as the integration user. Idempotent via an External-Id upsert on
// Mobile_Outbox_Id__c (the Supabase row UUID). Targets the org-custom object because
// the Salesforce Integration license cannot create the managed
// enrtcr__Medication_Administered__c (see salesforce/README.md).
import { pathToFileURL } from 'node:url';
import { SF, REASON_BY_OUTCOME } from './sf-model.js';
import { sfConnect, supabaseAdmin, env } from './clients.js';

const n = SF.medAdminMvp;

export interface MedAdminRow {
  id: string;
  outcome: string;
  routine: string | null;
  dose_given: string | null;
  administered_at: string;
  comments: string | null;
  witness: string | null;
  medication_sf_id: string;
  client_sf_id: string | null;
  job_sf_id: string | null;
  resource_id: string | null;
}

// Pure: build the Med_Admin_MVP__c upsert payload from a resolved outbox row.
// Optional fields are left `undefined` so jsforce omits them from the request.
export function buildMedAdminPayload(row: MedAdminRow): Record<string, unknown> {
  const given = row.outcome === 'given';
  return {
    [n.name]: `Med admin — ${row.medication_sf_id}`,
    [n.medication]: row.medication_sf_id,
    [n.client]: row.client_sf_id ?? undefined,
    [n.job]: row.job_sf_id ?? undefined,
    [n.administered]: given,
    [n.reasonNotAdministered]: given ? null : (REASON_BY_OUTCOME[row.outcome] ?? null),
    [n.administeredAt]: row.administered_at,
    [n.routine]: row.routine ?? undefined,
    [n.doseGiven]: row.dose_given ?? undefined,
    [n.comments]: row.comments ?? undefined,
    [n.witness]: row.witness ?? undefined,
    [n.submittedByResource]: row.resource_id ?? undefined,
    [n.outboxId]: row.id,
  };
}

export async function drainMedAdmins(): Promise<void> {
  throw new Error('not implemented yet');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  drainMedAdmins().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Run the unit tests to confirm they pass**

Run: `cd sync && node --import tsx --test src/drainMedAdmin.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 3: Commit**

```bash
git add sync/src/drainMedAdmin.ts sync/src/drainMedAdmin.test.ts
git commit -m "feat(sync): add buildMedAdminPayload with unit tests"
```

---

## Task 9: Implement `drainMedAdmins()` (Supabase read → resolve refs → upsert)

**Files:**
- Modify: `sync/src/drainMedAdmin.ts` (replace the `drainMedAdmins` placeholder)

- [ ] **Step 1: Replace the placeholder with the real implementation**

```ts
export async function drainMedAdmins(): Promise<void> {
  const db = supabaseAdmin();
  const conn = await sfConnect();

  // 1. Claim a batch of pending administrations + the SF ids they need.
  const { data: rows, error } = await db
    .from('medication_administrations')
    .select(
      'id, outcome, routine, dose_given, administered_at, comments, witness, attempts, job_id, administered_by, ' +
        'medications!inner(salesforce_id, client_sf_id), jobs(salesforce_id, resource_id)',
    )
    .eq('status', 'pending')
    .limit(50);
  if (error) throw error;
  if (!rows?.length) {
    console.log('No pending administrations.');
    return;
  }

  // 2. Resolve the Resource id: prefer the linked job's resource_id; otherwise the
  //    author's profile (administered_by -> profiles.salesforce_resource_id). The FK
  //    points at auth.users, so the profile lookup is a separate batched query.
  const needProfile = (rows as any[]).filter((r) => !r.jobs?.resource_id).map((r) => r.administered_by);
  const profileResource = new Map<string, string>();
  if (needProfile.length) {
    const { data: profs, error: pe } = await db
      .from('profiles')
      .select('id, salesforce_resource_id')
      .in('id', [...new Set(needProfile)]);
    if (pe) throw pe;
    for (const p of (profs ?? []) as any[]) profileResource.set(p.id, p.salesforce_resource_id);
  }

  for (const r of rows as any[]) {
    const med = r.medications;
    const payload = buildMedAdminPayload({
      id: r.id,
      outcome: r.outcome,
      routine: r.routine,
      dose_given: r.dose_given,
      administered_at: r.administered_at,
      comments: r.comments,
      witness: r.witness,
      medication_sf_id: med.salesforce_id,
      client_sf_id: med.client_sf_id ?? null,
      job_sf_id: r.jobs?.salesforce_id ?? null,
      resource_id: r.jobs?.resource_id ?? profileResource.get(r.administered_by) ?? null,
    });

    if (env.dryRun) {
      console.log(`[dry-run] would upsert ${n.object} by ${n.outboxId}=${r.id}:`, payload);
      continue;
    }

    await db.from('medication_administrations').update({ status: 'syncing', attempts: (r.attempts ?? 0) + 1 }).eq('id', r.id);
    try {
      // Idempotent External-Id upsert on Mobile_Outbox_Id__c: insert if new, update if
      // already drained — no duplicate administrations.
      const res: any = await conn.sobject(n.object).upsert(payload, n.outboxId);
      const sfId = res?.id ?? res?.Id;
      await db.from('medication_administrations')
        .update({ status: 'synced', salesforce_id: sfId, synced_at: new Date().toISOString() })
        .eq('id', r.id);
      console.log(`Admin ${r.id} -> ${n.object} ${sfId} (created=${res?.created})`);
    } catch (e: any) {
      await db.from('medication_administrations').update({ status: 'error', last_error: String(e?.message ?? e) }).eq('id', r.id);
      console.error(`Admin ${r.id} failed:`, e?.message ?? e);
    }
  }
}
```

- [ ] **Step 2: Typecheck + re-run unit tests**

Run: `cd sync && npx tsc --noEmit && node --import tsx --test src/drainMedAdmin.test.ts`
Expected: no new `drainMedAdmin.ts` type errors; 4 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add sync/src/drainMedAdmin.ts
git commit -m "feat(sync): implement drainMedAdmins (External-Id upsert into Med_Admin_MVP__c)"
```

---

## Task 10: Add npm scripts

**Files:**
- Modify: `sync/package.json`

- [ ] **Step 1: Add `drain:meds` and `test` to the scripts block**

The scripts block becomes:
```json
  "scripts": {
    "poc": "tsx --env-file-if-exists=.env src/poc.ts",
    "sync:read": "tsx --env-file-if-exists=.env src/syncRead.ts",
    "drain": "tsx --env-file-if-exists=.env src/drainOutbox.ts",
    "drain:meds": "tsx --env-file-if-exists=.env src/drainMedAdmin.ts",
    "write:test": "tsx --env-file-if-exists=.env src/writeTestCaseNote.ts",
    "test": "node --import tsx --test src/drainMedAdmin.test.ts"
  },
```

- [ ] **Step 2: Verify the test script runs**

Run: `cd sync && npm test`
Expected: 4 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add sync/package.json
git commit -m "chore(sync): add drain:meds and test npm scripts"
```

---

## Task 11: Dry-run the drainer

- [ ] **Step 1: Dry-run (no write)**

Run: `cd sync && DRY_RUN=1 npm run drain:meds`
Expected: either `No pending administrations.` (outbox empty) or one or more `[dry-run] would upsert Med_Admin_MVP__c by Mobile_Outbox_Id__c=<uuid>: { … }` payloads with `Administered__c`, `Administered_At__c`, `Medication__c` populated. Exit 0. (No commit.)

---

## Task 12: End-to-end UAT test (seed → drain → idempotency → cleanup)

**Files:**
- Create (temporary, deleted in Step 6): `sync/src/_e2eMed.ts`

- [ ] **Step 1: Create the temp helper**

```ts
// TEMP e2e helper (delete after) — seed/verify/reset/cleanup a medication_administrations
// outbox row. Selects only opaque ids (no PII).
// Run: npx tsx --env-file-if-exists=.env src/_e2eMed.ts <seed|verify|reset|cleanup> [id]
import { supabaseAdmin } from './clients.js';

const mode = process.argv[2];
const arg = process.argv[3];

async function seed() {
  const db = supabaseAdmin();
  const { data: meds, error: me } = await db.from('medications').select('id, salesforce_id, client_sf_id').limit(1);
  if (me) throw me;
  if (!meds?.length) throw new Error('no medications — run sync:read first');
  const { data: profs, error: pe } = await db.from('profiles').select('id').limit(1);
  if (pe) throw pe;
  if (!profs?.length) throw new Error('no profile for administered_by');
  const { data: ins, error: ie } = await db
    .from('medication_administrations')
    .insert({
      medication_id: (meds[0] as any).id,
      administered_by: (profs[0] as any).id,
      outcome: 'given',
      routine: 'Breakfast',
      dose_given: '5mg',
      administered_at: '2026-06-02T08:00:00.000Z',
      comments: 'E2E med-admin test — safe to delete.',
      status: 'pending',
    })
    .select('id')
    .single();
  if (ie) throw ie;
  console.log(`SEEDED admin=${(ins as any).id} med=${(meds[0] as any).salesforce_id}`);
}

async function verify() {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from('medication_administrations')
    .select('id, status, salesforce_id, attempts, last_error')
    .eq('id', arg)
    .single();
  if (error) throw error;
  console.log('row:', JSON.stringify(data));
}

async function reset() {
  const db = supabaseAdmin();
  const { error } = await db
    .from('medication_administrations')
    .update({ status: 'pending', salesforce_id: null, synced_at: null })
    .eq('id', arg);
  if (error) throw error;
  console.log(`RESET ${arg} -> pending`);
}

async function cleanup() {
  const db = supabaseAdmin();
  const { error } = await db.from('medication_administrations').delete().eq('id', arg);
  if (error) throw error;
  console.log(`DELETED ${arg}`);
}

const run = mode === 'seed' ? seed : mode === 'verify' ? verify : mode === 'reset' ? reset : mode === 'cleanup' ? cleanup : null;
if (!run) { console.error('usage: _e2eMed.ts <seed|verify|reset|cleanup> [id]'); process.exit(1); }
run().catch((e) => { console.error('E2E ERR:', e?.message ?? e); process.exit(1); });
```

- [ ] **Step 2: Seed + first drain**

```bash
cd sync
npx tsx --env-file-if-exists=.env src/_e2eMed.ts seed     # prints SEEDED admin=<id>
DRY_RUN=0 npm run drain:meds                              # expect: Admin <id> -> Med_Admin_MVP__c <sfId> (created=true)
npx tsx --env-file-if-exists=.env src/_e2eMed.ts verify <id>   # expect status=synced, salesforce_id=<sfId>
```
Expected: `created=true`; row `status=synced` with `salesforce_id` set.

- [ ] **Step 3: Confirm the SF record (MCP, read-only)**

`run_soql_query` on `carechoice-uat` (admin can read Id/Name; custom fields are FLS-hidden from admin, which is fine):
```sql
SELECT Id, Name FROM Med_Admin_MVP__c WHERE Id = '<sfId>'
```
Expected: 1 row, `Name` = `Med admin — <medication salesforce_id>`.

- [ ] **Step 4: Idempotency — reset + re-drain**

```bash
npx tsx --env-file-if-exists=.env src/_e2eMed.ts reset <id>
DRY_RUN=0 npm run drain:meds      # expect: Admin <id> -> Med_Admin_MVP__c <SAME sfId> (created=false)
```
Expected: `created=false`, **same** `<sfId>` → no duplicate.

- [ ] **Step 5: Clean up the seeded row**

```bash
npx tsx --env-file-if-exists=.env src/_e2eMed.ts cleanup <id>   # prints DELETED <id>
```

- [ ] **Step 6: Delete the temp helper**

```bash
rm -f sync/src/_e2eMed.ts
git status --short   # expect: no _e2eMed.ts; working tree clean of temp files
```

---

## Task 13: Update docs

**Files:**
- Modify: `docs/local-dev.md` (§7 backlog item 3)
- Modify: `salesforce/README.md`

- [ ] **Step 1: Mark backlog §7.3 done in `docs/local-dev.md`**

Replace:
```markdown
3. Add a `medication_administrations` drainer (not built; those rows stay `pending`).
```
with:
```markdown
3. ✅ **Done 2026-06-02** — `medication_administrations` drainer (`npm run drain:meds`) upserts
   into org-custom `Med_Admin_MVP__c` by `Mobile_Outbox_Id__c`; deployed to UAT + verified e2e.
```

- [ ] **Step 2: Append a note to `salesforce/README.md`**

After the `Case_Note_MVP__c` "Follow-up" section, add:
```markdown

## Med_Admin_MVP__c (medication administrations)
Same pattern as `Case_Note_MVP__c`: org-custom write-back target (the Integration license can't
create the managed `enrtcr__Medication_Administered__c`), with `Mobile_Outbox_Id__c` External Id.
Deployed to UAT 2026-06-02; `Med_Admin_MVP_Access` assigned to the integration user; drained by
`sync/src/drainMedAdmin.ts` (`npm run drain:meds`).
```

- [ ] **Step 3: Commit**

```bash
git add docs/local-dev.md salesforce/README.md
git commit -m "docs: record Med_Admin_MVP__c + med-admin drainer"
```

---

## Done-When
- `Med_Admin_MVP__c` + `Med_Admin_MVP_Access` deployed to `carechoice-uat`; perm set on the integration user.
- `npm test` passes (4 unit tests); `tsc` introduces no new errors.
- End-to-end: a seeded `medication_administrations` row drains to a `Med_Admin_MVP__c` record (`created=true`), flips to `synced`, and re-drains idempotently (`created=false`, same Id).
- Docs updated; temp helper removed; working tree clean.
