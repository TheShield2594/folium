import { describe, expect, it } from 'vitest';
import { CLIENTS, FIRM, TEMPLATES, USERS } from '../services/demo/seed';
import { runChecks, summarize } from './checks';
import { formatValue, validateFormat } from './format';
import { evaluateCondition, resolvePath } from './paths';
import { fieldKey, inputsNeeded, mappingWarnings, migrateAccountValues, prefillForm, prefillPacket } from './prefill';
import { carryForward, diffRevision } from './revisions';
import { assignSigners, rolesForPacket, validateSigners } from './signers';
import { buildEnvelopeDefinition, placementsToTabs } from '../services/docusign/tabs';

const client = CLIENTS['c-jordan'];
const advisor = USERS[0];
const scope = { client, advisor, firm: FIRM, today: new Date(2026, 9, 13) };
const tpl = (id: string) => TEMPLATES.find((t) => t.id === id)!;
const bene = tpl('tpl-ev1120-0326');

describe('paths', () => {
  it('resolves contact, account, connection, rep, firm and computed paths', () => {
    expect(resolvePath('contact.fullname', scope)).toBe('Jordan A. Miller');
    expect(resolvePath('account.ev_accountno', { ...scope, account: client.accounts[1] })).toBe('BRK-31-0920');
    expect(resolvePath('account.ev_accountno', scope)).toBe('IRA-22-4471');
    expect(resolvePath('connection[Spouse].fullname', scope)).toBe('Sam Miller');
    expect(resolvePath('connection[Nobody].fullname', scope)).toBeUndefined();
    expect(resolvePath('rep.repCode', scope)).toBe('EV4471');
    expect(resolvePath('firm.legalName', scope)).toBe('Everence Financial Advisors, Inc.');
    expect(resolvePath('computed.cityStateZip', scope)).toBe('Goshen, IN 46526');
    expect(resolvePath('computed.today', scope)).toBe('2026-10-13');
    expect(resolvePath('static:Yes', scope)).toBe('Yes');
  });

  it('evaluates conditions', () => {
    expect(evaluateCondition('contact.familystatuscode == married', scope)).toBe(true);
    expect(evaluateCondition('contact.familystatuscode != married', scope)).toBe(false);
    expect(evaluateCondition('connection[Joint owner].fullname', scope)).toBe(true);
    expect(evaluateCondition('contact.familystatuscode == single || contact.address1_city == goshen', scope)).toBe(true);
    expect(evaluateCondition(undefined, scope)).toBe(true);
  });
});

describe('format', () => {
  it('formats and validates', () => {
    expect(formatValue('1961-04-18', 'date')).toBe('04/18/1961');
    expect(formatValue('412550193', 'ssn')).toBe('412-55-0193');
    expect(formatValue('5745550118', 'phone')).toBe('(574) 555-0118');
    expect(formatValue('2500', 'currency')).toBe('$2,500.00');
    expect(validateFormat('13/40/2020', 'date')).toBeTruthy();
    expect(validateFormat('04/18/1961', 'date')).toBeUndefined();
    expect(validateFormat('abc', 'email')).toBeTruthy();
    expect(validateFormat('140', 'percent')).toBeTruthy();
  });
});

