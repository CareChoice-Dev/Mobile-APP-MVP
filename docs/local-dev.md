# Local Session Handover — Mobile APP MVP sync

Hand-off for continuing this work **locally** (after a Claude Code on-the-web session).
It captures where things stand, the fixed facts, how to set up, and what's next — so a
fresh session doesn't re-derive context. Companion docs: `architecture.md` (design),
`sync-jwt-setup.md` (the JWT runbook with auth-error troubleshooting).

> Branch with all this work: **`claude/brave-edison-LWhGO`** (everything is pushed).

---

## 1. Where we are (status)

| Area | State |
|---|---|
| JWT-bearer auth → UAT | ✅ Works (instance `carechoice--uat.sandbox.my.salesforce.com`) |
| Read sync (SF → Supabase) | ✅ Live — **53 jobs + 45 medications** upserted, keyed by `salesforce_id` |
| Contact access for integration user | ✅ Granted (see §3) — required for the client lookups |
| Note drain (Supabase → SF) | ✅ Repointed to **`Case_Note_MVP__c`** via External-Id upsert on `Mobile_Outbox_Id__c` |
| Workaround: `Case_Note_MVP__c` | ✅ **Deployed to UAT** + `Case Note MVP Access` perm set assigned to the integration user; write-back proven |

**Net (updated 2026-06-02, local session):** read path proven, and write-back is now **unblocked**.
The org-custom `Case_Note_MVP__c` is deployed to UAT, the `Case Note MVP Access` perm set is
assigned to the integration user, and `npm run write:test` confirmed the Salesforce-Integration
user can create a record there (the managed `enrtcr__Note__c` had `createable=false`).
`drainOutbox.ts` now upserts notes into `Case_Note_MVP__c` keyed on the `Mobile_Outbox_Id__c`
External Id (the Supabase note id), replacing the old body-stamp scan. Not yet exercised against a
live `job_notes` row (outbox empty at hand-off).

### Commits delivered this session (on the branch)
- `fix(sync)`: `node:crypto` imported as ESM (was `require()` in an ESM pkg → blocked JWT signing)
- `fix(sync)`: note idempotency check no longer filters a Long Text Area field (invalid SOQL)
- `docs(sync)`: runbook updated with the Contact-license + note-write findings
- `feat(salesforce)`: `Case_Note_MVP__c` object + `Case Note MVP Access` perm set + write-test harness

---

## 2. Fixed facts (verified this session)

- **Supabase:** project `Mobile MVP`, ref `xgkvdnaciymazdxxxoxu`, region ap-southeast-2.
  `SUPABASE_URL=https://xgkvdnaciymazdxxxoxu.supabase.co`
- **Salesforce UAT (use this):** `CareChoice` / instance **AUS24S** / sandbox, org id
  `00D9p00000B60rpEAB`, login `https://test.salesforce.com`.
- **Salesforce PROD (do NOT touch):** instance **AUS92**, org id `00D5g0000062TbVEAU`.
- **Integration user:** `0059p00000SbMvtAAF`, profile "Minimum Access - API Only Integrations",
  license **Salesforce Integration** (least-privilege by design — see §6).
- **Perm set:** `MVP_Sync_Integration_Access` (`0PS9p000003lptNGAQ`).
- **Resource being synced:** `a2sI80000000UtHIAU` (test worker `worker@example.com` maps via
  `profiles.salesforce_resource_id`).

---

## 3. Why Contact access matters (already resolved)

