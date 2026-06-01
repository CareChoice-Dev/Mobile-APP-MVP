# Project Summary / Handoff — CareChoice Mobile MVP

A self-contained brief of what we're building and why, so it can be picked up in
a fresh conversation without re-explaining. Full detail lives in
[`architecture.md`](architecture.md); this is the orientation layer.

Repo branch: `claude/stoic-goldberg-BuIti`.

## 1. What we're building

A **React Native (Expo) mobile app** for CareChoice **support workers**:

- Workers **log in via Supabase** (email/password). They have **no Salesforce
  login** — a single Salesforce **integration user** does all Salesforce I/O,
  server-side.
- Workers **see their jobs/visits** (synced from Salesforce) and the relevant
  **client's medication chart**.
- Workers **write back**: **case notes** attached to a job, and **medication
  administration** records.

## 2. Key architectural decisions

- **Supabase = system of engagement** (a fast, access-controlled, offline-
  friendly operational *copy*). **Salesforce = system of record.** Mirror only
  the working set, not the whole org.
- **Reads and writes are separate, asymmetric pipes** (never one bidirectional
  sync):
  - **Read:** Salesforce → Supabase mirror. Poll every 2–5 min for the MVP;
    move to **CDC (Change Data Capture) push** for near-real-time later. Bulk
    delta queries keep API usage tiny.
  - **Write:** app → Supabase **outbox** table → Salesforce, pushed by the
    integration user. **Append-only + idempotent.**
- **Per-user authorization = Postgres RLS.** The only thing scoping a worker to
  their own data. The anon key is public by design; RLS is the boundary.
- **The per-user mapping anchor is a Salesforce `sked__Resource__c` Id**, stored
  on the Supabase profile (`salesforce_resource_id`). The worker is NOT a field
  on the Job — it's reached via the `sked__Job_Allocation__c` junction.
- **AI assistant: Agentforce** is the recommended fit (grounded Q&A on SF data +
  native actions, invoked headlessly via the Agent API by the integration
  identity; per-invocation data scoping is mandatory). External-model path kept
  open; governance trade-off (Einstein Trust Layer vs. cost/control) undecided.
- **Compliance/residency:** HIPAA is US law and doesn't bind an AU provider —
  the real requirements are the **Privacy Act / Australian Privacy Principles**
  + **AU data residency** (Sydney). Supabase supports this (Team plan + BAA +
  Sydney region), and the whole design is plain Postgres + RLS, so it ports to
  **self-hosted Supabase in an AU region** or any managed Postgres if needed.

## 3. The current-org vs new-org distinction (important)

- The **current** org (where workers *do* have Salesforce `User`s, linked from
  `sked__Resource__c.sked__User__c`) is what we inspected and proved against.
- The **target is a new org where workers have NO Salesforce login**. For the
  MVP we simulate that on the current org by **ignoring `sked__User__c`** and
  treating the Resource Id as an opaque key, mapped manually to a Supabase user.
- New-org green-field affordances to add (see architecture §11.6): an **External
  Id on `sked__Resource__c`** for the mapping, **External Id fields on the
  write-back objects** for clean idempotent upserts, and a **writable
  attribution field** (current org's `Created_by_Name__c` is read-only).

## 4. Verified against the live UAT org (`CareChoice`, `AUS24S`, sandbox)

Managed packages: **Skedulo** (`sked__`, `skedhealthcare__`) + a care-management
package (`enrtcr__`).

| Concept | Salesforce object | Notes |
|---|---|---|
| Job/visit | `sked__Job__c` | |
| Worker↔job assignment | `sked__Job_Allocation__c` | junction; Master-Detail to both Job and Resource |
| Worker | `sked__Resource__c` | `sked__User__c → User` (current org only) |
| Client | `Contact` | on job via `sked__Contact__c`; on med via `Client__c` |
| Case note | `enrtcr__Note__c` | links: `skedhealthcare__Job__c`, `enrtcr__Client__c`; body = `enrtcr__Description__c` |
| Medication chart | `enrtcr__Medication__c` | `Status__c` Active/Closed |
| Medication admin | `enrtcr__Medication_Administered__c` | MD to Medication; worker on `Person_Administering__c → sked__Resource__c` |

**Proven end-to-end loop:** given only Resource `a2sI80000000HFPIA2` → fetched 8
jobs → fetched the client's medication chart → created `enrtcr__Note__c`
(`a0x9p000002XGhZAAW`) linked to the job + client, attributed to the Resource in
the body (no User) → read it back. (No personal fields were queried.)

> ⚠️ That test note (`a0x9p000002XGhZAAW`, status Draft, "Safe to delete") is
> still in UAT — delete it when convenient.

## 5. What's been built (committed)

| Path | What |
|---|---|
| `docs/architecture.md` | Full architecture + UAT-verified mapping (§11) + open questions (§8) |
| `supabase/schema.sql` | Tables (`profiles`, `jobs`, `medications`, `job_notes`, `medication_administrations`) + RLS + `current_resource_id()` |
| `sync/` | Integration/sync PoC (TypeScript, jsforce + supabase-js): `syncRead.ts`, `drainOutbox.ts`, runnable `poc.ts`, verified field constants in `sf-model.ts` |
| `app/` | Expo app: auth, "My Jobs" list, job detail (+ client meds), add-note, record-administration |
| `README.md` | Project overview + quick start |

## 6. Where we are / next steps

- **In progress:** deploying `supabase/schema.sql` to the Supabase project (free
  tier, Sydney region). Blocked on providing a DB connection string as the
  `SUPABASE_DB_URL` environment variable so `psql` can apply it; SQL Editor
  copy/paste is the fallback.
- **After deploy:** seed one `profiles` row mapping a test auth user → Resource
  `a2sI80000000HFPIA2`, then verify RLS scoping; wire `.env` for `sync/` and
  `app/`; run `npm run poc`; launch the Expo app.
- **Open questions before production** (architecture §8): worker **onboarding/
  provisioning** (how the Resource Id lands on the profile with no SF login —
  the main gap), freshness SLA, volume, CDC + Agentforce licensing, and the
  new-org External Id / attribution fields.
