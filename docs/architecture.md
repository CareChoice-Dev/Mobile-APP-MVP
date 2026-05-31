# Mobile App MVP — Architecture

> Status: **Exploration / proposal**
> A React Native mobile app where users log in via Supabase and view job
> information that is synced from Salesforce. End users do **not** have
> Salesforce accounts; a single Salesforce **integration user** performs the
> sync server-side.

---

## 1. Goals & constraints

| # | Requirement | Implication |
|---|-------------|-------------|
| G1 | Users log in to the mobile app | Use **Supabase Auth** as the identity provider |
| G2 | Users see job information sourced from Salesforce | Salesforce data must be **mirrored into Supabase** |
| G3 | Users have **no** dedicated Salesforce access | App must never talk to Salesforce; a server-side **integration user** does |
| G4 | Each user sees only the jobs **assigned/owned by them** | Per-row authorization via **Postgres Row-Level Security (RLS)** |
| G5 | React Native client | `@supabase/supabase-js`, recommended via Expo |
| G6 | Users **write data back** to Salesforce (e.g. a case note attached to a job) | A **write-back path** Supabase → Salesforce, performed by the integration user via an **outbox** |

### The driving insight

Because users have no Salesforce identity, the app **cannot** call Salesforce
directly — in either direction:

- Embedding the integration user's credentials in the app would leak a
  highly-privileged secret to every device — unacceptable.
- There is no per-user Salesforce session to scope a query or a write with.

Therefore the app's entire backend is **Supabase**, and **all** Salesforce
traffic flows through the server-side sync service running as the integration
user. The system is **bidirectional**:

- **Reads** — Salesforce → Supabase (mirror), served to the app from Supabase.
- **Writes** — app → Supabase (an **outbox** table) → Salesforce, pushed by the
  integration user.

Salesforce remains invisible to the client; the app only ever sees Supabase.

> **Attribution caveat (important):** because the integration user performs the
> write, a case note created in Salesforce will, by default, show the
> *integration user* as its author — not the real app user. We must explicitly
> preserve the true author (a stamped field and/or a line in the note body).
> See §6.

---

## 1A. Architecture principles

These hold across every feature (jobs, notes, medications, anything later).
Whoever builds this should treat them as load-bearing.

1. **Salesforce is the system of record; Supabase is the support worker's system
   of engagement.** Supabase is a fast, access-controlled, offline-friendly
   *operational copy* of just the data a worker needs — not a second source of
   truth.

2. **Mirror only the working set.** Sync only the objects, fields, and rows a
   worker is allowed to use. Not the whole org. This keeps PII minimal, RLS
   simple, and sync cheap.

3. **Reads and writes are separate, asymmetric pipes — never one bidirectional
   sync.** This is what avoids merge conflicts and echo loops.

   | | Read (SF → Supabase) | Write (Supabase → SF) |
   |---|---|---|
   | What | Mirror — jobs, med charts | Outbox — notes, administrations |
   | Nature | Overwrites the local copy | Append-only events |
   | Truth wins | Salesforce | The worker's recorded action |
   | Mechanism | Push (CDC) + reconcile poll | Drain a queue, idempotently |
   | Cadence | Periodic / near-real-time | Eager (push back ASAP) |

4. **The local copy can be stale or wrong.** A write accepted by the app may be
   rejected by Salesforce later (e.g. a ceased medication). So: re-validate
   server-side at push time, and never let the UI imply "saved" means "confirmed
   in Salesforce" until the outbox row flips to `synced`.

5. **Every write is idempotent and attributed.** The integration user performs
   all writes, so each carries an idempotency key (the row UUID) and stamps the
   true author. This is tidiness for notes and *safety* for medications.

---

## 2. High-level architecture

