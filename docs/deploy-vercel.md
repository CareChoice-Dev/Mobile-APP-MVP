# Deploying the CareChoice Mobile MVP

This runbook captures the exact setup that takes this repo to a live
environment: the **Supabase** backend (Postgres + Auth + RLS) and the
**Expo web app on Vercel**. It reflects the working production deployment.

> See also: [`../README.md`](../README.md) (overview) and
> [`./architecture.md`](./architecture.md) (design + verified Salesforce model).

---

## 1. Supabase (backend)

The app and sync service both target one Supabase project.

- **Project:** `Mobile MVP` (ref `xgkvdnaciymazdxxxoxu`, region `ap-southeast-2`)
- **API URL:** `https://xgkvdnaciymazdxxxoxu.supabase.co`

### Apply the schema

The schema lives in [`../supabase/schema.sql`](../supabase/schema.sql) (tables
`profiles`, `jobs`, `medications`, `job_notes`, `medication_administrations`,
the `current_resource_id()` helper, and all RLS policies).

Apply it once to a fresh project via either:

- **SQL editor:** paste `supabase/schema.sql` and run, or
- **Supabase CLI:** `supabase db push` (with the SQL as a migration).

Verify: all five tables exist with **RLS enabled**.

> Security advisor note (low severity): `public.current_resource_id()` is a
> `SECURITY DEFINER` helper callable via REST RPC. It only ever returns the
> caller's own resource id, so there's no cross-tenant leak — but revisit before
> a production hardening pass.

---

## 2. Expo web app (Vercel)

The app is a React Native (Expo Router) project in [`../app`](../app) whose web
target exports a **static SPA** (`web.output: "single"`).

### Project settings (Vercel → Project → Settings)

| Setting | Value | Where |
|---|---|---|
| **Root Directory** | `app` | General |
| **Framework Preset** | Other | General (kept as `null` via `vercel.json`) |
| **Production Branch** | the branch you deploy from | Git |
| Build Command | `expo export --platform web` | from `app/vercel.json` |
| Output Directory | `dist` | from `app/vercel.json` |
| Node.js Version | **20.x** recommended | General |

`app/vercel.json` already supplies the build command, output directory, and the
SPA rewrite (`/(.*) -> /index.html`), so you only set **Root Directory**,
**Production Branch**, **Node version**, and the env vars below.

### Environment variables (Production + Preview)

These are **build-time inlined** into the JS bundle. The anon key is a public
key — safe to expose; the security boundary is RLS, not key secrecy.

```
EXPO_PUBLIC_SUPABASE_URL       = https://xgkvdnaciymazdxxxoxu.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY  = <anon/publishable key from Supabase → Project Settings → API>
```

### Deploy

A push to the production branch triggers a build. A plain "Redeploy" of an old
deployment rebuilds the **old commit** — to pick up new settings, push a commit
(or redeploy and confirm the dialog shows the right branch).

### Verify

- Build log shows `npm install`, `Web Bundled … modules`, `App exported to: dist`
  and takes tens of seconds (not milliseconds).
- The production URL returns **HTTP 200** with the app HTML (`<title>CareChoice</title>`).
- A deep link such as `/login` also returns 200 (SPA rewrite working).

---

## 3. Build gotchas

- **`@opentelemetry/api` not found (Metro):** `@supabase/supabase-js` ships an
  optional dynamic import that Metro can't resolve. `app/metro.config.js` stubs
  it to an empty module. Do not remove that config or the web build breaks.
- **Node 24 install/export failures:** pin Node to **20.x** (Expo 51 tooling).
- **Blank screen / "Missing Supabase config":** the `EXPO_PUBLIC_*` env vars
  weren't set at build time — set them and redeploy.

---

## 4. After deploy: make it functional

The deployed app loads to the login screen but has no data until you:

1. Create a Supabase auth user and a matching `profiles` row mapping it to a
   `salesforce_resource_id`.
2. Run the [`../sync`](../sync) service to mirror that worker's jobs and client
   medication charts from Salesforce.

See the README quick-start for both.
