// ---------------------------------------------------------------------------
// Salesforce object/field constants — VERIFIED against CareChoice UAT (AUS24S).
// See docs/architecture.md §11. Centralised so the new-org migration is a
// one-file change if API names differ.
// ---------------------------------------------------------------------------

export const SF = {
  jobAllocation: {
    object: 'sked__Job_Allocation__c',
    resource: 'sked__Resource__c', // Master-Detail(Resource) — the worker
    job: 'sked__Job__c', // Master-Detail(Job)
    status: 'sked__Status__c', // Pending Dispatch|Dispatched|Confirmed|En Route|Checked In|In Progress|Complete|Declined|Deleted
    uniqueKey: 'sked__UniqueKey__c', // stable natural key (unique, not External Id)
  },
  job: {
    object: 'sked__Job__c',
    name: 'Name', // JOB-#######
    status: 'sked__Job_Status__c',
    type: 'sked__Type__c',
    start: 'sked__Start__c',
    finish: 'sked__Finish__c',
    contact: 'sked__Contact__c', // the client (Contact)
  },
  medication: {
    object: 'enrtcr__Medication__c',
    client: 'Client__c', // Contact
    name: 'Name',
    dosage: 'Dosage__c',
    route: 'Route__c',
    support: 'Medication_Support__c', // Self Administered|Administer|Assistance Needed
    status: 'Status__c', // Active|Closed
    startDate: 'Start_Date__c',
    endDate: 'End_Date__c',
    instructions: 'Instructions_to_administer_medicines__c',
  },
  note: {
    object: 'enrtcr__Note__c',
    name: 'Name', // Title
    status: 'enrtcr__Status__c', // Draft|Completed
    type: 'enrtcr__Type__c', // e.g. "Case Note", "Progress notes (Support worker)"
    job: 'skedhealthcare__Job__c', // → sked__Job__c
    client: 'enrtcr__Client__c', // → Contact
    description: 'enrtcr__Description__c', // body (Long Text 32768)
    serviceNoteDate: 'enrtcr__Service_Note_Date__c',
    // NB: Created_by_Name__c is NOT writable (formula). Attribution for the new
    // org should be a dedicated writable custom field; the MVP stamps the body.
  },
  medAdministered: {
    object: 'enrtcr__Medication_Administered__c',
    medication: 'enrtcr__Medication__c', // Master-Detail(Medication)
    person: 'Person_Administering__c', // → sked__Resource__c (works with no User!)
    administeredAt: 'Administered_Date_Time__c', // required datetime
    routine: 'Administered_Routine__c', // Breakfast|Lunch|Dinner|Bed
    reasonNotAdministered: 'Reason_for_not_administering__c',
    comments: 'Comments__c',
    witness: 'Witness__c',
  },
} as const;

// Map our outbox `outcome` enum to the SF refusal-reason picklist (verbatim).
export const REASON_BY_OUTCOME: Record<string, string | null> = {
  given: null,
  refused: 'R - Refused',
  absent: 'A - Absent',
  fasting: 'F - Fasting',
  vomiting: 'V - Vomiting',
  on_leave: 'L - On Leave',
  not_available: 'N - Not Available',
  withheld: 'W - Withheld',
  missed: 'M - Missed',
};
