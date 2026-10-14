import { describe, expect, it } from 'vitest';
import { TEMPLATES, USERS } from '../services/demo/seed';
import { filterFeedback, formRequest, newlyResolved, openProblemCounts, problemReport, resolveFeedback, type FormFeedback } from './feedback';

const taylor = USERS[0];
const ev1120 = TEMPLATES.find((t) => t.id === 'tpl-ev1120-0326')!;
const now = new Date('2026-10-13T15:00:00Z');

describe('problemReport', () => {
  it('stores the form, revision, category, fields and note, and no field values', () => {
    const row = problemReport(
      ev1120,
      {
        category: 'wrongValue',
        fieldKeys: ['Acct_Number', 'Acct_Number', 'Not_A_Field'],
        note: '  Prints in the wrong box  ',
        // Anything else that might carry client data is dropped.
        detail: { otherForms: ['EV-1004'], accountType: 'Roth IRA', pdfKind: 'fillable', values: { 'account.ev_accountno': '7712-0045' }, ssn: '318-44-2290' },
      },
      taylor,
      now,
    );
    expect(row).toEqual({
      kind: 'problem',
      name: 'Beneficiary designation',
      issuer: 'Everence Financial',
      templateId: 'tpl-ev1120-0326',
      formNumber: 'EV-1120',
      revision: '03/2026',
      category: 'wrongValue',
      fieldKeys: ['Acct_Number'],
      note: 'Prints in the wrong box',
      requestedById: 'usr-advisor-1',
      requestedBy: 'Taylor Brenneman',
      createdOn: now.toISOString(),
      status: 'new',
      detail: { otherForms: ['EV-1004'], accountType: 'Roth IRA', pdfKind: 'fillable' },
    });
    expect(JSON.stringify(row)).not.toMatch(/7712|318-44/);
  });

  it('leaves out empty fields, note and detail', () => {
    const row = problemReport(ev1120, { category: 'layout', note: '   ' }, taylor, now);
    expect(row).not.toHaveProperty('fieldKeys');
    expect(row).not.toHaveProperty('note');
    expect(row).not.toHaveProperty('detail');
  });
});

describe('formRequest', () => {
  it('is a new request from the signed-in person', () => {
    expect(formRequest({ name: ' Fidelity TOA ', issuer: '', note: 'monthly' }, taylor, now)).toEqual({ kind: 'request', name: 'Fidelity TOA', note: 'monthly', requestedById: 'usr-advisor-1', requestedBy: 'Taylor Brenneman', createdOn: now.toISOString(), status: 'new' });
  });
});

const fb = (over: Partial<FormFeedback>): FormFeedback => ({ id: 'x', kind: 'problem', name: 'Form', requestedBy: 'A', createdOn: '2026-10-01T00:00:00Z', status: 'new', ...over });

describe('filterFeedback', () => {
  const list = [
    fb({ id: '1', kind: 'request', name: 'Fidelity TOA', issuer: 'Fidelity', createdOn: '2026-10-02T00:00:00Z' }),
    fb({ id: '2', formNumber: 'EV-1120', name: 'Beneficiary designation', issuer: 'Everence Financial', createdOn: '2026-10-03T00:00:00Z' }),
    fb({ id: '3', formNumber: 'EV-1004', issuer: 'Everence Financial', status: 'fixed', createdOn: '2026-10-01T00:00:00Z' }),
    fb({ id: '4', formNumber: 'PX-310', issuer: 'Praxis', status: 'inProgress', createdOn: '2026-10-04T00:00:00Z' }),
  ];
  const ids = (l: FormFeedback[]) => l.map((f) => f.id);
  it('narrows by kind, status, company and form, newest first', () => {
    expect(ids(filterFeedback(list, {}))).toEqual(['4', '2', '1', '3']);
    expect(ids(filterFeedback(list, { kind: 'request' }))).toEqual(['1']);
    expect(ids(filterFeedback(list, { status: 'open' }))).toEqual(['4', '2', '1']);
    expect(ids(filterFeedback(list, { status: 'fixed' }))).toEqual(['3']);
    expect(ids(filterFeedback(list, { issuer: 'Everence Financial' }))).toEqual(['2', '3']);
    expect(ids(filterFeedback(list, { form: 'ev-1120' }))).toEqual(['2']);
    expect(ids(filterFeedback(list, { form: 'fidelity' }))).toEqual(['1']);
  });

  it('counts open problems per template', () => {
    const counts = openProblemCounts([fb({ templateId: 't1' }), fb({ templateId: 't1', status: 'inProgress' }), fb({ templateId: 't1', status: 'fixed' }), fb({ kind: 'request', templateId: 't1' }), fb({ templateId: 't2' })]);
    expect(Object.fromEntries(counts)).toEqual({ t1: 2, t2: 1 });
  });
});

describe('resolveFeedback', () => {
  it('stamps when it was closed and links the fixing revision', () => {
    const done = resolveFeedback(fb({ templateId: 't-old' }), 'fixed', { resolution: ' Fixed in 01/2027 ', fixedInTemplateId: 't-new' }, now);
    expect(done).toMatchObject({ status: 'fixed', resolution: 'Fixed in 01/2027', resolvedOn: now.toISOString(), fixedInTemplateId: 't-new' });
  });

  it('clears the close date and revision when reopened', () => {
    const done = resolveFeedback(fb({}), 'fixed', { fixedInTemplateId: 't-new' }, now);
    const reopened = resolveFeedback(done, 'inProgress', {}, now);
    expect(reopened.status).toBe('inProgress');
    expect(reopened).not.toHaveProperty('resolvedOn');
    expect(reopened).not.toHaveProperty('fixedInTemplateId');
  });

  it('keeps the first close date when only the reply changes', () => {
    const done = resolveFeedback(fb({}), 'wontFix', {}, new Date('2026-10-01T00:00:00Z'));
    expect(resolveFeedback(done, 'wontFix', { resolution: 'Carrier form' }, now).resolvedOn).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('newlyResolved', () => {
  it('lists my fixed and won’t-fix reports I haven’t seen in that status', () => {
    const list = [fb({ id: 'a', requestedById: 'me', status: 'fixed' }), fb({ id: 'b', requestedById: 'me', status: 'wontFix' }), fb({ id: 'c', requestedById: 'me', status: 'inProgress' }), fb({ id: 'd', requestedById: 'other', status: 'fixed' })];
    expect(newlyResolved(list, 'me', ['b:wontFix']).map((f) => f.id)).toEqual(['a']);
  });
});