```
                         READ PATH  (Salesforce → app)
┌──────────────┐      ┌───────────────────────────┐      ┌─────────────────────┐      ┌──────────────────┐
│  Salesforce  │      │  Sync service             │      │  Supabase           │      │  React Native    │
│              │─────▶│  (runs as integration     │─────▶│  (Postgres + Auth   │─────▶│  app (Expo)      │
│  Job records │ pull │   user, server-side only) │upsert│   + RLS + Realtime) │ read │                  │
│              │      │                           │      │  jobs table + RLS   │      │  End users       │
│  Case notes  │◀─────│  - polls / receives CDC   │◀─────│  job_notes (outbox) │◀─────│                  │
│              │create │  - drains outbox          │claim │  + RLS              │insert│                  │
└──────────────┘      └───────────────────────────┘      └─────────────────────┘      └──────────────────┘
       ▲                          │     WRITE PATH  (app → Salesforce)                          │
       │   integration user        │  upsert by salesforce_id (read) / create note (write)      │  login,
       └──────── secret ───────────┘                                                            └─ read + add notes
            (private key, never on device)                                                        (own jobs only)
```

**Trust boundaries**

1. **Salesforce ↔ Sync service** — authenticated as the integration user.
   Credentials live only on the server. Reads job records; creates case notes.
2. **Sync service ↔ Supabase** — uses the Supabase **service-role key**
   (bypasses RLS). Server-side only. Writes mirrored jobs; drains the note
   outbox.
3. **App ↔ Supabase** — uses the Supabase **anon key** + a user JWT. RLS is
   the *only* thing enforcing that a user reads only their own jobs and can add
   notes only to those jobs.

---

## 3. Components

### 3.1 Salesforce (source of truth)

- Jobs live in a Salesforce object (e.g. a custom `Job__c`, or a standard
  object like `WorkOrder` / `Case` — **to be confirmed against the real org**).
- Each job has an **owner/assignee** field. The value that links a job to an
  app user must be something we can also resolve on the Supabase side
  (see §5, "the mapping problem").
- **Case notes** are written to a note/child object related to the job. The
  exact object depends on the org — candidates: `ContentNote` + `ContentDocumentLink`,
  a `Task`, a Chatter `FeedItem`, `CaseComment` (if jobs are Cases), or a custom
  notes object. **To be confirmed** (see §8). The integration user needs
  **create** permission on whichever object is chosen.

### 3.2 Sync service (the integration layer)

Responsibilities:

- Authenticate to Salesforce as the integration user.
- **Read path:** pull changed job records; upsert them into Supabase `jobs`,
  keyed by Salesforce record Id (idempotent); record sync state.
- **Write path:** drain the `job_notes` outbox — claim `pending` notes, create
  the corresponding note record in Salesforce (stamping the true author), store
  the returned Salesforce Id back on the row, and mark it `synced` (or `error`
  with a retry count). See §5.4.

**Authentication to Salesforce — OAuth 2.0 JWT Bearer flow**

This is the standard server-to-server pattern for an integration user:

1. Create a **Connected App** in Salesforce with a certificate (public key).
2. The sync service holds the matching **private key** (a secret).
3. It signs a JWT and exchanges it for an access token — no interactive login,
   no stored password, no refresh-token juggling.

> Avoid username/password + security-token flows; they're being deprecated and
> are weaker. JWT Bearer is the right call for a headless integration user.

**Where it runs — two viable options**

| Option | Pros | Cons |
|--------|------|------|
| **Supabase Edge Function** + `pg_cron` | One platform; no extra infra; close to the DB | Deno runtime; cold starts; heavier syncs awkward |
| **Standalone worker** (Node/Deno container, scheduled) | Full control; easy to scale; richer libraries (jsforce) | Separate deploy + secrets management |

Recommendation: **start with a Supabase Edge Function** triggered on a schedule.
Promote to a standalone worker only if sync volume/complexity grows.

### 3.3 Supabase (app backend)

- **Postgres** holds the mirrored `jobs` table + the `job_notes` outbox
  (+ `profiles`, `sync_state`).
- **Auth** issues user JWTs (email/password, magic link, or OAuth provider).
- **RLS** enforces per-user visibility (G4) and per-user note insertion (G6).
- **Realtime** (optional) pushes live updates to the app — both job changes and
  the status of a note the user submitted (`pending` → `synced`).

### 3.4 React Native app (Expo)

- `@supabase/supabase-js` for auth + data.
- Stores the session securely (`expo-secure-store`), not plain AsyncStorage.
- Reads the user's jobs; **adds case notes** to those jobs by inserting into the
  `job_notes` outbox. The app sees its own note immediately (optimistic) and can
  reflect the sync status surfaced by Realtime.

