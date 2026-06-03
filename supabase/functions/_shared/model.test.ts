import { assertEquals, assertThrows } from 'jsr:@std/assert';
import { buildRefetchSoql, mapAllocationToJob, mapMedication, type Entity } from './model.ts';

const RES = 'a2sI80000000UtHIAU';

Deno.test('buildRefetchSoql: allocation filters by Id + resource', () => {
  const soql = buildRefetchSoql('sked__Job_Allocation__c', 'a2X000000000001', RES);
  assertEquals(soql!.includes("WHERE Id = 'a2X000000000001'"), true);
  assertEquals(soql!.includes(`sked__Resource__c = '${RES}'`), true);
  assertEquals(soql!.includes('FROM sked__Job_Allocation__c'), true);
});

Deno.test('buildRefetchSoql: job filters by job lookup + resource', () => {
  const soql = buildRefetchSoql('sked__Job__c', 'a2J000000000001', RES);
  assertEquals(soql!.includes("sked__Job__c = 'a2J000000000001'"), true);
  assertEquals(soql!.includes(`sked__Resource__c = '${RES}'`), true);
});

Deno.test('buildRefetchSoql: medication filters by Id', () => {
  const soql = buildRefetchSoql('enrtcr__Medication__c', 'a0M000000000001', RES);
  assertEquals(soql!.includes("WHERE Id = 'a0M000000000001'"), true);
  assertEquals(soql!.includes('FROM enrtcr__Medication__c'), true);
});

Deno.test('buildRefetchSoql: unknown entity throws', () => {
  assertThrows(() => buildRefetchSoql('Bogus__c' as Entity, 'a0M000000000001', RES), Error, 'Unknown entity');
});

Deno.test('buildRefetchSoql: invalid record id throws (SOQL-injection guard)', () => {
  assertThrows(() => buildRefetchSoql('sked__Job__c', "x' OR Name != '", RES), Error, 'Invalid Salesforce id');
});

Deno.test('mapAllocationToJob maps the joined row to a jobs upsert (latest modified)', () => {
  const row = {
    sked__Job__c: 'a2J1',
    sked__Status__c: 'Confirmed',
    LastModifiedDate: '2026-06-02T01:00:00.000+0000',
    sked__Job__r: {
      Name: 'JOB-1', sked__Job_Status__c: 'Dispatched', sked__Type__c: 'Visit',
      sked__Start__c: '2026-06-02T01:00:00.000+0000', sked__Finish__c: '2026-06-02T02:00:00.000+0000',
      sked__Contact__c: '0031', LastModifiedDate: '2026-06-02T03:00:00.000+0000',
    },
  };
  const job = mapAllocationToJob(row, RES);
  assertEquals(job.salesforce_id, 'a2J1');
  assertEquals(job.job_number, 'JOB-1');
  assertEquals(job.status, 'Dispatched');
  assertEquals(job.client_sf_id, '0031');
  assertEquals(job.resource_id, RES);
  assertEquals(job.allocation_status, 'Confirmed');
  assertEquals(job.salesforce_modified_at, '2026-06-02T03:00:00.000+0000'); // job is later than allocation
});

Deno.test('mapMedication maps med fields incl. support_type alias', () => {
  const row = {
    Id: 'a0M1', Client__c: '0031', Name: 'Paracetamol', Dosage__c: '500mg', Route__c: 'Oral',
    Medication_Support__c: 'Administer', Status__c: 'Active', Start_Date__c: '2026-06-01', End_Date__c: null,
    Instructions_to_administer_medicines__c: 'with food', LastModifiedDate: '2026-06-02T03:00:00.000+0000',
  };
  const med = mapMedication(row);
  assertEquals(med.salesforce_id, 'a0M1');
  assertEquals(med.client_sf_id, '0031');
  assertEquals(med.name, 'Paracetamol');
  assertEquals(med.support_type, 'Administer');
  assertEquals(med.status, 'Active');
  assertEquals(med.salesforce_modified_at, '2026-06-02T03:00:00.000+0000');
});
