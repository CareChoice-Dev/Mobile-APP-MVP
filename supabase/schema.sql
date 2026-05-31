-- ===========================================================================
-- CareChoice Mobile MVP — Supabase schema
-- Grounded in the UAT-verified Salesforce model (see docs/architecture.md §11).
--
-- Model recap (current org, worker assumed to have NO Salesforce login):
--   Supabase user  ──(profiles.salesforce_resource_id)──▶  sked__Resource__c
--   sked__Job_Allocation__c (junction)  links Resource ──▶ sked__Job__c
--   enrtcr__Medication__c  is the client's chart (Client__c → Contact)
--   Write-back outboxes push enrtcr__Note__c and enrtcr__Medication_Administered__c
--
-- The sync service writes everything with the service-role key (bypasses RLS).
-- The app uses the anon key + a user JWT; RLS is the ONLY per-user boundary.
-- ===========================================================================

-- 1. PROFILES -- 1:1 with auth.users; the per-user mapping anchor ----------
create table public.profiles (
  id                      uuid primary key references auth.users(id) on delete cascade,
  -- The worker's Salesforce sked__Resource__c Id. This is the ONLY binding
  -- between an app user and "their" Salesforce data. Seeded at onboarding
  -- (manually for the MVP; via a Resource External Id in the new org).
  salesforce_resource_id  text unique not null,
  display_name            text,
  created_at              timestamptz not null default now()
);

-- 2. JOBS -- mirror of sked__Job__c (only the working-set fields) ----------
create table public.jobs (
  id                   uuid primary key default gen_random_uuid(),
  salesforce_id        text unique not null,          -- sked__Job__c.Id (upsert key)
  job_number           text,                          -- sked__Job__c.Name (e.g. JOB-489896)
  status               text,                          -- sked__Job__c.sked__Job_Status__c
  job_type             text,                          -- sked__Job__c.sked__Type__c
  starts_at            timestamptz,                   -- sked__Start__c
  ends_at              timestamptz,                   -- sked__Finish__c
  -- The worker this job is mirrored for (from sked__Job_Allocation__c).
  resource_id          text not null,                 -- sked__Job_Allocation__c.sked__Resource__c
  allocation_status    text,                          -- sked__Job_Allocation__c.sked__Status__c
  -- The client on the job (sked__Contact__c). Resolve med chart via this.
  client_sf_id         text,                          -- Contact Id
  salesforce_modified_at timestamptz,
  synced_at            timestamptz not null default now()
);
create index on public.jobs (resource_id);
create index on public.jobs (client_sf_id);

-- 3. MEDICATIONS -- mirror of enrtcr__Medication__c (the client's chart) ----
create table public.medications (
  id                   uuid primary key default gen_random_uuid(),
  salesforce_id        text unique not null,          -- enrtcr__Medication__c.Id
  client_sf_id         text not null,                 -- Client__c (Contact)
  name                 text,                          -- Name (drug)
  dosage               text,                          -- Dosage__c
  route                text,                          -- Route__c
  support_type         text,                          -- Medication_Support__c
  status               text,                          -- Status__c (Active|Closed)
  start_date           date,                          -- Start_Date__c
  end_date             date,                          -- End_Date__c
  instructions         text,                          -- Instructions_to_administer_medicines__c
  salesforce_modified_at timestamptz,
  synced_at            timestamptz not null default now()
);
create index on public.medications (client_sf_id);

-- 4. JOB_NOTES -- write-back OUTBOX → enrtcr__Note__c ----------------------
create table public.job_notes (
  id                 uuid primary key default gen_random_uuid(),  -- idempotency key
  job_id             uuid not null references public.jobs(id),
  author_id          uuid not null references auth.users(id) default auth.uid(),
  body               text not null,
  note_type          text not null default 'Case Note',           -- enrtcr__Type__c
  status             text not null default 'pending'
                       check (status in ('pending','syncing','synced','error')),
  salesforce_note_id text,                                         -- enrtcr__Note__c.Id once created
  attempts           int not null default 0,
  last_error         text,
  created_at         timestamptz not null default now(),
  synced_at          timestamptz
);
create index on public.job_notes (status) where status in ('pending','error');

-- 5. MEDICATION_ADMINISTRATIONS -- write-back OUTBOX → enrtcr__Medication_Administered__c
create table public.medication_administrations (
  id                 uuid primary key default gen_random_uuid(),  -- idempotency key
  medication_id      uuid not null references public.medications(id),
  job_id             uuid references public.jobs(id),
  administered_by    uuid not null references auth.users(id) default auth.uid(),
  -- 'given' maps to Administered__c=true; the rest map to Reason_for_not_administering__c
  outcome            text not null check (outcome in ('given','refused','withheld','not_available','absent','fasting','vomiting','on_leave','missed')),
  routine            text check (routine in ('Breakfast','Lunch','Dinner','Bed')),  -- Administered_Routine__c
  dose_given         text,
  administered_at    timestamptz not null,                        -- captured on device; → Administered_Date_Time__c
  comments           text,                                        -- Comments__c
  witness            text,                                        -- Witness__c
  status             text not null default 'pending'
                       check (status in ('pending','syncing','synced','error')),
  salesforce_id      text,
  attempts           int not null default 0,
  last_error         text,
  created_at         timestamptz not null default now(),
  synced_at          timestamptz
);
create index on public.medication_administrations (status) where status in ('pending','error');

-- ===========================================================================
-- ROW-LEVEL SECURITY -- the entire per-user boundary
-- ===========================================================================
alter table public.profiles                   enable row level security;
alter table public.jobs                        enable row level security;
alter table public.medications                 enable row level security;
alter table public.job_notes                   enable row level security;
alter table public.medication_administrations  enable row level security;

-- Helper: the current user's Salesforce resource id.
create or replace function public.current_resource_id()
returns text language sql stable security definer set search_path = public as $$
  select salesforce_resource_id from public.profiles where id = auth.uid()
$$;

-- profiles: read own row only
create policy "read own profile" on public.profiles
  for select to authenticated using (id = auth.uid());

-- jobs: read only jobs mirrored for my resource
create policy "read my jobs" on public.jobs
  for select to authenticated
  using (resource_id = public.current_resource_id());

-- medications: read only meds for a client I have a job with
create policy "read my clients meds" on public.medications
  for select to authenticated
  using (exists (
    select 1 from public.jobs j
    where j.client_sf_id = medications.client_sf_id
      and j.resource_id = public.current_resource_id()
  ));

-- job_notes: read my own; insert only on my jobs, as myself, pending only
create policy "read own notes" on public.job_notes
  for select to authenticated using (author_id = auth.uid());
create policy "add notes to my jobs" on public.job_notes
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and status = 'pending'
    and exists (
      select 1 from public.jobs j
      where j.id = job_notes.job_id
        and j.resource_id = public.current_resource_id()
    )
  );

-- medication_administrations: read own; insert only for meds of my clients
create policy "read own administrations" on public.medication_administrations
  for select to authenticated using (administered_by = auth.uid());
create policy "add administrations for my clients" on public.medication_administrations
  for insert to authenticated
  with check (
    administered_by = auth.uid()
    and status = 'pending'
    and exists (
      select 1
      from public.medications m
      join public.jobs j on j.client_sf_id = m.client_sf_id
      where m.id = medication_administrations.medication_id
        and j.resource_id = public.current_resource_id()
    )
  );

-- NOTE: no UPDATE/DELETE policies for `authenticated`. Only the sync service
-- (service-role, bypasses RLS) advances outbox status / writes salesforce ids.
