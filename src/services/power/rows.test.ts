import { describe, expect, it } from 'vitest';
import { problemReport } from '../../domain/feedback';
import type { SignatureRequest, SignatureStatus } from '../../domain/types';
import { usageEvents } from '../../domain/usage';
import { seedRequests, TEMPLATES, USERS } from '../demo/seed';
import { FEEDBACK_KIND_OPTIONS, FEEDBACK_STATUS_OPTIONS, SIGNATURE_STATUS_OPTIONS, USAGE_EVENT_OPTIONS } from './config';
import { bind, feedbackRow, fromFeedbackRow, isDuplicateKeyError, requestRow, usageRow } from './rows';

const OWNER = '6f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f';
const PREPARER = '0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d';
const TEMPLATE = '11111111-2222-3333-4444-555555555555';

const base = (): SignatureRequest => ({ ...seedRequests()[0], ownerId: OWNER, preparedById: PREPARER });

describe('requestRow', () => {
  const statuses: SignatureStatus[] = ['Drafted', 'Sent', 'Viewed', 'Signed', 'Declined', 'Voided', 'Expired'];
  it.each(statuses)('promotes the reporting columns for a %s request', (status) => {
    const r = { ...base(), status, viewedOn: status === 'Drafted' || status === 'Sent' ? undefined : '2026-10-10T12:00:00.000Z' };
    const row = requestRow(r);
    expect(row.ev_status).toBe(SIGNATURE_STATUS_OPTIONS[status]);
    expect(row).toMatchObject({
      'ev_owner@odata.bind': `/systemusers(${OWNER})`,
      'ev_preparedby@odata.bind': `/systemusers(${PREPARER})`,
      ev_viewedon: r.viewedOn ?? null,
      ev_inperson: false,
      ev_formcount: r.documents.length,
    });
    expect(JSON.parse(row.ev_payload).status).toBe(status);
  });

  it('marks a packet printed to sign in person', () => {
    const row = requestRow({ ...base(), status: 'Drafted', inPerson: true, expiresOn: undefined });
    expect(row.ev_inperson).toBe(true);
    expect(row.ev_expireson).toBeNull();
  });

  it('leaves out a lookup with no user (rows from before owners were recorded)', () => {
    const row = requestRow({ ...base(), ownerId: undefined, preparedById: 'usr-advisor-1' });
    expect(row).not.toHaveProperty('ev_owner@odata.bind');
    expect(row).not.toHaveProperty('ev_preparedby@odata.bind');
  });
});

describe('usageRow', () => {
  it('writes the columns the report reads, with lookups and the dedupe key', () => {
    const t = { ...TEMPLATES[0], id: TEMPLATE };
    const user = { ...USERS[2], systemuserid: PREPARER };
    const [e] = usageEvents('request.sent', { user, actingFor: { systemuserid: OWNER }, contactId: 'c-not-a-guid', requestId: OWNER, at: '2026-10-13T15:00:00.000Z', batchId: 'b1' }, [t], { detail: { signerCount: 2 } });
    const row = usageRow(e);
    expect(row).toMatchObject({
      ev_name: `request.sent ${t.formNumber}`,
      ev_eventtype: USAGE_EVENT_OPTIONS['request.sent'],
      ev_occurredon: '2026-10-13T15:00:00.000Z',
      'ev_user@odata.bind': `/systemusers(${PREPARER})`,
      'ev_actingfor@odata.bind': `/systemusers(${OWNER})`,
      'ev_template@odata.bind': `/ev_formtemplates(${TEMPLATE})`,
      'ev_request@odata.bind': `/ev_signaturerequests(${OWNER})`,
      ev_formnumber: t.formNumber,
      ev_revision: t.revision,
      ev_batchid: 'b1',
      ev_dedupekey: e.dedupeKey,
      ev_detail: '{"signerCount":2}',
    });
    // A demo ID isn't a GUID: no bind, rather than a row Dataverse would refuse.
    expect(row).not.toHaveProperty('ev_contact@odata.bind');
  });

  it('has an option value for every event type', () => {
    expect(new Set(Object.values(USAGE_EVENT_OPTIONS)).size).toBe(13);
  });
});

describe('feedback rows', () => {
  it('round-trips a problem report', () => {
    const p = { ...problemReport({ ...TEMPLATES[0], id: TEMPLATE }, { category: 'missingField', fieldKeys: [TEMPLATES[0].mapping.fields[0].pdfField], note: 'x' }, { ...USERS[0], systemuserid: OWNER }), status: 'inProgress' as const };
    const row = feedbackRow(p);
    expect(row).toMatchObject({ ev_kind: FEEDBACK_KIND_OPTIONS.problem, ev_status: FEEDBACK_STATUS_OPTIONS.inProgress, 'ev_requester@odata.bind': `/systemusers(${OWNER})`, 'ev_template@odata.bind': `/ev_formtemplates(${TEMPLATE})`, ev_requestedby: 'Taylor Brenneman' });
    const back = fromFeedbackRow({ ev_formrequestid: 'r1', ...row, ev_payload: row.ev_payload } as never);
    expect(back).toEqual({ ...p, id: 'r1' });
  });

  it('shows rows from before feedback (text only) as new requests', () => {
    expect(fromFeedbackRow({ ev_formrequestid: 'old', ev_name: 'HSA enrollment', ev_issuer: 'Praxis', ev_note: 'please', ev_requestedby: 'Morgan Beachy', createdon: '2026-01-02T00:00:00Z' })).toEqual({
      id: 'old',
      kind: 'request',
      name: 'HSA enrollment',
      issuer: 'Praxis',
      note: 'please',
      category: undefined,
      requestedById: undefined,
      requestedBy: 'Morgan Beachy',
      createdOn: '2026-01-02T00:00:00Z',
      status: 'new',
    });
  });

  it('takes the status column over the payload, so a flow can change it', () => {
    const row = feedbackRow({ kind: 'request', name: 'x', requestedBy: 'A', createdOn: 'now', status: 'new' });
    expect(fromFeedbackRow({ ev_formrequestid: 'r', ev_payload: row.ev_payload, ev_status: FEEDBACK_STATUS_OPTIONS.wontFix }).status).toBe('wontFix');
  });
});

describe('helpers', () => {
  it('binds only GUIDs', () => {
    expect(bind('ev_user', 'systemusers', OWNER)).toEqual({ 'ev_user@odata.bind': `/systemusers(${OWNER})` });
    expect(bind('ev_user', 'systemusers', 'usr-advisor-1')).toEqual({});
    expect(bind('ev_user', 'systemusers', undefined)).toEqual({});
  });
  it('recognises a duplicate alternate key', () => {
    expect(isDuplicateKeyError({ code: '0x80060892' })).toBe(true);
    expect(isDuplicateKeyError({ message: 'A record with matching key values already exists.' })).toBe(true);
    expect(isDuplicateKeyError({ message: 'Failed to fetch' })).toBe(false);
  });
});
