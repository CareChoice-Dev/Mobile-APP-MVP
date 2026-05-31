# CareChoice Mobile MVP

A React Native (Expo) app where support workers log in via **Supabase**, see
**jobs synced from Salesforce**, and write **case notes** (and medication
administrations) back — **without any worker having a Salesforce login**. A
single Salesforce **integration user** performs all sync, server-side.

> Full design rationale: [`docs/architecture.md`](docs/architecture.md).

## The model in one diagram

```
  Supabase user ──(profiles.salesforce_resource_id)──▶ sked__Resource__c (worker, NO SF login)
                                                              │
   READ   sked__Job_Allocation__c ─▶ sked__Job__c ───────────┤  integration user (one SF login)
          enrtcr__Medication__c (client chart) ──────────────┤  does ALL Salesforce I/O
   WRITE  job_notes outbox ─▶ enrtcr__Note__c ───────────────┘
          medication_administrations outbox ─▶ enrtcr__Medication_Administered__c
```

The worker↔jobs binding is a single **Resource Id**. The app never sees
Salesforce; it reads/writes Supabase, and RLS scopes everything to the logged-in
worker's resource.

## Proven against UAT

The full loop was validated against the live UAT org (`AUS24S`):
given only Resource `a2sI80000000HFPIA2` → 8 jobs → a client's medication chart →
created `enrtcr__Note__c` linked to the job + client, attributed to the Resource
(no User) → read back. See `docs/architecture.md` §11.

## Layout

| Path | What |
|------|------|
| `docs/architecture.md` | Architecture + verified Salesforce mapping (§11) |
| `supabase/schema.sql` | Postgres tables + RLS (the per-user boundary) |
| `sync/` | Integration/sync service + runnable PoC (`npm run poc`) |
| `app/` | Expo mobile app (auth, jobs, notes, medications) |

## Quick start

1. **Supabase:** create a project, run `supabase/schema.sql`, seed one
   `profiles` row mapping a test auth user to a Resource Id.
2. **Sync/PoC:** `cd sync && cp .env.example .env` (fill in), `npm i`,
   `npm run poc` (set `DRY_RUN=1` to preview writes).
3. **App:** `cd app && cp .env.example .env` (Supabase URL + anon key),
   `npm i`, `npx expo start`.

## Status: proof-of-concept

This is an MVP to prove the integration works. Before production see the open
questions in `docs/architecture.md` §8 (onboarding/provisioning, freshness SLA,
volume, CDC + Agentforce licensing) and the new-org affordances in §11.6
(External Id fields for idempotent write-back, a writable attribution field).