The read query links jobs/meds/notes to a client via Contact lookups
(`sked__Job__c.sked__Contact__c`, `enrtcr__Medication__c.Client__c`, `enrtcr__Note__c.enrtcr__Client__c`).
The integration user couldn't read `Contact` (license blocks granting it directly). Fix that
was applied (keep, don't undo): assign the **Salesforce API Integration** permission-set license
(`0PLI800000000MxOAI`, 4 free seats) to the user, then grant `Contact` object Read on
`MVP_Sync_Integration_Access`. This is a **permission-set-license** change, *not* a base-license
or profile change. The sync only stores the Contact **record Id** (`client_sf_id`), never PII.

---

## 4. Local setup

```bash
git clone https://github.com/CareChoice-Dev/Mobile-APP-MVP.git
cd Mobile-APP-MVP
git checkout claude/brave-edison-LWhGO
```

**Things not in git (recreate locally):**

1. **Secrets — `sync/.env`** (gitignored). `cp sync/.env.example sync/.env` and fill in:
   - `SF_CLIENT_ID` — Consumer Key of the UAT External Client App
   - `SF_USERNAME` — the integration user's login
   - `SUPABASE_SERVICE_ROLE_KEY` — Supabase dashboard → Project Settings → API → `service_role`
   - Non-secret: `SF_LOGIN_URL=https://test.salesforce.com`,
     `SF_RESOURCE_ID=a2sI80000000UtHIAU`,
     `SUPABASE_URL=https://xgkvdnaciymazdxxxoxu.supabase.co`,
     `SF_PRIVATE_KEY_PATH=./server.key`

2. **JWT keypair** (ephemeral, gitignored — `*.key`/`*.crt`):
   ```bash
   cd sync
   openssl genrsa -out server.key 2048
   openssl req -new -x509 -key server.key -days 365 -out server.crt -subj "/CN=carechoice-mvp-sync"
   ```
   Then upload `server.crt` to the UAT External Client App (Settings → OAuth → **JWT Bearer Flow**),
   save, wait ~1–2 min. (Re-upload needed whenever you regenerate the key.)

3. **Dependencies:** `cd sync && npm install` (and `cd app && npm install` for the Expo app).

**Run:**
```bash
cd sync
DRY_RUN=1 npm run sync:read     # prove JWT auth + reads (no writes)
DRY_RUN=0 npm run sync:read     # upsert jobs + meds → Supabase
# npm run drain                 # notes → SF (blocked until Case_Note_MVP__c, see §5)
```
No special network policy needed locally — just internet to `*.salesforce.com` / `*.supabase.co`.

---

## 5. Finish the write-back (`Case_Note_MVP__c`)

> ✅ **DONE 2026-06-02** — deployed to UAT (`carechoice-uat`, org `00D9p00000B60rpEAB`) via
> `sf project deploy start`; `Case Note MVP Access` assigned to the integration user;
> `npm run write:test` created record `aCO9p0000000hhhGAA`; `drainOutbox.ts` repointed.
> The steps below are kept as the runbook for a fresh org / re-deploy.

The object + fields + permission set are authored at `salesforce/mdapi/` (see
`salesforce/README.md`). Deploying it needs an admin with `ModifyMetadata` (the integration
user is intentionally too restricted — see §6). Locally:

```bash
sf org login web --instance-url https://test.salesforce.com --alias cc-uat   # log in as an ADMIN
sf project deploy start --metadata-dir salesforce/mdapi --target-org cc-uat   # confirm it lands in AUS24S
```

After deploy:
1. Assign the **Case Note MVP Access** perm set to the integration user
   (Setup → Permission Sets → Manage Assignments).
2. Prove write-back works as the integration user:
   ```bash
   cd sync && npm run write:test     # upserts one Case_Note_MVP__c by External Id + verifies
   ```
3. Then wire `drainOutbox.ts` to target `Case_Note_MVP__c` (model already in `SF.caseNoteMvp`)
   and switch idempotency to an **External-Id upsert** on `Mobile_Outbox_Id__c` (drop the
   body-stamp `LIKE` scan).

---

## 6. Guardrails / gotchas

- **Never touch prod AUS92.** Always confirm the org instance before any write.
- **Keep the integration user least-privilege.** Do *not* grant it `ModifyMetadata`/`ModifyAllData`
  just to deploy schema — deploy as an admin instead.
- **Secrets:** `.env`, `*.key`, `*.crt`, `*.pem` are gitignored — never commit them. Don't print
  the service-role key or client secret.
- **`drainOutbox.ts` known state:** the idempotency check now filters by the Job lookup and matches
  the `outbox:` stamp client-side (a Long Text Area can't be filtered in SOQL). The existing UAT
  test note `a0x9p000002Xru1AAC` carries an `outbox:` stamp from an earlier successful drain (by a
  more-privileged identity). Cleanup-pending test notes in UAT: `a0x9p000002Xru1AAC`,
  `a0x9p000002XGhZAAW`.

---

## 7. Backlog / next steps

1. ✅ **Done 2026-06-02** — `Case_Note_MVP__c` deployed to UAT, perms assigned, `npm run write:test` passed.
2. ✅ **Done 2026-06-02** — `drainOutbox.ts` repointed to `Case_Note_MVP__c` via External-Id upsert
   (verify next session against a real pending `job_notes` row — outbox was empty here).
3. ✅ **Done 2026-06-02** — `medication_administrations` drainer (`npm run drain:meds`) upserts into
   org-custom `Med_Admin_MVP__c` by `Mobile_Outbox_Id__c`; deployed to UAT + verified e2e (incl.
   idempotency). Datetime normalized to ISO ms+Z for Salesforce; unknown outcomes fail loudly.
4. **Scheduling (read path):** Phase 1 = delta-poll every 2–5 min via Supabase Edge Function +
   `pg_cron`; Phase 2 = Salesforce **CDC / Platform Events → webhook** (seconds-level), keeping a
   reconcile poll. Both share the same upsert fn — see `architecture.md` §4. (Confirm CDC is
   licensed/enabled in the org.)
5. Optional: Supabase Realtime for live job/note-status updates in the app.

---

## 8. Git workflow (local — push only when needed)

```bash
git add -p && git commit -m "..."                  # commit locally as often as you like
git push origin claude/brave-edison-LWhGO          # only when you want it on GitHub
```
Running Claude Code locally won't auto-push — pushes are explicit. When ready to share, open a PR
from `claude/brave-edison-LWhGO`.
