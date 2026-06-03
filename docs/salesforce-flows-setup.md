# SP1 — Salesforce push setup (UAT `carechoice-uat`)

Admin runbook for the instant-read path: record-triggered **Flows** that HTTP-callout to the
Supabase `sf-webhook` Edge Function on every create/update/delete. Built in **Setup UI**
(hand-authored Flow MDAPI is brittle); optionally retrieve to `salesforce/mdapi/` afterward for
version control. Prereq: the `sf-webhook` function is deployed and you have its URL + the
`SF_WEBHOOK_SECRET` value (see the SP1 plan, Tasks 5–6).

## 1. External Credential (shared-secret auth to the webhook)
Setup → Named Credentials → **External Credentials** → New:
- Label / Name: `Supabase_Webhook`; Authentication Protocol: **Custom**.
- Add a **Named Principal** (Identity type) `webhook` with a **Custom Header**:
  - Name: `x-webhook-secret`   Value: `<SF_WEBHOOK_SECRET from the Supabase secret>`
- Under **Principal Access**, add the permission set of the user(s)/automation running the Flow.

## 2. Named Credential
Setup → Named Credentials → New:
- Label / Name: `Supabase_Webhook`
- URL: `https://xgkvdnaciymazdxxxoxu.supabase.co`
- External Credential: `Supabase_Webhook`
- Enable **Allow Formulas in HTTP Header** (and Generate Authorization Header = off; the secret is the custom header).

## 3. Record-triggered Flow per object (repeat for all three)
For each of `sked__Job__c`, `sked__Job_Allocation__c`, `enrtcr__Medication__c`:

**Create/Update Flow** — Setup → Flows → New → **Record-Triggered Flow**:
- Object: the object; Trigger: **A record is created or updated**; Optimize for: **Actions and Related Records** (after-save).
- Add an **Asynchronous path** (callouts can't run in the triggering transaction).
- On the async path, add an **HTTP Callout** action on Named Credential `Supabase_Webhook`:
  - Method: `POST`   Path: `/functions/v1/sf-webhook`
  - Header: `Content-Type: application/json`
  - Body (text template): `{ "entity": "<OBJECT_API_NAME>", "recordId": "{!$Record.Id}", "changeType": "UPDATE" }`
    (CREATE vs UPDATE doesn't matter — the webhook upserts either way.)
- Activate.

**Delete Flow** — New Record-Triggered Flow on the same object, Trigger **A record is deleted** → Async path → same HTTP Callout but body `{ "entity": "<OBJECT_API_NAME>", "recordId": "{!$Record.Id}", "changeType": "DELETE" }`. Activate.

## Fallback — delete via Apex (if the Flow delete-trigger can't make a callout in this org)
`after delete` trigger collects `Trigger.old` Ids → enqueues a `Queueable` (implements
`Database.AllowsCallouts`) that POSTs each `{ "entity", "recordId", "changeType":"DELETE" }` to the
Named Credential endpoint `callout:Supabase_Webhook/functions/v1/sf-webhook`.

## Verify
After activating, edit a Job/Medication in `carechoice-uat`; the Supabase row should update within
seconds (see the SP1 plan Task 8 for the exact checks). The webhook is idempotent (upsert by
`salesforce_id`), so retries are safe.
