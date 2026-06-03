// SF object/field constants (mirror of sync/src/sf-model.ts, the subset SP1 needs)
// + pure helpers for the webhook: re-fetch SOQL and row→table mapping.
export type Entity = 'sked__Job_Allocation__c' | 'sked__Job__c' | 'enrtcr__Medication__c';

const JOB_FIELDS =
  'sked__Job__c, sked__Status__c, LastModifiedDate, ' +
  'sked__Job__r.Name, sked__Job__r.sked__Job_Status__c, sked__Job__r.sked__Type__c, ' +
  'sked__Job__r.sked__Start__c, sked__Job__r.sked__Finish__c, sked__Job__r.sked__Contact__c';

const MED_FIELDS =
  'Id, Client__c, Name, Dosage__c, Route__c, Medication_Support__c, Status__c, ' +
  'Start_Date__c, End_Date__c, Instructions_to_administer_medicines__c, LastModifiedDate';

// Pure: SOQL to re-fetch the canonical record(s) for a change event, scoped to one resource.
// (Note: includes Deleted allocations so the handler can detect soft-deletes; null = skip.)
export function buildRefetchSoql(entity: Entity, recordId: string, resourceId: string): string | null {
  switch (entity) {
    case 'sked__Job_Allocation__c':
      return `SELECT Id, ${JOB_FIELDS} FROM sked__Job_Allocation__c ` +
        `WHERE Id = '${recordId}' AND sked__Resource__c = '${resourceId}'`;
    case 'sked__Job__c':
      return `SELECT Id, ${JOB_FIELDS} FROM sked__Job_Allocation__c ` +
        `WHERE sked__Job__c = '${recordId}' AND sked__Resource__c = '${resourceId}'`;
    case 'enrtcr__Medication__c':
      return `SELECT ${MED_FIELDS} FROM enrtcr__Medication__c WHERE Id = '${recordId}'`;
    default:
      throw new Error(`Unknown entity: ${entity}`);
  }
}

// deno-lint-ignore no-explicit-any
export function mapAllocationToJob(r: any, resourceId: string) {
  const j = r.sked__Job__r ?? {};
  return {
    salesforce_id: r.sked__Job__c,
    job_number: j.Name,
    status: j.sked__Job_Status__c,
    job_type: j.sked__Type__c,
    starts_at: j.sked__Start__c,
    ends_at: j.sked__Finish__c,
    client_sf_id: j.sked__Contact__c,
    resource_id: resourceId,
    allocation_status: r.sked__Status__c,
    salesforce_modified_at: r.LastModifiedDate ?? null,
    synced_at: new Date().toISOString(),
  };
}

// deno-lint-ignore no-explicit-any
export function mapMedication(r: any) {
  return {
    salesforce_id: r.Id,
    client_sf_id: r.Client__c,
    name: r.Name,
    dosage: r.Dosage__c,
    route: r.Route__c,
    support_type: r.Medication_Support__c,
    status: r.Status__c,
    start_date: r.Start_Date__c,
    end_date: r.End_Date__c,
    instructions: r.Instructions_to_administer_medicines__c,
    salesforce_modified_at: r.LastModifiedDate ?? null,
    synced_at: new Date().toISOString(),
  };
}