---

## 4. Read sync strategy (freshness: TBD)

How job data flows **from Salesforce into Supabase**. (The write-back path is
§5.4.) Decision deferred — design supports both, **start with polling**:

### Phase 1 — Scheduled polling (recommended start)

- Every N minutes the sync service runs:
  `SELECT <fields> FROM Job__c WHERE LastModifiedDate > :lastSyncTime`
- Upsert results into Supabase; advance `lastSyncTime`.
- **Pros:** simple, robust, easy to reason about, easy to backfill.
- **Cons:** data is up to N minutes stale; polls even when nothing changed.

### Phase 2 — Push / near-realtime (add later if needed)

- Salesforce **Change Data Capture (CDC)** or **Platform Events** push changes
  to a webhook (a Supabase Edge Function HTTP endpoint).
- The endpoint upserts the changed record immediately.
- **Pros:** seconds-level freshness, no wasted polling.
- **Cons:** more moving parts; must handle replay/gaps, ordering, and a
  reconciling poll as a safety net.

> Design both paths to share the **same upsert function**, so adding CDC later
> is wiring, not a rewrite. Keep a low-frequency reconciliation poll even in
> Phase 2 to catch missed events.

### 4.1 Recommended cadence (near-real-time within API limits)

The tension "near-real-time vs. Salesforce API limits" mostly **dissolves** once
you do two things:

- **Query in bulk deltas, not per-record/per-user.** One SOQL
  `WHERE LastModifiedDate > :lastSync` pulls *all* changed jobs (or meds) for
  *all* clients in one paginated call — a handful of API calls per cycle,
  regardless of user count.
- **Use push for the hot data.** The **Streaming API / CDC / Platform Events**
  deliver changes over a persistent subscription; they have their own event
  allocation and do **not** consume the REST request quota the way polling does.
  This is how you get seconds-level latency *cheaply*.

**Recommended tiered cadence:**

| Data | Volatility | Mechanism | Target latency |
|------|-----------|-----------|----------------|
| Jobs | medium | **CDC push** + reconcile poll every ~15 min | seconds |
| Medication charts | low churn but safety-critical | **CDC push** + reconcile poll every ~5–15 min; **re-validate at administration time** | seconds |
| Reference/lookup data (rarely changes) | low | poll | hourly / nightly |
| **Writes** (notes, administrations) | event-driven | **Supabase DB webhook fires the drain on insert**, + fallback drain every ~60 s for retries | seconds |
| Full reconciliation sweep | — | scheduled | nightly |

**Phased rollout:**

- **MVP (no CDC yet):** delta-poll jobs + meds every **2–5 minutes**, drain the
  write outbox every **30–60 s** (or event-driven). That alone is "near enough"
  real-time (≤5 min reads, ~1 min writes) and very cheap.
- **Near-real-time target:** add **CDC** for jobs + med charts → seconds-level,
  while keeping the low-frequency reconcile poll as a safety net.

### 4.2 API-limit budget (sanity check)

Salesforce's **Total API Requests / 24 h** is an **org-wide, edition+license-based
allocation** (commonly tens of thousands+; confirm your org's figure in *Setup →
System Overview*). With bulk deltas the read cost is tiny:

- Delta-poll every 5 min = 288 cycles/day × ~a-few-calls/cycle ≈ **low thousands
  of calls/day**.
- CDC push moves most of that **off** the REST quota entirely (onto the streaming
  event allocation) — poll cost then drops to just the safety-net reconciles.
- Writes ≈ 1–2 calls each; even hundreds of administrations/day is negligible.
- Use the **Bulk API** for the initial backfill / nightly full sweep (separate,
  much higher limits) rather than the REST API.

> Net: a single integration user doing bulk deltas + CDC sits comfortably inside
> typical allocations while delivering seconds-level freshness. The thing that
> *would* blow the budget — naive per-record or per-user polling — is exactly
> what this design avoids. Verify against your org's actual allocation, the CDC
> event allocation, and the concurrent-long-running-request limit (§8).

---

## 5. Data model & the per-user mapping

### 5.1 Tables

