import { describe, expect, it } from 'vitest';
import { TEMPLATES, USERS, GROUPS } from '../services/demo/seed';
import { cleanDetail, stableCheckId, statusEvents, usageEvents, type UsageContext } from './usage';

const [taylor, , morgan] = USERS;
const ev1120 = TEMPLATES.find((t) => t.id === 'tpl-ev1120-0326')!;
const ev1004 = TEMPLATES.find((t) => t.id === 'tpl-ev1004-0125')!;
const at = '2026-10-13T15:00:00.000Z';
const ctx = (over: Partial<UsageContext> = {}): UsageContext => ({ user: taylor, groups: GROUPS, contactId: 'c-jordan', at, batchId: 'batch-1', ...over });

describe('usageEvents', () => {
  it('writes one row per form, with the template copied onto it', () => {
    const rows = usageEvents('request.sent', ctx({ requestId: 'req-9' }), [ev1120, ev1004, ev1120]);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.formNumber)).toEqual(['EV-1120', 'EV-1004', 'EV-1120']);
    expect(rows[0]).toMatchObject({
      type: 'request.sent',
      occurredOn: at,
      userId: 'usr-advisor-1',
      templateId: 'tpl-ev1120-0326',
      revision: '03/2026',
      source: 'Everence',
      issuer: 'Everence Financial',
      category: 'Beneficiary',
      region: 'Goshen',
      groups: 'Goshen advisors',
      contactId: 'c-jordan',
      requestId: 'req-9',
      batchId: 'batch-1',
    });
    // Same batch, so one action's rows can be grouped; each row still has its own key.
    expect(new Set(rows.map((r) => r.batchId)).size).toBe(1);
    expect(new Set(rows.map((r) => r.dedupeKey)).size).toBe(3);
  });

  it('writes one row without a template when no form is involved', () => {
    const [row] = usageEvents('send.blocked', ctx(), []);
    expect(row.templateId).toBeUndefined();
    expect(row.dedupeKey).toBe('batch-1|send.blocked|-|0');
  });

  it('sets acting-for only when it is someone else', () => {
    expect(usageEvents('form.added', ctx({ actingFor: taylor }), [ev1120])[0].actingForId).toBeUndefined();
    expect(usageEvents('form.added', ctx({ user: morgan, actingFor: taylor }), [ev1120])[0]).toMatchObject({ userId: 'usr-assistant-1', actingForId: 'usr-advisor-1' });
  });

  it('keeps only allow-listed detail keys, so field values have nowhere to go', () => {
    const [row] = usageEvents('pdf.fillable', ctx(), [ev1120], {
      detail: { mode: 'fillable', signerCount: 2, auth: ['sms'], blockingChecks: ['required'], values: { 'contact.ev_ssn': '318-44-2290' }, ssn: '318-44-2290', clientName: 'Jordan Miller' },
    });
    expect(row.detail).toEqual({ mode: 'fillable', signerCount: 2, auth: ['sms'], blockingChecks: ['required'] });
    expect(JSON.stringify(row)).not.toContain('318-44-2290');
    expect(JSON.stringify(row)).not.toContain('Jordan');
  });

  it('drops detail values that aren’t plain text, numbers or lists of text', () => {
    expect(cleanDetail({ mode: { nested: 'x' }, signerCount: Number.NaN, auth: [1, 'sms', { a: 1 }] })).toEqual({ auth: ['sms'] });
    expect(cleanDetail({ other: 'x' })).toBeUndefined();
    expect(cleanDetail(undefined)).toBeUndefined();
  });

  it('gives the same rows the same dedupe keys', () => {
    const a = usageEvents('pdf.print', ctx(), [ev1120, ev1004]);
    const b = usageEvents('pdf.print', ctx(), [ev1120, ev1004]);
    expect(a.map((r) => r.dedupeKey)).toEqual(b.map((r) => r.dedupeKey));
    expect(a[0].dedupeKey).toBe('batch-1|pdf.print|tpl-ev1120-0326|0');
    // Another action is another batch.
    expect(usageEvents('pdf.print', ctx({ batchId: 'batch-2' }), [ev1120])[0].dedupeKey).not.toBe(a[0].dedupeKey);
  });

  it('keys status events by request, whoever records them and in whatever batch', () => {
    const fromCheckStatus = usageEvents('request.signed', ctx({ requestId: 'req-9', batchId: 'one' }), [ev1120, ev1004]);
    const fromConnectFlow = usageEvents('request.signed', ctx({ user: morgan, requestId: 'req-9', batchId: 'two', at: '2026-10-14T09:00:00.000Z' }), [ev1120, ev1004]);
    expect(fromCheckStatus.map((r) => r.dedupeKey)).toEqual(['req-9|request.signed|tpl-ev1120-0326|0', 'req-9|request.signed|tpl-ev1004-0125|1']);
    expect(fromConnectFlow.map((r) => r.dedupeKey)).toEqual(fromCheckStatus.map((r) => r.dedupeKey));
  });

  it('makes up a batch ID and stamps the time when not given', () => {
    const [row] = usageEvents('form.added', { user: taylor }, [ev1120]);
    expect(row.batchId).toBeTruthy();
    expect(Date.parse(row.occurredOn)).not.toBeNaN();
    expect(row.region).toBe('Goshen');
  });
});

describe('statusEvents', () => {
  const now = new Date('2026-10-13T12:00:00Z');
  it('reports viewed and signed with DocuSign’s times', () => {
    expect(statusEvents({ status: 'Sent' }, { status: 'Signed', viewedOn: '2026-10-12T10:00:00Z', signedOn: '2026-10-12T11:00:00Z' }, now)).toEqual([
      { type: 'request.viewed', at: '2026-10-12T10:00:00Z' },
      { type: 'request.signed', at: '2026-10-12T11:00:00Z' },
    ]);
  });
  it('reports viewed once', () => {
    expect(statusEvents({ status: 'Viewed', viewedOn: '2026-10-12T10:00:00Z' }, { status: 'Viewed', viewedOn: '2026-10-12T10:00:00Z' }, now)).toEqual([]);
    expect(statusEvents({ status: 'Sent' }, { status: 'Viewed' }, now)).toEqual([{ type: 'request.viewed', at: now.toISOString() }]);
  });
  it('reports declined, voided and expired', () => {
    expect(statusEvents({ status: 'Viewed', viewedOn: 'x' }, { status: 'Declined', viewedOn: 'x' }, now).map((e) => e.type)).toEqual(['request.declined']);
    expect(statusEvents({ status: 'Sent' }, { status: 'Voided' }, now).map((e) => e.type)).toEqual(['request.voided']);
    expect(statusEvents({ status: 'Sent' }, { status: 'Expired', expiresOn: '2026-10-10T00:00:00Z' }, now)).toEqual([{ type: 'request.expired', at: '2026-10-10T00:00:00Z' }]);
  });
});

describe('stableCheckId', () => {
  it('drops the packet item, so a check reads the same in every packet', () => {
    expect(stableCheckId('pi-1a2b3c4d:required')).toBe('required');
    expect(stableCheckId('pi-1a2b3c4d:check:0')).toBe('check:0');
    expect(stableCheckId('format:pi-1a2b3c4d/withholding.federal')).toBe('format:withholding.federal');
    expect(stableCheckId('state:licence')).toBe('state:licence');
  });
});
