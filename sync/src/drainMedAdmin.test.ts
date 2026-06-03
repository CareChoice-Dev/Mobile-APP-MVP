import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMedAdminPayload } from './drainMedAdmin.js';

const base = {
  id: 'abc-123-uuid',
  routine: 'Breakfast' as string | null,
  dose_given: '5mg' as string | null,
  administered_at: '2026-06-02T08:00:00.000Z',
  comments: 'note' as string | null,
  witness: 'RN Jo' as string | null,
  medication_sf_id: 'a0xMED000000001',
  client_sf_id: '0035g00000c6xZEAAY' as string | null,
  job_sf_id: 'a2Z9p000001dUfBEAU' as string | null,
  resource_id: 'a2sI80000000UtHIAU' as string | null,
};

test('given → Administered__c true, reason null, key fields mapped', () => {
  const p = buildMedAdminPayload({ ...base, outcome: 'given' });
  assert.equal(p.Administered__c, true);
  assert.equal(p.Reason_Not_Administered__c, null);
  assert.equal(p.Mobile_Outbox_Id__c, 'abc-123-uuid');
  assert.equal(p.Medication__c, 'a0xMED000000001');
  assert.equal(p.Administered_At__c, '2026-06-02T08:00:00.000Z');
  assert.equal(p.Submitted_By_Resource__c, 'a2sI80000000UtHIAU');
  assert.equal(p.Name, 'Med admin — a0xMED000000001');
});

test('refused → Administered__c false, mapped reason', () => {
  const p = buildMedAdminPayload({ ...base, outcome: 'refused' });
  assert.equal(p.Administered__c, false);
  assert.equal(p.Reason_Not_Administered__c, 'R - Refused');
});

test('every non-given outcome maps to a non-empty reason', () => {
  for (const o of ['refused', 'withheld', 'not_available', 'absent', 'fasting', 'vomiting', 'on_leave', 'missed']) {
    const p = buildMedAdminPayload({ ...base, outcome: o });
    assert.equal(p.Administered__c, false, `${o} should be not-administered`);
    assert.ok(p.Reason_Not_Administered__c, `expected a reason for ${o}`);
  }
});

test('null optional fields are omitted (undefined), not sent as null', () => {
  const p = buildMedAdminPayload({ ...base, outcome: 'given', client_sf_id: null, job_sf_id: null, routine: null, dose_given: null, comments: null, witness: null, resource_id: null });
  assert.equal(p.Client__c, undefined);
  assert.equal(p.Job__c, undefined);
  assert.equal(p.Routine__c, undefined);
});

test('unknown outcome throws (defense-in-depth vs enum drift)', () => {
  assert.throws(() => buildMedAdminPayload({ ...base, outcome: 'teleported' }), /Unknown medication outcome/);
});
