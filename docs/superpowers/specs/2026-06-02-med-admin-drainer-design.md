# Design — Medication-administration outbox drainer

**Date:** 2026-06-02
**Status:** Approved (brainstorming) — pending implementation plan
**Backlog ref:** `docs/local-dev.md` §7.3 ("add a `medication_administrations` drainer")

## 1. Problem & context

The Supabase `public.medication_administrations` outbox captures med-admin events on
the device, but nothing pushes them to Salesforce — rows stay `pending`. The natural
target, the managed `enrtcr__Medication_Administered__c`, has the same blocker we hit
for notes: the **Salesforce Integration license can't create managed `enrtcr__`
objects**, and (per `architecture.md` §11.4) it has **no External Id** and a
Master-Detail to `enrtcr__Medication__c`.

We solve it the same way we solved notes: an **org-custom `Med_Admin_MVP__c`** object
the Integration user *can* create, with a real External Id for idempotent upsert,
drained by a small service that mirrors `drainOutbox.ts`.

## 2. Decisions (from brainstorming)

1. **Write target:** new org-custom `Med_Admin_MVP__c` (not the managed object).
2. **Outcome model:** mirror the managed shape — `Administered__c` (checkbox) +
   `Reason_Not_Administered__c` (picklist, verbatim values) — so a future cutover to
   the managed object is near-drop-in. Uses the existing `REASON_BY_OUTCOME` map.
3. **Idempotency:** External-Id upsert on `Mobile_Outbox_Id__c` = the outbox row UUID.

## 3. Salesforce metadata

### 3.1 Object `Med_Admin_MVP__c`
Lookup-based (org-custom objects can't Master-Detail to a managed object), mirroring
`Case_Note_MVP__c`. `Name` is a Text name set by the drain (e.g. `Med admin — <med sf id>`).

| Field | Type | Notes / source |
|---|---|---|
| `Medication__c` | Lookup → `enrtcr__Medication__c` | from `medications.salesforce_id` (via `medication_id`) |
| `Client__c` | Lookup → `Contact` | from `medications.client_sf_id` |
| `Job__c` | Lookup → `sked__Job__c` | from `jobs.salesforce_id` (via `job_id`; nullable) |
| `Administered__c` | Checkbox | `outcome === 'given'` |
| `Reason_Not_Administered__c` | Picklist | `R - Refused; A - Absent; F - Fasting; V - Vomiting; L - On Leave; N - Not Available; W - Withheld; M - Missed` (verbatim) |
| `Administered_At__c` | DateTime (required) | `administered_at` |
| `Routine__c` | Picklist | `Breakfast; Lunch; Dinner; Bed` (nullable) |
| `Dose_Given__c` | Text(255) | `dose_given` |
| `Comments__c` | Long Text Area (32768) | `comments` |
| `Witness__c` | Text(255) | `witness` |
| `Submitted_By_Resource__c` | Text(255) | resolved Resource id (see §4.2) |
| `Mobile_Outbox_Id__c` | Text(36), **External Id, Unique, case-insensitive** | `medication_administrations.id` (UUID) |

### 3.2 Permission set `Med_Admin_MVP_Access`
Same shape as `Case_Note_MVP_Access`: object Create/Read/Edit (+ `viewAllRecords`,
`allowDelete=false`) and FLS read/edit on every custom field above. No license tied.

### 3.3 Deploy
Add `salesforce/mdapi/objects/Med_Admin_MVP__c.object` +
`permissionsets/Med_Admin_MVP_Access.permissionset`; add both members to
`salesforce/mdapi/package.xml`. Validate with `--dry-run` then deploy to
`carechoice-uat` (org `00D9p00000B60rpEAB`, **never** prod `00D5g0000062TbVEAU`).
Assigning the perm set to the integration user is done by the **user** (UI or CLI) —
the auto-mode classifier blocks agent-driven permission grants on the shared org.

## 4. Sync service

### 4.1 Model
Add `SF.medAdminMvp` to `sync/src/sf-model.ts` (object + the field API names above).
Reuse the existing `REASON_BY_OUTCOME` map. Leave `SF.medAdministered` (managed) in
place for the eventual new-org cutover.

### 4.2 Drainer — `sync/src/drainMedAdmin.ts`
New focused file exporting `drainMedAdmins()`, plus npm script
`"drain:meds": "tsx --env-file-if-exists=.env src/drainMedAdmin.ts"`. Cross-platform
entry guard (`pathToFileURL(process.argv[1]).href`), like the other entry points.

Flow per batch (mirrors `drainNotes()`):
1. `supabaseAdmin()` + `sfConnect()`.
2. Select `medication_administrations` where `status='pending'` (limit 50), joining
   `medications!inner(salesforce_id, client_sf_id)` (must have a med) and
   `jobs(salesforce_id, resource_id)` (left join via nullable `job_id`).
3. **Resolve Resource id** for `Submitted_By_Resource__c`: prefer the linked job's
   `resource_id`; if absent, look up `profiles.salesforce_resource_id` by
   `administered_by` (batched query keyed on distinct `administered_by`, since the FK
   points at `auth.users`, not `profiles` directly).
4. Build payload from §3.1 mapping; `Administered__c = outcome==='given'`,
   `Reason_Not_Administered__c = REASON_BY_OUTCOME[outcome]` (null when given).
5. `DRY_RUN=1`: log the intended upsert + continue (no write).
6. Else: set row `status='syncing'`, `attempts+1`; `conn.sobject(Med_Admin_MVP__c)
   .upsert(payload, 'Mobile_Outbox_Id__c')`; on success set `status='synced'`,
   **`salesforce_id`** (this table's column — not `salesforce_note_id`), `synced_at`;
   on failure set `status='error'`, `last_error`.

## 5. Idempotency
External-Id upsert on `Mobile_Outbox_Id__c` → insert-or-update, never duplicates.
A reset+re-drain of the same row must return `created=false` with the same record Id.

## 6. Verification
1. `tsc` clean for the new file; `DRY_RUN=1 npm run drain:meds` runs (likely
   `No pending administrations.` if the outbox is empty).
2. End-to-end (temp helper, mirrors the note test): seed one pending
   `medication_administrations` row (valid `medication_id`, `administered_by`,
   `administered_at`) → `DRY_RUN=0 npm run drain:meds` → assert `Med_Admin_MVP__c`
   created + row `synced` with `salesforce_id` → reset + re-drain asserts
   `created=false` (no duplicate) → delete seeded row + temp helper.

## 7. Out of scope (YAGNI)
- Chart re-validation at drain time (Status=Active / date window) — that's an
  app-capture-time concern (§5.4), not the drainer's responsibility.
- Write-path scheduling / CDC (separate backlog item §7.4).
- Deleting leftover UAT test records (integration user can't; `allowDelete=false`).
- Refactoring shared drain helpers out of `drainOutbox.ts` / `drainMedAdmin.ts`
  (revisit only if a third drainer appears).

## 8. Files touched
- **New:** `salesforce/mdapi/objects/Med_Admin_MVP__c.object`,
  `salesforce/mdapi/permissionsets/Med_Admin_MVP_Access.permissionset`,
  `sync/src/drainMedAdmin.ts`, this spec.
- **Edited:** `salesforce/mdapi/package.xml`, `sync/src/sf-model.ts`,
  `sync/package.json` (script), `salesforce/README.md` + `docs/local-dev.md` (status).

## 9. Open / flagged
- **Resource resolution** (§4.2) is the only fuzzy part; the job-first / profile-fallback
  default is approved. Confirm the `profiles` fallback query shape during implementation.
