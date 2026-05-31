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

### The driving insight

Because users have no Salesforce identity, the app **cannot** call Salesforce
directly:

- Embedding the integration user's credentials in the app would leak a
  highly-privileged secret to every device — unacceptable.
- There is no per-user Salesforce session to scope a live query with.

Therefore the design is a **one-way sync pipeline** (Salesforce → Supabase),
**not** a live proxy. The app's entire backend is Supabase. Salesforce is
invisible to the client.

---

## 2. High-level architecture

```
┌──────────────┐      ┌───────────────────────────┐      ┌─────────────────────┐      ┌──────────────────┐
│  Salesforce  │      │  Sync service             │      │  Supabase           │      │  React Native    │
│              │      │  (runs as integration     │      │  (Postgres + Auth   │      │  app (Expo)      │
│  Job records │─────▶│   user, server-side only) │─────▶│   + RLS + Realtime) │◀────▶│                  │
│              │ JWT  │                           │ svc  │                     │ anon │  End users       │
│              │ OAuth│  - polls / receives CDC   │ role │  jobs table + RLS   │ key  │                  │
└──────────────┘      └───────────────────────────┘      └─────────────────────┘      └──────────────────┘
       ▲                          │                                                            │
       │   integration user        │  upsert by salesforce_id                                   │  login + read
       └──────── secret ───────────┘                                                            └─ assigned jobs only
            (private key, never on device)
```

**Trust boundaries**

1. **Salesforce ↔ Sync service** — authenticated as the integration user.
   Credentials live only on the server.
2. **Sync service ↔ Supabase** — uses the Supabase **service-role key**
   (bypasses RLS, write path only). Server-side only.
3. **App ↔ Supabase** — uses the Supabase **anon key** + a user JWT. RLS is
   the *only* thing enforcing that a user sees only their own jobs.

---

## 3. Components

### 3.1 Salesforce (source of truth)

- Jobs live in a Salesforce object (e.g. a custom `Job__c`, or a standard
  object like `WorkOrder` / `Case` — **to be confirmed against the real org**).
- Each job has an **owner/assignee** field. The value that links a job to an
  app user must be something we can also resolve on the Supabase side
  (see §5, "the mapping problem").

### 3.2 Sync service (the integration layer)

Responsibilities:

- Authenticate to Salesforce as the integration user.
- Pull changed job records.
- Upsert them into Supabase `jobs`, keyed by Salesforce record Id (idempotent).
- Record sync state (last successful sync timestamp / replay id).

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

- **Postgres** holds the mirrored `jobs` table (+ `profiles`, `sync_state`).
- **Auth** issues user JWTs (email/password, magic link, or OAuth provider).
- **RLS** enforces per-user visibility (G4).
- **Realtime** (optional) pushes live updates to the app when a job row changes.

### 3.4 React Native app (Expo)

- `@supabase/supabase-js` for auth + data.
- Stores the session securely (`expo-secure-store`), not plain AsyncStorage.
- Read-only views of the user's jobs. (No writes back to Salesforce in the MVP.)

---

## 4. Sync strategy (freshness: TBD)

Decision deferred — design supports both, **start with polling**:

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
```

Notes:

- The **sync service writes with the service-role key**, which bypasses RLS —
  so no INSERT/UPDATE policy is granted to `authenticated`. The app is
  **read-only** against `jobs`.
- RLS is the entire security boundary for G4. It must be covered by automated
  tests (try to read another user's job → expect zero rows).
- Designed to be tightenable: if scoping later changes to team/region, only the
  policy's `using (...)` clause changes.

---

## 6. Security considerations

- **Integration user secret** (Salesforce private key) and the **Supabase
  service-role key** live only in the sync service's secret store — never in
  the app bundle, never in a public repo. The app ships **only** the Supabase
  URL + anon key (safe by design when RLS is correct).
- **Principle of least privilege** for the integration user in Salesforce:
  grant read access to the job object and nothing more.
- **RLS is mandatory and tested.** The anon key is public; without correct RLS,
  any user could read all jobs.
- **Session storage** on device via `expo-secure-store`.
- **No write-back** to Salesforce in the MVP — removes a large class of authz
  and conflict problems.
- **PII minimization** — sync only the job fields the app needs; avoid copying
  sensitive personal fields into Supabase unless required.

---

## 7. MVP build order (when we proceed)

1. Supabase project: `profiles`, `jobs`, `sync_state` tables + RLS + tests.
2. Salesforce Connected App + JWT Bearer auth for the integration user.
3. Sync Edge Function: pull job object → upsert into `jobs` (Phase 1 polling)
   + `pg_cron` schedule.
4. Decide & implement the user↔owner mapping (§5.2) at signup.
5. Expo app: Supabase login + "My Jobs" list + job detail, read-only.
6. (Optional) Supabase Realtime for live list updates.
7. (Later) CDC/Platform Events push if freshness requires it.

---

## 8. Open questions

1. **Which Salesforce object** are jobs? (`Job__c` custom, or `WorkOrder` /
   `Case` / other standard?) Determines the field list and sync query.
2. **What field designates the assignee/owner**, and what stable key can map it
   to an app user (§5.2)? This gates the whole per-user authz model.
3. **How are app users onboarded** — self-signup, admin invite, SSO? Affects how
   `profiles.salesforce_owner_key` gets populated reliably.
4. **Freshness SLA** — how stale can jobs be? Confirms polling interval vs. need
   for CDC (§4).
5. **Volume** — how many jobs / users / change rate? Influences Edge Function vs.
   standalone worker and polling cadence.
6. **Read-only confirmed?** Any future need for the app to push updates back to
   Salesforce? (Out of scope for MVP, but affects long-term design.)

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
| Sync trigger | Polling now; CDC/Platform Events later |
| Secret storage (app) | `expo-secure-store` (Supabase URL + anon key only) |
| Secret storage (server) | Sync service secret store (SF private key + service-role key) |