```sql
-- One row per app user, 1:1 with auth.users
create table public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  -- The key that links this app user to "their" Salesforce jobs.
  -- See §5.2 for how this value is established.
  salesforce_owner_key text unique,
  created_at      timestamptz not null default now()
);

-- Mirror of Salesforce job records
create table public.jobs (
  id                uuid primary key default gen_random_uuid(),
  salesforce_id     text unique not null,        -- idempotency key for upserts
  title             text,
  status            text,
  description       text,
  -- Whatever field on the SF record identifies the owner/assignee:
  owner_key         text,                         -- matches profiles.salesforce_owner_key
  salesforce_modified_at timestamptz,             -- from LastModifiedDate
  synced_at         timestamptz not null default now()
);

create index on public.jobs (owner_key);

-- Outbox: case notes written by app users, pushed to Salesforce by the sync service
create table public.job_notes (
  id              uuid primary key default gen_random_uuid(),  -- also the idempotency key sent to SF
  job_id          uuid not null references public.jobs(id),
  author_id       uuid not null references auth.users(id) default auth.uid(),
  body            text not null,
  -- write-back state machine
  status          text not null default 'pending'             -- pending | syncing | synced | error
                    check (status in ('pending','syncing','synced','error')),
  salesforce_note_id text,                                     -- set once created in SF
  attempts        int not null default 0,
  last_error      text,
  created_at      timestamptz not null default now(),
  synced_at       timestamptz
);

create index on public.job_notes (status) where status in ('pending','error');

-- Sync bookkeeping
create table public.sync_state (
  object_name   text primary key,                -- e.g. 'Job__c'
  last_synced_at timestamptz,
  last_replay_id text                            -- for CDC, Phase 2
);
```

### 5.2 The mapping problem (the crux of "assigned/owned jobs only")

To show a user only *their* jobs, we must connect:

```
auth.users (Supabase identity)  ──?──  Salesforce owner/assignee field
```

Salesforce identifies owners by **Salesforce User Id** — which app users don't
have. So we need a stable shared key. Options, best first:

1. **Stable external identifier (preferred).** If the org has an employee /
   contact / external id that exists both on the Salesforce job (as the
   assignee reference) and can be provisioned onto the Supabase profile at
   signup, use that. Most robust; survives email changes.
2. **Email address.** If jobs carry the assignee's email and app users sign in
   with that same email, match on it. Simple, but brittle if emails change and
   couples authz to PII. Treat email as case-insensitive; normalize on both
   sides.
3. **Manual admin mapping.** An admin screen / seed table linking each app user
   to their Salesforce owner key. Fine for a small MVP user base.

> This decision is a **prerequisite** before the per-user RLS can be trusted.
> It needs confirmation against the real Salesforce org's job object and how
> users will be onboarded. Flagged as an open question (§8).

### 5.3 Row-Level Security

```sql
alter table public.jobs enable row level security;
alter table public.profiles enable row level security;

-- A user can read only jobs whose owner_key matches their profile's key.
create policy "users read their assigned jobs"
on public.jobs for select
to authenticated
using (
  owner_key = (
    select p.salesforce_owner_key
    from public.profiles p
    where p.id = auth.uid()
  )
);

-- Users can read/update only their own profile row.
create policy "users read own profile"
on public.profiles for select to authenticated
using (id = auth.uid());

-- job_notes: a user may read notes they authored...
alter table public.job_notes enable row level security;

create policy "users read own notes"
on public.job_notes for select to authenticated
using (author_id = auth.uid());

-- ...and may INSERT a note only on a job they own, only as themselves,
-- and only in the 'pending' state (cannot self-mark as synced).
create policy "users add notes to their jobs"
on public.job_notes for insert to authenticated
with check (
  author_id = auth.uid()
  and status = 'pending'
  and exists (
    select 1 from public.jobs j
    join public.profiles p on p.salesforce_owner_key = j.owner_key
    where j.id = job_notes.job_id and p.id = auth.uid()
  )
);
-- No UPDATE/DELETE policy for authenticated: only the sync service
-- (service-role) advances status / writes salesforce_note_id.
```

Notes:

- The **sync service writes with the service-role key**, which bypasses RLS.
  For `jobs` the app is **read-only**; for `job_notes` the app may only
  **insert** `pending` rows on its own jobs — it can never flip status or edit
  another user's note.
- RLS is the entire security boundary for G4 **and G6**. It must be covered by
  automated tests: read another user's job → zero rows; insert a note on a job
  you don't own → rejected; try to insert with `status='synced'` → rejected.
- Designed to be tightenable: if scoping later changes to team/region, only the
  `using (...)` / `with check (...)` clauses change.

### 5.4 Write-back path (case notes → Salesforce)

The **outbox pattern**: the app writes to Supabase, and the integration user
asynchronously pushes to Salesforce. This decouples the client from Salesforce,
survives flaky connectivity, gives free retry/audit, and keeps the SF secret
server-side.

```
1. App INSERTs into job_notes (status='pending')  ──RLS-checked──▶ Supabase
2. Sync service claims a batch:
     UPDATE job_notes SET status='syncing', attempts=attempts+1
     WHERE status='pending' RETURNING *      (FOR UPDATE SKIP LOCKED to avoid double-send)
3. For each row, create the note in Salesforce as the integration user,
   stamping the true author (see §6), passing id as an idempotency key.
4. On success: UPDATE status='synced', salesforce_note_id=<id>, synced_at=now()
   On failure: UPDATE status='error', last_error=<msg>  (retried with backoff;
   give up after N attempts and surface to the user)
```

Design points:

- **Idempotency.** Use the row's `id` (a UUID) as an external/idempotency key
  on the Salesforce side so a retry after a network blip doesn't create a
  duplicate note. If the chosen note object can't store an external id, the
  service must check-before-create.
- **Notes are append-only.** A case note is *created*, never edited in place by
  two parties — so there is **no field-merge conflict problem**, unlike
  bidirectional record sync. This keeps write-back simple.
- **Trigger cadence.** The same scheduler that runs the read poll can drain the
  outbox; or drain on-demand via an Edge Function the app calls right after
  insert for snappier feedback. Realtime on `job_notes` lets the UI show
  `pending → synced` live.
- **The created note flows back on the next read sync** if notes are also part
  of the mirrored data, so the user eventually sees the canonical Salesforce
  copy.

---

## 6. Security considerations

- **Integration user secret** (Salesforce private key) and the **Supabase
  service-role key** live only in the sync service's secret store — never in
  the app bundle, never in a public repo. The app ships **only** the Supabase
  URL + anon key (safe by design when RLS is correct).
- **Principle of least privilege** for the integration user in Salesforce:
  grant **read** on the job object and **create** on the note object — nothing
  more (no broad write/delete).
- **RLS is mandatory and tested.** The anon key is public; without correct RLS,
  any user could read all jobs or attach notes to jobs that aren't theirs.
- **Authorship / attribution (the write-back caveat).** Salesforce will record
  the *integration user* as the note's creator, because that's who has the API
  session. To preserve who really wrote it, the sync service must stamp the true
  author when creating the note — e.g. an "Authored by `<name/external id>` via
  mobile app" line prepended to the body, and/or a dedicated custom field on the
  note object holding the app user's identifier. Decide which with the SF team.
  Be deliberate about *which* identifier is written (avoid leaking unnecessary
  PII into the note body).
- **Input validation.** Treat note `body` as untrusted user input: enforce a
  length cap and strip/escape anything problematic before it reaches Salesforce.
- **Outbox can't be spoofed.** RLS forces `author_id = auth.uid()` and
  `status='pending'` on insert, so a user can't forge another user's note or
  pre-mark one as synced.
- **Session storage** on device via `expo-secure-store`.
- **PII minimization** — sync only the job fields the app needs; avoid copying
  sensitive personal fields into Supabase unless required.

---

## 7. MVP build order (when we proceed)

1. Supabase project: `profiles`, `jobs`, `job_notes`, `sync_state` tables + RLS
   + tests (read scoping **and** note-insert scoping).
2. Salesforce Connected App + JWT Bearer auth for the integration user.
3. Sync Edge Function — **read**: pull job object → upsert into `jobs`
   (Phase 1 polling) + `pg_cron` schedule.