describe('prefill', () => {
  it('fills from CRM and flags what the advisor must enter', () => {
    const fill = prefillForm(bene, scope, {});
    const name = fill.fields.find((f) => f.mapping.pdfField === 'Owner_Name_Full')!;
    expect(name.value).toBe('Jordan A. Miller');
    expect(name.origin).toBe('crm');
    const pct = fill.fields.find((f) => f.mapping.pdfField === 'Bene1_Pct')!;
    expect(pct.missing).toBe(true);
    expect(fill.missingCount).toBeGreaterThan(0);
  });

  it('shares advisor values across forms by key ("enter once")', () => {
    const fills = prefillPacket(
      [{ template: tpl('tpl-px310-0826') }, { template: tpl('tpl-px120-0526') }],
      scope,
      { 'withholding.federal': '10' },
    );
    for (const f of fills) expect(f.fields.find((x) => x.key === 'withholding.federal')!.value).toBe('10');
  });

  it('marks overrides of CRM values as edited without losing the CRM value', () => {
    const key = fieldKey(bene.mapping.fields[0], bene);
    const fill = prefillForm(bene, scope, { [key]: 'Jordan Miller' });
    const f = fill.fields[0];
    expect(f.origin).toBe('edited');
    expect(f.crmValue).toBe('Jordan A. Miller');
  });

  describe('account fields', () => {
    const acct = (id: string) => client.accounts.find((a) => a.accountid === id)!;
    const form = (id: string, formNumber: string) => ({
      ...bene,
      id,
      formNumber,
      mapping: { ...bene.mapping, fields: [{ pdfField: 'AcctNo', source: 'account.ev_accountno', required: false }, { pdfField: 'Name', source: 'contact.fullname', required: false }], checks: [] },
    });
    const a = form('tpl-a', 'A-1');
    const b = form('tpl-b', 'B-1');
    const acctNo = (fill: ReturnType<typeof prefillForm>) => fill.fields.find((f) => f.mapping.pdfField === 'AcctNo')!;

    it('keeps an override on one account’s form off a form about another account', () => {
      const [fa] = prefillPacket([{ template: a, account: acct('a-j1') }], scope, {});
      const values = { [acctNo(fa).key]: 'IRA-22-9999' };
      const [ra, rb] = prefillPacket([{ template: a, account: acct('a-j1') }, { template: b, account: acct('a-j3') }], scope, values);
      expect(acctNo(ra).value).toBe('IRA-22-9999');
      expect(acctNo(ra).origin).toBe('edited');
      expect(acctNo(rb).value).toBe('PX-7712-0045');
      // "Use CRM value" clears the one key, and only that form changes.
      const [ca, cb] = prefillPacket([{ template: a, account: acct('a-j1') }, { template: b, account: acct('a-j3') }], scope, {});
      expect(acctNo(ca).value).toBe('IRA-22-4471');
      expect(acctNo(cb).value).toBe('PX-7712-0045');
      // Contact fields are still entered once.
      expect(ra.fields[1].key).toBe(rb.fields[1].key);
    });

    it('shares an override between forms about the same account', () => {
      const values = { [fieldKey(a.mapping.fields[0], a, 'a-j1')]: 'IRA-22-9999' };
      const fills = prefillPacket([{ template: a, account: acct('a-j1') }, { template: b, account: acct('a-j1') }], scope, values);
      expect(fills.map((f) => acctNo(f).value)).toEqual(['IRA-22-9999', 'IRA-22-9999']);
    });

    it('moves an older draft’s unscoped account value to the first form’s account only', () => {
      const values = migrateAccountValues({ 'account.ev_accountno': 'IRA-22-9999', 'contact.fullname': 'J Miller' }, 'a-j1');
      expect(values).toEqual({ 'account[a-j1].ev_accountno': 'IRA-22-9999', 'contact.fullname': 'J Miller' });
      const [ra, rb] = prefillPacket([{ template: a, account: acct('a-j1') }, { template: b, account: acct('a-j3') }], scope, values);
      expect(acctNo(ra).value).toBe('IRA-22-9999');
      expect(acctNo(rb).value).toBe('PX-7712-0045');
      // Admin-set keys stay shared.
      expect(migrateAccountValues({ 'account.ev_accountno': 'X' }, 'a-j1', new Set(['account.ev_accountno']))).toEqual({ 'account.ev_accountno': 'X' });
    });

    it('warns about a fixed key on an account field', () => {
      expect(mappingWarnings(a.mapping)).toEqual([]);
      const shared = { ...a.mapping, fields: [{ pdfField: 'AcctNo', source: 'account.ev_accountno', required: false, key: 'acct' }] };
      expect(mappingWarnings(shared)).toHaveLength(1);
    });
  });

  it('collects inputs once per key', () => {
    const fills = prefillPacket([{ template: tpl('tpl-px310-0826') }, { template: tpl('tpl-px120-0526') }], scope, {});
    const keys = inputsNeeded(fills).map((i) => i.key);
    expect(keys.filter((k) => k === 'withholding.federal')).toHaveLength(1);
  });
});

