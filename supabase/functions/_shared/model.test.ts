import { assertEquals, assertThrows } from 'jsr:@std/assert';
import { buildRefetchSoql, mapAllocationToJob, type Entity } from './model.ts';

const RES = 'a2sI80000000UtHIAU';

Deno.test('buildRefetchSoql: allocation filters by Id + resource', () => {
  const soql = buildRefetchSoql('sked__Job_Allocation__c', 'a2X1', RES);
  assertEquals(soql!.includes("WHERE Id = 'a2X1'"), true);
  assertEquals(soql!.includes(`sked__Resource__c = '${RES}'`), true);
  assertEquals(soql!.includes('FROM sked__Job_Allocation__c'), true);
});

Deno.test('buildRefetchSoql: job filters by job lookup + resource', () => {
  const soql = buildRefetchSoql('sked__Job__c', 'a2J1', RES);
  assertEquals(soql!.includes("sked__Job__c = 'a2J1'"), true);
  assertEquals(soql!.includes(`sked__Resource__c = '${RES}'`), true);
});

Deno.test('buildRefetchSoql: medication filters by Id', () => {
  const soql = buildRefetchSoql('enrtcr__Medication__c', 'a0M1', RES);
  assertEquals(soql!.includes("WHERE Id = 'a0M1'"), true);
  assertEquals(soql!.includes('FROM enrtcr__Medication__c'), true);
});

Deno.test('buildRefetchSoql: unknown entity throws', () => {
  assertThrows(() => buildRefetchSoql('Bogus__c' as Entity, 'x', RES), Error, 'Unknown entity');
});

Deno.test('mapAllocationToJob maps the joined row to a jobs upsert', () => {
  const row = {
    sked__Job__c: 'a2J1',
    sked__Status__c: 'Confirmed',
    sked__Job__r: {
      Name: 'JOB-1', sked__Job_Status__c: 'Dispatched', sked__Type__c: 'Visit',
      sked__Start__c: '2026-06-02T01:00:00.000+0000', sked__Finish__c: '2026-06-02T02:00:00.000+0000',
      sked__Contact__c: '0031',
    },
  };
  const job = mapAllocationToJob(row, RES);
  assertEquals(job.salesforce_id, 'a2J1');
  assertEquals(job.job_number, 'JOB-1');
  assertEquals(job.status, 'Dispatched');
  assertEquals(job.client_sf_id, '0031');
  assertEquals(job.resource_id, RES);
  assertEquals(job.allocation_status, 'Confirmed');
});