4. Decide & implement the user↔owner mapping (§5.2) at signup.
5. Expo app: Supabase login + "My Jobs" list + job detail (read).
6. Sync Edge Function — **write**: drain the `job_notes` outbox → create notes
   in Salesforce with author stamping + idempotency (§5.4, §6).
7. Expo app: "add case note" UI → insert into `job_notes`, show `pending →
   synced` status.
8. (Optional) Supabase Realtime for live job + note-status updates.
9. (Later) CDC/Platform Events push if read freshness requires it.

---

## 8. Open questions

1. ~~Which Salesforce object are jobs?~~ **Resolved (§11):** `sked__Job__c`
   (Skedulo), with `sked__Job_Allocation__c` as the worker↔job join.
2. ~~What field designates the assignee/owner?~~ **Resolved (§11):** the worker
   is `sked__Resource__c`, linked via `sked__Job_Allocation__c` — *not* a field
   on the Job. Per-user key becomes `profiles.salesforce_resource_id`. Still to
   confirm: the `sked__Resource__c → User` link field (§11.5).
3. **How are app users onboarded** — self-signup, admin invite, SSO? Affects how
   `profiles.salesforce_resource_id` gets populated reliably from the worker's
   `sked__Resource__c`.
4. **Freshness SLA** — how stale can jobs be? Confirms polling interval vs. need
   for CDC (§4).
5. **Volume** — how many jobs / users / change rate / note rate? Influences Edge
   Function vs. standalone worker and polling/drain cadence.
6. ~~Which object stores a case note?~~ **Resolved (§11):** `enrtcr__Note__c`,
   linked to Job (`skedhealthcare__Job__c`), Client (`enrtcr__Client__c`), and
   optionally Medication. No native External Id → idempotency via outbox UUID +
   check-before-create.
7. **How should authorship be represented** on the note — `enrtcr__Note__c` has
   a `Created_by_Name__c` string and `OwnerId`; decide whether to stamp the true
   worker there and/or in the body (§6).
8. **Note semantics** — append-only confirmed? Any need to edit/delete a
   submitted note later? (Edit/delete would reintroduce conflict handling.)
9. **Beyond notes?** Any other write-backs planned (status changes, field
   edits)? Those *do* bring field-merge conflicts and would extend this design.
10. **API + streaming allocations** — what is the org's *Total API Requests/24 h*
    allocation, is **Change Data Capture** licensed/enabled, and what are the CDC
    event and concurrent-long-running-request limits? Confirms the §4 cadence is
    safely within budget.
11. **Agentforce licensing & scoping** (§10) — is Agentforce licensed, what is
    the consumption/credit budget, and exactly how is each agent invocation
    constrained to a worker's authorized clients? Governance choice (Trust Layer
    vs. external model) still open with stakeholders.

---

## 9. Technology summary

| Concern | Choice |
|---------|--------|
| Mobile framework | React Native via **Expo** |
| App data/auth client | `@supabase/supabase-js` |
| Identity | **Supabase Auth** (user JWTs) |
| App database | **Supabase Postgres** |
| Per-user authorization | **Postgres RLS** |
| Live updates (optional) | Supabase Realtime |
| Salesforce auth | **OAuth 2.0 JWT Bearer** (Connected App, integration user) |
| Sync compute | **Supabase Edge Function** + `pg_cron` (Phase 1) |
| Read trigger | MVP: delta-poll **2–5 min**; target: **CDC push** (seconds) + reconcile poll every 15 min |
| Write trigger | DB-webhook drain on insert + **60 s** fallback |
| Bulk backfill | **Bulk API** for initial load + nightly sweep |
| Write-back | **Outbox** drained by integration user; append-only; idempotent |
| Secret storage (app) | `expo-secure-store` (Supabase URL + anon key only) |
| Secret storage (server) | Sync service secret store (SF private key + service-role key) |
| AI assistant | **Agentforce** via Agent API (server-side), grounded in Salesforce + Trust Layer |

---

## 10. AI assistant (Agentforce)

**Goal:** let support workers (a) ask questions grounded in Salesforce data and
(b) take actions in Salesforce (e.g. draft a case note, log an administration).
Both are core Agentforce use cases, so the design **leads with Agentforce**.

