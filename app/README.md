# CareChoice Support-Worker App (Expo MVP)

A React Native (Expo Router) app for support workers. It reads the worker's
jobs and the relevant client medication charts, and lets the worker file case
notes and medication administrations.

## Architecture

- The app talks **only to Supabase** (Postgres + Auth + Realtime). It never
  talks to Salesforce directly.
- Auth is Supabase email/password. The user JWT is sent with every request and
  **Row-Level Security (RLS) is the only per-user boundary** — each worker sees
  only their own jobs/notes and the medications of clients they have jobs with.
- Writes (`job_notes`, `medication_administrations`) are **INSERT-only outbox
  rows**. The app inserts them with the default `status = 'pending'`; a separate
  server-side sync service (service-role key) drains them to Salesforce and
  flips the status to `synced`. The app shows that sync status. For the MVP a
  refetch on screen focus is enough; Realtime is optional.

This app **requires the Supabase project defined in [`/supabase/schema.sql`](../supabase/schema.sql)**
(tables: `profiles`, `jobs`, `medications`, `job_notes`,
`medication_administrations`, plus the RLS policies). Each app user must have a
matching `profiles` row with their `salesforce_resource_id` seeded.

## Prerequisites

- Node 18+
- A Supabase project with the schema above applied
- At least one auth user with a seeded `profiles` row, and some `jobs` /
  `medications` mirrored for that worker's resource id

## Setup

```bash
# from this directory (app/)
npm install

# configure Supabase connection
cp .env.example .env
# then edit .env and set:
#   EXPO_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
#   EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon public key>
```

> The `EXPO_PUBLIC_*` vars are inlined into the JS bundle and are **safe to
> ship** — the anon key is a public key. The security boundary is RLS, not key
> secrecy. Never put the service-role key here.

## Run

```bash
npx expo start          # then press i / a / w, or scan the QR with Expo Go
npm run ios             # iOS simulator
npm run android         # Android emulator
npm run web             # web
```

## App structure

```
app/                          # expo-router routes
  _layout.tsx                 # AuthProvider + auth-gate redirect to /login
  login.tsx                   # Supabase email/password sign in
  index.tsx                   # "My Jobs" list (ordered by starts_at)
  job/[id]/index.tsx          # job detail + client medications
  job/[id]/note.tsx           # add a case note (INSERT job_notes)
  job/[id]/medication/[medId].tsx  # record an administration
src/
  lib/supabase.ts             # client; session persisted in SecureStore (AsyncStorage on web)
  lib/types.ts                # TS mirrors of the Supabase tables
  contexts/AuthContext.tsx    # session + signIn/signOut/loading
  components/                 # JobCard, StatusBadge, Field
```

## Notes / MVP limitations

- `administered_at` is captured as "now" at submit time (no date picker yet).
- Sync status is shown after insert; the app does not poll for the flip to
  `synced` (refetch on focus, or wire up Supabase Realtime, as a follow-up).
- No offline queue: inserts require connectivity. RLS rejects writes that don't
  belong to the worker.