describe('checks', () => {
  const ctx = (values: Record<string, string>) => ({
    scope,
    values,
    latestFor: (n: string) => TEMPLATES.find((t) => t.formNumber === n && t.status === 'Live'),
  });

  it('blocks when beneficiary shares do not total 100', () => {
    const values = { 'bene.Prim.1.pct': '60' };
    const results = runChecks(prefillPacket([{ template: bene }], scope, values), ctx(values));
    expect(results.find((r) => r.title.includes('100%'))!.level).toBe('block');
  });

  it('passes when everything is in good order', () => {
    const values = { 'bene.Prim.1.pct': '100' };
    const results = runChecks(prefillPacket([{ template: bene }], scope, values), ctx(values));
    expect(summarize(results).blocking).toBe(0);
  });

  it('warns instead of crashing on an invalid pattern rule', () => {
    const bad = { ...bene, mapping: { ...bene.mapping, checks: [{ type: 'pattern' as const, field: 'Owner_Name_Full', pattern: '([' }] } };
    const results = runChecks(prefillPacket([{ template: bad }], scope, {}), ctx({}));
    expect(results.find((r) => r.title.includes('can’t be checked'))!.level).toBe('warn');
  });

  it('flags retired revisions', () => {
    const old = tpl('tpl-ev1004-0619');
    const results = runChecks(prefillPacket([{ template: old }], scope, {}), ctx({}));
    expect(results.find((r) => r.id === 'current-revisions')!.level).toBe('block');
  });
});

describe('signers', () => {
  it('adds spousal consent only for married clients and pulls the spouse from connections', () => {
    const needs = rolesForPacket([bene], scope);
    expect(needs.map((n) => n.role)).toEqual(['Owner', 'SpouseConsent']);
    const signers = assignSigners(needs, scope, 'sms');
    expect(signers[1].name).toBe('Sam Miller');
    expect(signers[0].auth).toBe('sms');
    expect(validateSigners(signers)).toEqual([]);

    const single = { ...scope, client: CLIENTS['c-priya'] };
    expect(rolesForPacket([bene], single).map((n) => n.role)).toEqual(['Owner']);
  });

  it('requires a phone for SMS', () => {
    const problems = validateSigners([{ role: 'Owner', name: 'A', email: 'a@b.co', order: 1, auth: 'sms' }]);
    expect(problems[0].message).toMatch(/mobile/);
  });
});

describe('revisions', () => {
  it('carries unchanged fields, detects renames and new fields', () => {
    const prev = tpl('tpl-px305-0825').mapping;
    const rows = diffRevision(prev, ['Owner_FullName', 'Owner_DOB', 'Acct_Number', 'Dist_Reason_QCD', 'QCD_Charity_Name']);
    expect(rows.find((r) => r.pdfField === 'Owner_DOB')!.change).toBe('unchanged');
    const renamed = rows.find((r) => r.pdfField === 'Owner_FullName')!;
    expect(renamed.change).toBe('renamed');
    expect(renamed.previousName).toBe('Owner_Name_Full');
    expect(rows.find((r) => r.pdfField === 'QCD_Charity_Name')!.change).toBe('new');
    expect(rows.some((r) => r.change === 'removed')).toBe(true);
    const next = carryForward(prev, rows, '10/2026', 'PX-305');
    expect(next.fields.find((f) => f.pdfField === 'Owner_FullName')!.source).toBe('contact.fullname');
  });

  it('keeps check rules pointing at a renamed field', () => {
    const prev = { ...tpl('tpl-px305-0825').mapping, checks: [{ type: 'requiredIf' as const, field: 'Owner_Name_Full', when: 'contact.familystatuscode == married' }] };
    const rows = diffRevision(prev, ['Owner_FullName', 'Acct_Number']);
    const next = carryForward(prev, rows, '10/2026', 'PX-305');
    expect(next.checks).toEqual([{ type: 'requiredIf', field: 'Owner_FullName', when: 'contact.familystatuscode == married' }]);
  });
});