### 10.1 What Agentforce is

Salesforce's agentic AI platform: an agent grounded in CRM data, with a set of
permitted **actions** and a reasoning engine that chooses among them. It uses
LLMs under the hood (Salesforce-hosted or BYO) wrapped in the **Einstein Trust
Layer** (PII masking, zero data retention with model providers, toxicity
detection, audit). So this is *"Salesforce orchestrates model + grounding +
actions"*, not "model vs. no model".

### 10.2 How license-less users access it

Workers have **no Salesforce seats**, so the agent is **not** surfaced via a
Salesforce UI login. Instead:

```
worker (app) ──▶ app backend ──▶ Agentforce Agent API ──▶ agent (grounded in SF, Trust Layer)
                                  (auth via connected app / integration identity)
             ◀──── response / action result ◀────────────
```

- Use a **customer/service-facing agent** (designed to serve external users).
- Invoke it **headlessly via the Agent API** from the server — same trust
  boundary as the sync service; the secret never reaches the device.
- Pricing is **consumption-based** (per conversation / Flex credits), which fits
  the no-per-user-seat model.

### 10.3 The critical constraint — per-user data scoping

The agent runs under a **service/integration identity**, so it does **not**
inherit Supabase RLS or any per-user Salesforce sharing. Left unconstrained it
could surface *any* client's data. Therefore **every invocation must be scoped**
to the worker's authorized clients (pass the worker's scope as
grounding/parameters; restrict the agent's actions to that scope). This is the
same authorization principle as §5.3, applied to the AI layer — and it is
**mandatory**, not optional, for clinical PII.

### 10.4 Agentforce vs. external model (decision: governance still open)

| | **Agentforce** | **External model** (e.g. Claude API in backend) |
|---|---|---|
| AI + grounding + actions | Prebuilt, grounded in live SF, action library | You build orchestration + RAG over the Supabase mirror |
| Per-user scoping | You must enforce it (service identity) | Reuses existing RLS over scoped Supabase data |
| PII governance | Einstein Trust Layer (masking, zero-retention, audit) | You own the model-provider data contract |
| Acting in Salesforce | Native actions | Routes back through the outbox / integration user |
| Cost | Consumption credits; can be less predictable | Per-token; more controllable/portable |
| Offline/latency | Cloud call; no offline | Same; but you control caching |

**Recommendation:** given both stated goals are Salesforce-centric (read SF +
act in SF), **Agentforce is the natural fit** — an external model would mean
rebuilding grounding and routing actions back through the outbox for the same
result. The **governance trade-off** (Trust Layer vs. cost/portability/control)
is left open for stakeholders; a viable middle path is Agentforce for
SF-grounded Q&A + actions and a lighter external model for app-local assistance
over the Supabase copy.

---

## 11. Concrete Salesforce mapping (verified against UAT)

Inspected in the **UAT sandbox** (`CareChoice`, instance `AUS24S`,
`IsSandbox = true`) — read-only, no personal records queried. This grounds the
placeholders in §3 / §5 with the org's actual objects. The org runs two managed
packages: **Skedulo** (`sked__`, `skedhealthcare__`) for scheduling/jobs and a
care-management package (`enrtcr__`) for clients, notes, and medications.

### 11.1 Object map

| Concept in this doc | Salesforce object | Notes |
|---|---|---|
| Job / visit / shift | `sked__Job__c` | 211 fields — mirror only the working set |
| **Worker ↔ job assignment** | `sked__Job_Allocation__c` | the join that scopes "my jobs" |
| Worker (field staff) | `sked__Resource__c` | linked to a `User`; the per-user mapping anchor |
| Client | `Contact` | referenced as `sked__Contact__c` / `enrtcr__Client__c` |
| Case note | `enrtcr__Note__c` | links to Job, Client, and Medication |
| Medication chart (standing order) | `enrtcr__Medication__c` | per-client; `Client__c → Contact` |
| Medication administration (event) | `enrtcr__Medication_Administered__c` | child of Medication; worker on `Person_Administering__c` |

### 11.2 The per-user mapping is resolved (and is NOT on the Job)

The worker is **not** a direct field on `sked__Job__c`. The assignment lives on
`sked__Job_Allocation__c`:

```
Supabase user  ──▶  sked__Resource__c (worker)  ──▶  sked__Job_Allocation__c  ──▶  sked__Job__c
   (profiles.salesforce_resource_id)              sked__Resource__c    sked__Job__c
```

So §5.2's "owner key" becomes a **Salesforce Resource Id**:
`profiles.salesforce_resource_id` = the worker's `sked__Resource__c` Id. The
read sync queries `sked__Job_Allocation__c WHERE sked__Resource__c = :resourceId`
and mirrors the joined `sked__Job__c`. RLS (§5.3) then scopes jobs by the user's
`salesforce_resource_id`.

- Worker-facing lifecycle: `sked__Job_Allocation__c.sked__Status__c`
  = `Pending Dispatch; Dispatched; Confirmed; En Route; Checked In; In Progress; Complete; Declined; Deleted`.
- Job lifecycle: `sked__Job__c.sked__Job_Status__c`
  = `Queued; Pending Allocation; … On Site; In Progress; Complete; Cancelled`.
- Useful upsert key: `sked__Job_Allocation__c.sked__UniqueKey__c` (confirm it's
  flagged External Id in Setup).

### 11.3 Case note write-back → `enrtcr__Note__c`

Real links (all lookups, so no cascade constraints): `skedhealthcare__Job__c →
sked__Job__c`, `enrtcr__Client__c → Contact`, optionally `enrtcr__Medication__c
→ enrtcr__Medication__c`. Relevant fields: `Name` (Title), `enrtcr__Status__c`
(`Draft; Completed`), `enrtcr__Type__c` (~80 values incl. `Progress notes
(Support worker)`, `Case Note`, `Medication`), `enrtcr__Service_Note_Date__c`.
**No native External Id** → use the outbox row UUID as the idempotency key
(check-before-create, since there's no external-id field to dedupe on).

### 11.4 Medication chart + administration

- **Chart** `enrtcr__Medication__c`: `Client__c → Contact` (no Job link),
  `Status__c` = `Active; Closed`, `Medication_Support__c` = `Self Administered;
  Administer; Assistance Needed`, `Dosage__c`, `Route__c`,
  `Instructions_to_administer_medicines__c`, weekday routine multipicklists
  (`Monday__c`…`Sunday__c` = `Breakfast; Lunch; Dinner; Bed`), `Start_Date__c`,
  `End_Date__c`. The "re-validate at administration time" rule (§1A.4, §5.4)
  means checking `Status__c = Active` and date window before pushing.
- **Administration** `enrtcr__Medication_Administered__c`: parent
  `enrtcr__Medication__c` (**required — treat as master-detail**); worker on
  `Person_Administering__c → sked__Resource__c`; `Administered_Date_Time__c`
  (**required datetime** — capture on device at the moment, per §5.4);
  `Administered_Routine__c` = `Breakfast; Lunch; Dinner; Bed`;
  `Reason_for_not_administering__c` = `R - Refused; A - Absent; F - Fasting; V -
  Vomiting; L - On Leave; N - Not Available; W - Withheld; M - Missed`;
  `Comments__c`, `Witness__c`. **No Job FK and no External Id** → relate to the
  visit via the client + worker + time (or via a related `enrtcr__Note__c`), and
  synthesize an idempotency key from medication + datetime + routine.

> The `outcome`/`reason` enums in §5.4's `medication_administrations` outbox
> should mirror `Reason_for_not_administering__c` verbatim so no translation is
> lost on write-back.

### 11.5 Verify before building

- **Master-detail vs lookup** — the schema API didn't expose relationship type.
  Treat the three `required=true` refs (`Job_Allocation.sked__Job__c`,
  `Job_Allocation.sked__Resource__c`, `Medication_Administered.enrtcr__Medication__c`)
  as probable master-detail and confirm in Setup before finalizing delete
  semantics.
- **`sked__Resource__c → User` link** — confirm the field that ties a Resource to
  a Salesforce User, so onboarding can populate `profiles.salesforce_resource_id`.
- **External Id flags** — confirm whether `sked__UniqueKey__c` is a true External
  Id (enables efficient upserts vs. check-before-create).