describe('docusign', () => {
  it('converts neutral placements into tabs per role', () => {
    const tabs = placementsToTabs(bene.mapping.placements, 'Owner', '1');
    expect(tabs.signHereTabs).toHaveLength(1);
    expect(tabs.dateSignedTabs).toHaveLength(1);
    expect(tabs.signHereTabs![0]).toMatchObject({ documentId: '1', pageNumber: expect.any(String) });
  });

  it('builds an envelope with routing order, reminders and SMS verification', () => {
    const env = buildEnvelopeDefinition(
      {
        documents: [{ name: 'Bene.pdf', pdf: new Uint8Array([37, 80, 68, 70]), placements: bene.mapping.placements }],
        signers: [
          { role: 'Owner', name: 'Jordan', email: 'j@x.co', phone: '574-555-0118', order: 1, auth: 'sms' },
          { role: 'SpouseConsent', name: 'Sam', email: 's@x.co', order: 2, auth: 'email' },
        ],
        subject: 'Sign',
        message: 'Hi',
        reminderDays: 3,
      },
      { sms: 'wf-sms' },
    );
    expect(env.recipients.signers[0].routingOrder).toBe('1');
    expect(env.recipients.signers[0]).toHaveProperty('identityVerification.workflowId', 'wf-sms');
    expect(env.notification.reminders.reminderDelay).toBe('3');
    expect(env.documents[0].documentBase64).toBe('JVBERg==');
  });

  it('merges one person holding two roles into a single recipient with both roles’ tabs', () => {
    const env = buildEnvelopeDefinition(
      {
        documents: [{ name: 'Bene.pdf', pdf: new Uint8Array([1]), placements: [
          { role: 'JointOwner', type: 'signature', page: 1, x: 50, y: 600 },
          { role: 'SpouseConsent', type: 'signature', page: 1, x: 50, y: 660 },
        ] }],
        signers: [
          { role: 'JointOwner', name: 'Sam Miller', email: 'sam@x.co', order: 2, auth: 'email' },
          { role: 'SpouseConsent', name: 'Sam Miller', email: 'SAM@x.co', order: 3, auth: 'email' },
        ],
        subject: 'Sign',
        message: '',
      },
      {},
    );
    expect(env.recipients.signers).toHaveLength(1);
    expect(env.recipients.signers[0].roleName).toBe('JointOwner+SpouseConsent');
    expect(env.recipients.signers[0].routingOrder).toBe('2');
    expect(env.recipients.signers[0].tabs.signHereTabs).toHaveLength(2);
    expect(validateSigners([
      { role: 'JointOwner', name: 'Sam Miller', email: 'sam@x.co', order: 1, auth: 'email' },
      { role: 'SpouseConsent', name: 'Sam Miller', email: 'sam@x.co', order: 2, auth: 'email' },
    ])).toEqual([]);
    expect(validateSigners([
      { role: 'Owner', name: 'Jordan Miller', email: 'home@x.co', order: 1, auth: 'email' },
      { role: 'SpouseConsent', name: 'Sam Miller', email: 'home@x.co', order: 2, auth: 'email' },
    ])[0].message).toMatch(/share an email/);
  });

  it('refuses to send when the chosen verification is not configured', () => {
    const req = {
      documents: [{ name: 'Bene.pdf', pdf: new Uint8Array([1]), placements: [] }],
      signers: [{ role: 'Owner', name: 'Jordan', email: 'j@x.co', phone: '574-555-0118', order: 1, auth: 'sms' as const }],
      subject: 'Sign',
      message: '',
    };
    expect(() => buildEnvelopeDefinition(req, {})).toThrow(/SMS verification/);
    expect(() => buildEnvelopeDefinition({ ...req, signers: [{ ...req.signers[0], phone: undefined }] }, { sms: 'wf' })).toThrow(/mobile number/);
    expect(() => buildEnvelopeDefinition({ ...req, signers: [{ ...req.signers[0], auth: 'kba' as const }] }, {})).toThrow(/KBA/);
    expect(() => buildEnvelopeDefinition({ ...req, signers: [{ ...req.signers[0], auth: 'email' as const }] }, {})).not.toThrow();
  });
});
