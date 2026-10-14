import { describe, expect, it } from 'vitest';
import { CLIENTS, FIRM, TEMPLATES, USERS } from '../services/demo/seed';
import type { FieldMapping, FormTemplate, PacketItem, RequestDocument } from './types';
import { describeFormUpgrade, draftFreshness, upgradeAuditDetail, upgradeDraft, upgradePacketItems } from './drafts';
import { attachmentLimits, checkAttachments, DEFAULT_ATTACHMENT_LIMITS, MB, outputGate, runChecks, summarize, type CheckResult } from './checks';
import { fillSubject, fillTokens, formatValue, resolveDateLimit, validateFormat } from './format';
import { buildCondition, conditionTerms, evaluateCondition, explainCondition, parseCondition, resolvePath } from './paths';
import { carryVariantValues, choiceDisplay, choiceOptions, fieldKey, fillBlockFromPerson, personBlocks, relatedPeople, inputsNeeded, mappingWarnings, migrateAccountValues, prefillForm, prefillPacket, seedCopyValues, termLabels, validateMapping } from './prefill';
import { carryForward, diffRevision, latestLive } from './revisions';
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

  it('keeps every existing form of condition working', () => {
    expect(evaluateCondition('!connection[Nobody].fullname', scope)).toBe(true);
    expect(evaluateCondition('!contact.fullname', scope)).toBe(false);
    expect(evaluateCondition("contact.familystatuscode == 'married'", scope)).toBe(true);
    expect(evaluateCondition('contact.familystatuscode == MARRIED && contact.address1_city == Goshen', scope)).toBe(true);
    expect(evaluateCondition('contact.familystatuscode == married && contact.address1_city == Elkhart', scope)).toBe(false);
    expect(evaluateCondition('account.ev_accounttype == Traditional IRA', scope)).toBe(true);
    // Packet values win over the CRM, and answer by key.
    expect(evaluateCondition('contact.familystatuscode == single', scope, { 'contact.familystatuscode': 'single' })).toBe(true);
    expect(evaluateCondition('withholding.none', scope, { 'withholding.none': 'Yes' })).toBe(true);
    expect(evaluateCondition('withholding.none', scope, { 'withholding.none': 'false' })).toBe(false);
    expect(evaluateCondition('withholding.none', scope, { 'withholding.none': '0' })).toBe(false);
  });

  it('gives && precedence over || and honours parentheses', () => {
    // true || (false && false) → true; (true || false) && false → false
    expect(evaluateCondition('contact.address1_city == goshen || contact.fullname == x && contact.fullname == y', scope)).toBe(true);
    expect(evaluateCondition('(contact.address1_city == goshen || contact.fullname == x) && contact.fullname == y', scope)).toBe(false);
    expect(evaluateCondition('!(contact.familystatuscode == single || contact.familystatuscode == divorced)', scope)).toBe(true);
    expect(evaluateCondition('((contact.familystatuscode == married))', scope)).toBe(true);
  });

  it('supports contains and in (...)', () => {
    expect(evaluateCondition('contact.fullname contains miller', scope)).toBe(true);
    expect(evaluateCondition('contact.fullname contains "A. M"', scope)).toBe(true);
    expect(evaluateCondition('contact.fullname contains smith', scope)).toBe(false);
    expect(evaluateCondition('contact.familystatuscode in (married, widowed)', scope)).toBe(true);
    expect(evaluateCondition('contact.familystatuscode in (single,divorced)', scope)).toBe(false);
    expect(evaluateCondition("account.ev_accounttype in ('Roth IRA', \"Traditional IRA\")", scope)).toBe(true);
    // "in" is only an operator before a list.
    expect(evaluateCondition('Opt in', scope, { 'Opt in': 'Yes' })).toBe(true);
  });

  it('reports what it cannot parse and falls back as told', () => {
    for (const bad of ['(contact.fullname', 'contact.fullname ==', '&& x', 'x in (', 'x == "open']) expect(() => parseCondition(bad)).toThrow();
    expect(evaluateCondition('(contact.fullname', scope)).toBe(true);
    expect(evaluateCondition('(contact.fullname', scope, {}, false)).toBe(false);
    expect(conditionTerms('(a == 1 || !b) && connection[Joint owner].fullname contains x')).toEqual(['a', 'b', 'connection[Joint owner].fullname']);
  });

  it('builds and explains conditions', () => {
    expect(buildCondition('toa.all', 'checked')).toBe('toa.all');
    expect(buildCondition('toa.all', 'unchecked')).toBe('!toa.all');
    expect(buildCondition('contact.familystatuscode', 'in', 'married, widowed')).toBe('contact.familystatuscode in (married, widowed)');
    expect(buildCondition('x', 'equals', 'a, b')).toBe('x == "a, b"');
    expect(evaluateCondition(buildCondition('x', 'equals', 'a || b'), scope, { x: 'A || B' })).toBe(true);
    const labels = (t: string) => (t === 'bene.contingent' ? { label: 'Contingent beneficiary', checkbox: true } : undefined);
    expect(explainCondition('bene.contingent', labels)).toBe('when Contingent beneficiary is checked');
    expect(explainCondition('!bene.contingent', labels)).toBe('when Contingent beneficiary is not checked');
    expect(explainCondition('contact.familystatuscode in (married, widowed) && !x', labels)).toBe('when contact.familystatuscode is married or widowed and x is empty');
    expect(explainCondition('a == 1 && (b == 2 || c contains z)')).toBe('when a is 1 and (b is 2 or c contains “z”)');
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

  it('validates and formats EIN, SSN-or-TIN, integer and decimal', () => {
    expect(formatValue('123456789', 'ein')).toBe('12-3456789');
    expect(validateFormat('12-3456789', 'ein')).toBeUndefined();
    expect(validateFormat('123-45-6789', 'ein')).toMatch(/EIN like 12-3456789/);
    expect(validateFormat('12345678', 'ein')).toBeTruthy();

    expect(formatValue('412550193', 'ssnOrTin')).toBe('412-55-0193');
    expect(formatValue('12-3456789', 'ssnOrTin')).toBe('12-3456789');
    expect(validateFormat('412-55-0193', 'ssnOrTin')).toBeUndefined();
    expect(validateFormat('12-3456789', 'ssnOrTin')).toBeUndefined();
    expect(validateFormat('412550193', 'ssnOrTin')).toBeUndefined();
    expect(validateFormat('4125-50193', 'ssnOrTin')).toBeTruthy();
    expect(validateFormat('41255019', 'ssnOrTin')).toBeTruthy();

    expect(formatValue('1,200', 'integer')).toBe('1200');
    expect(validateFormat('42', 'integer')).toBeUndefined();
    expect(validateFormat('4.2', 'integer')).toMatch(/whole number/);
    expect(validateFormat('abc', 'integer')).toBeTruthy();
    expect(validateFormat('1,200', 'integer')).toBeUndefined();
    expect(validateFormat('-1,234,567', 'integer')).toBeUndefined();
    for (const bad of [',', '1,,2', ',5', '12,34', '1234,567', '-']) expect(validateFormat(bad, 'integer')).toBe('Enter a whole number.');
    expect(validateFormat('4.25', 'decimal')).toBeUndefined();
    expect(validateFormat('-0.5', 'decimal')).toBeUndefined();
    expect(validateFormat('4.2.5', 'decimal')).toBeTruthy();
    expect(validateFormat('x', 'decimal')).toBeTruthy();
  });

  it('enforces numeric and length limits', () => {
    expect(validateFormat('5', 'integer', { min: 1, max: 10 })).toBeUndefined();
    expect(validateFormat('11', 'integer', { min: 1, max: 10 })).toBe('Enter a whole number from 1 to 10.');
    expect(validateFormat('0.5', 'decimal', { min: 1 })).toBe('Enter a number of at least 1.');
    expect(validateFormat('2,500', 'currency', { max: 1000 })).toBe('Enter an amount of at most $1,000.00.');
    // Percent keeps 0–100 without limits, and limits replace it.
    expect(validateFormat('140', 'percent')).toBe('Enter a percentage from 0% to 100%.');
    expect(validateFormat('140', 'percent', { max: 200 })).toBeUndefined();
    expect(validateFormat('5', 'percent', { min: 10, max: 50 })).toBeTruthy();

    expect(validateFormat('IRA-22-4471-99', 'text', { maxLength: 10 })).toBe('Up to 10 characters (this is 14).');
    expect(validateFormat('IRA-22', undefined, { maxLength: 10 })).toBeUndefined();
    expect(validateFormat('AB', undefined, { minLength: 3 })).toBe('At least 3 characters.');
    // Length is measured on the printed value: 9 digits print as 11 characters.
    expect(validateFormat('412550193', 'ssn', { maxLength: 10 })).toBeTruthy();
  });

  it('enforces date ranges, relative to a pinned today', () => {
    const today = new Date(2026, 9, 13);
    const dob = { dateMin: '-120y', dateMax: 'today' };
    expect(resolveDateLimit('today', today)).toBe('2026-10-13');
    expect(resolveDateLimit('-120y', today)).toBe('1906-10-13');
    expect(resolveDateLimit('+30d', today)).toBe('2026-11-12');
    expect(resolveDateLimit('-6m', today)).toBe('2026-04-13');
    expect(resolveDateLimit('2020-01-31', today)).toBe('2020-01-31');
    expect(resolveDateLimit('nonsense', today)).toBeUndefined();

    expect(validateFormat('1961-04-18', 'date', dob, today)).toBeUndefined();
    expect(validateFormat('2026-10-13', 'date', dob, today)).toBeUndefined();
    expect(validateFormat('2031-01-01', 'date', dob, today)).toBe('Enter a date from 10/13/1906 to today.');
    expect(validateFormat('1880-01-01', 'date', dob, today)).toBeTruthy();
    expect(validateFormat('10/12/2026', 'date', { dateMin: 'today' }, today)).toBe('Enter a date on or after today.');
    expect(validateFormat('2027-01-01', 'date', { dateMax: '2026-12-31' }, today)).toBe('Enter a date on or before 12/31/2026.');
  });

  it('prints dates in the template’s layout', () => {
    expect(formatValue('1961-04-18', 'date', { dateLayout: 'YYYY-MM-DD' })).toBe('1961-04-18');
    expect(formatValue('4/18/1961', 'date', { dateLayout: 'MMDDYYYY' })).toBe('04181961');
    expect(formatValue('1961-04-18', 'date', { dateLayout: 'DD/MM/YYYY' })).toBe('18/04/1961');
    expect(formatValue('1961-04-18', 'date', {})).toBe('04/18/1961');
  });

  it('flags a future CRM birthdate as a blocking format check', () => {
    const future = { ...scope, client: { ...client, contact: { ...client.contact, birthdate: '2031-04-18' } } };
    const fill = prefillForm(bene, future, {});
    const dob = fill.fields.find((f) => f.mapping.source === 'contact.birthdate')!;
    expect(dob.origin).toBe('crm');
    expect(dob.formatError).toMatch(/today/);
    const checks = runChecks([fill], { scope: future, values: {}, latestFor: () => bene });
    expect(checks.find((c) => c.id === `format:${dob.key}`)?.level).toBe('block');
    // Today's real data passes.
    expect(prefillForm(bene, scope, {}).fields.find((f) => f.mapping.source === 'contact.birthdate')!.formatError).toBeUndefined();
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

  describe('copies of one form', () => {
    const swp = tpl('tpl-px310-0826');
    const acct = (id: string) => client.accounts.find((a) => a.accountid === id)!;
    const val = (fill: ReturnType<typeof prefillForm>, pdf: string) => fill.fields.find((f) => f.mapping.pdfField === pdf)!;
    const items = [
      { template: swp, account: acct('a-j1'), itemId: 'pi-1' },
      { template: swp, account: acct('a-j3'), itemId: 'pi-2', copy: 2 },
    ];

    it('keeps advisor values typed on copy 2 off copy 1, and client data shared', () => {
      const [one, two] = prefillPacket(items, scope, { 'swp.amount': '500', 'pi-2/swp.amount': '750' });
      expect(val(one, 'SWP_Amount').value).toBe('500');
      expect(val(two, 'SWP_Amount').value).toBe('750');
      expect(val(two, 'SWP_Amount').key).toBe('pi-2/swp.amount');
      expect(val(one, 'Owner_Name_Full').key).toBe(val(two, 'Owner_Name_Full').key);
      expect([one.itemId, two.itemId, two.copy]).toEqual(['pi-1', 'pi-2', 2]);
    });

    it('scopes account values by account, not by copy', () => {
      const [one, two] = prefillPacket(items, scope, {});
      const acctField = swp.mapping.fields.find((m) => m.source === 'account.ev_accountno')!;
      expect(val(one, acctField.pdfField).value).toBe('IRA-22-4471');
      expect(val(two, acctField.pdfField).value).toBe('PX-7712-0045');
    });

    it('carries values to another state’s version of a form', () => {
      const other = { ...swp, id: 'tpl-x', formNumber: 'PX-310-VA', mapping: { ...swp.mapping, fields: [...swp.mapping.fields, { pdfField: 'Note', source: 'advisor', required: false }] } };
      const from = { ...swp, mapping: { ...swp.mapping, fields: [...swp.mapping.fields, { pdfField: 'Note', source: 'advisor', required: false }] } };
      expect(carryVariantValues(from, other, { 'PX-310:Note': 'hi', 'swp.amount': '5' })).toEqual({ 'PX-310-VA:Note': 'hi' });
      expect(carryVariantValues(from, other, { 'pi-2/PX-310:Note': 'hi' }, 'pi-2')).toEqual({ 'pi-2/PX-310-VA:Note': 'hi' });
    });

    it('starts a copy from the original’s values', () => {
      const seeded = seedCopyValues(swp, { 'swp.amount': '500', 'swp.monthly': 'Yes', 'contact.fullname': 'J' }, 'pi-2');
      expect(seeded).toEqual({ 'pi-2/swp.amount': '500', 'pi-2/swp.monthly': 'Yes' });
      expect(seedCopyValues(swp, seeded, 'pi-3', 'pi-2')).toEqual({ 'pi-3/swp.amount': '500', 'pi-3/swp.monthly': 'Yes' });
    });

    it('shares a field marked shareAcrossCopies', () => {
      const shared = { ...swp, mapping: { ...swp.mapping, fields: swp.mapping.fields.map((m) => (m.key === 'swp.start' ? { ...m, shareAcrossCopies: true } : m)) } };
      const [, two] = prefillPacket([{ template: shared, itemId: 'pi-1' }, { template: shared, itemId: 'pi-2', copy: 2 }], scope, { 'swp.start': '2026-11-02' });
      expect(val(two, 'SWP_Start').value).toBe('2026-11-02');
    });

    it('checks each copy on its own, and warns when two copies share an account', () => {
      const fills = prefillPacket([items[0], { ...items[1], account: acct('a-j1') }], scope, { 'swp.monthly': 'Yes' });
      const results = runChecks(fills, { scope, values: { 'swp.monthly': 'Yes' }, latestFor: () => undefined });
      expect(results.find((r) => r.id === 'pi-1:check:0')?.level).toBe('pass');
      expect(results.find((r) => r.id === 'pi-2:check:0')?.level).toBe('block');
      expect(results.find((r) => r.id.startsWith('same-account:'))).toMatchObject({ level: 'warn', itemId: 'pi-2' });
    });
  });

  describe('choice boxes', () => {
    const box = (word: string, extra: Partial<FieldMapping> = {}): FieldMapping => ({ pdfField: `MS_${word}`, label: word, source: 'contact.familystatuscode', required: false, format: 'checkbox', checkedWhen: word, ...extra });
    const form = { ...bene, id: 'tpl-ms', mapping: { ...bene.mapping, fields: [box('single'), box('married')], checks: [{ type: 'oneOf' as const, fields: ['MS_single', 'MS_married'] }] } };

    it('ticks the box whose word is the CRM value, keeping the word as the value', () => {
      const fill = prefillForm(form, scope, {});
      expect(fill.fields.map((f) => [f.value, f.display, f.key])).toEqual([
        ['married', '', 'contact.familystatuscode'],
        ['married', 'Yes', 'contact.familystatuscode'],
      ]);
      expect(fill.fields.every((f) => !f.formatError)).toBe(true);
      // One value drives the set, so a pick-one check sees one box ticked.
      expect(runChecks([fill], { scope, values: {}, latestFor: () => undefined }).find((r) => r.id.endsWith(':check:0'))?.level).toBe('pass');
      const edited = prefillForm(form, scope, { 'contact.familystatuscode': 'single' });
      expect(edited.fields.map((f) => f.display)).toEqual(['Yes', '']);
      expect(edited.fields[0].origin).toBe('edited');
    });

    it('maps a radio value to its PDF option', () => {
      expect(choiceDisplay({ options: { married: 'M', single: 'S' } }, 'Married')).toBe('M');
      expect(choiceDisplay({ options: { married: 'M' } }, 'widowed')).toBe('');
      expect(choiceDisplay({}, 'x')).toBeUndefined();
    });

    it('counts a required radio with no option for the value as missing', () => {
      const radio = { ...form, mapping: { ...form.mapping, checks: [], fields: [{ pdfField: 'MS', source: 'contact.familystatuscode', required: true, options: { single: 'S' } }] } };
      expect(prefillForm(radio, scope, {}).fields[0]).toMatchObject({ value: 'married', display: '', missing: true });
      expect(prefillForm(radio, scope, { 'contact.familystatuscode': 'single' }).fields[0].missing).toBe(false);
    });

    it('lists the choices a set offers', () => {
      const fill = prefillForm(form, scope, {});
      expect(choiceOptions(fill.fields)).toEqual([
        { value: 'single', label: 'single' },
        { value: 'married', label: 'married' },
      ]);
    });
  });

  describe('person blocks', () => {
    const withSon = { ...client, connections: [...client.connections, { role: 'Son', contact: { ...client.connections[0].contact, contactid: 'c-ben', fullname: 'Ben Miller', firstname: 'Ben', birthdate: '1995-02-03', ev_ssn: '123-45-6789' }, ev_sharepct: 50 }] };
    const sc = { ...scope, client: withSon };

    it('lists the client and every related person', () => {
      expect(relatedPeople(withSon).map((p) => `${p.name} · ${p.role}`)).toEqual(['Jordan A. Miller · Client', 'Sam Miller · Spouse', 'Sam Miller · Joint owner', 'Ruth Miller-Kauffman · Trusted contact', 'Ben Miller · Son']);
    });

    it('keeps a person block per copy, even when it reads CRM', () => {
      const [one, two] = prefillPacket([{ template: bene, itemId: 'pi-1' }, { template: bene, itemId: 'pi-2', copy: 2 }], sc, {});
      const son = relatedPeople(withSon).find((p) => p.role === 'Son')!;
      const values = fillBlockFromPerson([two], 'Primary beneficiary 1', son);
      expect(Object.keys(values).every((k) => k.startsWith('pi-2/'))).toBe(true);
      const [a, b] = prefillPacket([{ template: bene, itemId: 'pi-1' }, { template: bene, itemId: 'pi-2', copy: 2 }], sc, values);
      const name = (f: typeof a) => f.fields.find((x) => x.mapping.pdfField === 'Bene1_Name')!.value;
      expect([name(a), name(b)]).toEqual(['Sam Miller', 'Ben Miller']);
      expect(one.fields.find((x) => x.mapping.pdfField === 'Bene1_Name')!.key).toBe('bene.Prim.1.name');
    });

    it('fills beneficiary 2 from any connection, and clears it for someone new', () => {
      const fill = prefillForm(bene, sc, {});
      expect(personBlocks([fill])).toEqual(['Primary beneficiary 1', 'Primary beneficiary 2', 'Primary beneficiary 3', 'Contingent beneficiary 1', 'Contingent beneficiary 2']);
      const son = relatedPeople(withSon).find((p) => p.role === 'Son')!;
      const values = fillBlockFromPerson([fill], 'Primary beneficiary 2', son);
      expect(values).toEqual({ 'bene.Prim.2.name': 'Ben Miller', 'bene.Prim.2.rel': 'Son', 'bene.Prim.2.dob': '1995-02-03', 'bene.Prim.2.ssn': '123-45-6789', 'bene.Prim.2.pct': '50' });
      const after = prefillForm(bene, sc, values);
      expect(after.fields.find((f) => f.mapping.pdfField === 'Bene2_DOB')?.display).toBe('02/03/1995');
      expect(Object.values(fillBlockFromPerson([fill], 'Primary beneficiary 2', undefined)).every((v) => v === '')).toBe(true);
      // Beneficiary 1 reads the spouse from CRM; filling it from the son overrides it.
      expect(fillBlockFromPerson([fill], 'Primary beneficiary 1', son)['bene.Prim.1.name']).toBe('Ben Miller');
    });
  });

  describe('conditional locks and requirements', () => {
    const px310 = tpl('tpl-px310-0826');
    const fed = (f: ReturnType<typeof prefillForm>) => f.fields.find((x) => x.key === 'withholding.federal')!;

    it('locks a field: blank, not required, not needed, and unlocking restores the value', () => {
      const typed = { 'withholding.federal': '12' };
      expect(fed(prefillForm(px310, scope, typed))).toMatchObject({ locked: false, value: '12', required: true });

      const locked = prefillForm(px310, scope, { ...typed, 'withholding.none': 'Yes' });
      expect(fed(locked)).toMatchObject({ locked: true, value: '', display: '', required: false, missing: false, formatError: undefined });
      expect(fed(locked).lockReason).toBe('when Elect no federal withholding is checked');
      expect(inputsNeeded([locked]).map((i) => i.key)).not.toContain('withholding.federal');
      // A malformed value doesn't block while locked.
      expect(fed(prefillForm(px310, scope, { 'withholding.federal': '140', 'withholding.none': 'Yes' })).formatError).toBeUndefined();

      expect(fed(prefillForm(px310, scope, { ...typed, 'withholding.none': '' }))).toMatchObject({ locked: false, value: '12' });
    });

    it('locks across forms in a packet through shared keys', () => {
      const fills = prefillPacket([{ template: px310 }, { template: tpl('tpl-px120-0526') }], scope, { 'withholding.none': 'Yes' });
      expect(fills.flatMap((f) => f.fields.filter((x) => x.key === 'withholding.federal')).every((x) => x.locked)).toBe(true);
    });

    it('makes a field required on requiredWhen alone', () => {
      const m = { ...px310.mapping, fields: px310.mapping.fields.map((f) => (f.key === 'withholding.state' ? { ...f, required: false, requiredWhen: 'contact.address1_stateorprovince == IN' } : f)) };
      const state = (v: Record<string, string>) => prefillForm({ ...px310, mapping: m }, scope, v).fields.find((x) => x.key === 'withholding.state')!;
      expect(state({})).toMatchObject({ required: true, missing: true });
      expect(state({ 'contact.address1_stateorprovince': 'OH' })).toMatchObject({ required: false, missing: false });
    });

    it('ignores a lock it cannot parse, and warns about it and about chains', () => {
      const broken = { ...px310.mapping, fields: px310.mapping.fields.map((f) => (f.key === 'withholding.federal' ? { ...f, lockWhen: '(withholding.none' } : f)) };
      expect(fed(prefillForm({ ...px310, mapping: broken }, scope, { 'withholding.none': 'Yes' })).locked).toBe(false);
      expect(validateMapping(broken)[0]).toMatch(/can’t be read/);

      const chained = { ...px310.mapping, fields: px310.mapping.fields.map((f) => (f.key === 'withholding.state' ? { ...f, lockWhen: 'withholding.federal == 0' } : f)) };
      expect(validateMapping(chained).some((w) => /Locks don’t chain/.test(w))).toBe(true);
      expect(mappingWarnings(px310.mapping)).toEqual([]);
      expect(termLabels(px310.mapping)('withholding.none')).toEqual({ label: 'Elect no federal withholding', checkbox: true });
    });

    it('does not hold a requiredIf check against a locked field', () => {
      const m = { ...px310.mapping, checks: [{ type: 'requiredIf' as const, field: 'Withholding_Fed_Pct', when: 'contact.fullname' }] };
      const values = { 'withholding.none': 'Yes' };
      const results = runChecks([prefillForm({ ...px310, mapping: m }, scope, values)], { scope, values, latestFor: () => undefined });
      expect(results.find((r) => r.id.endsWith(':check:0'))!.level).toBe('pass');
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

describe('output gate', () => {
  const pass: CheckResult = { id: 'required', level: 'pass', title: 'All required fields are filled' };
  const warn: CheckResult = { id: 't:kind', level: 'warn', title: 'Scanned PDF' };
  const block: CheckResult = { id: 't:required', level: 'block', title: '2 required fields', templateId: 't', fieldKey: 'k' };
  const clean = [pass, warn];
  const open = [pass, warn, block];

  it('blocks send, flatten and print while a check blocks, and only then', () => {
    for (const mode of ['send', 'flatten', 'print'] as const) {
      expect(outputGate(clean, mode)).toEqual({ allowed: true, blockers: [], draftMark: false });
      expect(outputGate(open, mode)).toEqual({ allowed: false, blockers: [block], draftMark: false });
    }
  });

  it('keeps the editable PDF but marks it draft while checks are open', () => {
    expect(outputGate(clean, 'fillable')).toEqual({ allowed: true, blockers: [], draftMark: false });
    expect(outputGate(open, 'fillable')).toEqual({ allowed: true, blockers: [block], draftMark: true });
    // A firm can ask for Laser App's stricter behaviour.
    expect(outputGate(open, 'fillable', { blockFillable: true }).allowed).toBe(false);
    expect(outputGate(clean, 'fillable', { blockFillable: true }).allowed).toBe(true);
  });

  it('always allows and always marks drafts', () => {
    expect(outputGate(clean, 'draft')).toMatchObject({ allowed: true, draftMark: true });
    expect(outputGate(open, 'draft')).toMatchObject({ allowed: true, draftMark: true });
  });

  it('never blocks on warnings', () => {
    for (const mode of ['send', 'flatten', 'print', 'fillable', 'draft'] as const) expect(outputGate([warn, warn], mode).allowed).toBe(true);
  });

  it('blocks print for a retired revision', () => {
    const retired = { ...bene, status: 'Retired' as const };
    const checks = runChecks([prefillForm(retired, scope, {})], { scope, values: {}, latestFor: () => bene });
    expect(outputGate(checks, 'print').blockers.some((b) => b.id === 'current-revisions')).toBe(true);
  });
});


describe('out-of-date drafts', () => {
  const field = (pdfField: string, more: Partial<FieldMapping> = {}): FieldMapping => ({ pdfField, source: 'advisor', required: false, ...more });
  const mk = (id: string, revision: string, effectiveDate: string, status: FormTemplate['status'], fields: FieldMapping[], signers = [{ role: 'Owner' }], formNumber = 'XF-1'): FormTemplate => ({
    ...bene,
    id,
    formNumber,
    name: `Test form ${formNumber}`,
    revision,
    effectiveDate,
    status,
    mapping: { formNumber, revision, fields, signers, placements: [], checks: [] },
  });
  const old = mk('x-old', '03/25', '2025-03-01', 'Retired', [field('Owner_Name_Full'), field('Reason_Text'), field('Contact_Name', { source: 'contact.fullname' }), field('Shared_Note', { key: 'note' })]);
  const cur = mk('x-new', '10/26', '2026-10-01', 'Live', [field('Owner_FullName'), field('Contact_Name', { source: 'contact.fullname' }), field('Shared_Note', { key: 'note' }), field('Witness_Name', { required: true })], [{ role: 'Owner' }, { role: 'Witness' }]);
  const other = mk('y-1', '01/26', '2026-01-01', 'Live', [field('Thing')], undefined, 'YF-2');
  const lib = [old, cur, other];
  const doc = (t: FormTemplate, more: Partial<RequestDocument> = {}): RequestDocument => ({ templateId: t.id, name: t.name, formNumber: t.formNumber, revision: t.revision, ...more });
  const on = '2026-10-14';

  it('tells current, newer, retired, missing and future-dated revisions apart', () => {
    expect(draftFreshness({ documents: [doc(cur), doc(other)] }, lib, on)).toMatchObject({ state: 'current', changed: 0 });
    const partial = draftFreshness({ documents: [doc(old), doc(other)] }, lib, on);
    expect(partial.state).toBe('partial');
    expect(partial.documents[0]).toMatchObject({ state: 'newer', latest: { id: 'x-new' } });
    // Retired with no Live successor.
    const lone = mk('z-1', '01/20', '2020-01-01', 'Retired', [], undefined, 'ZF-9');
    expect(draftFreshness({ documents: [doc(lone)] }, [...lib, lone], on)).toMatchObject({ state: 'outdated', documents: [{ state: 'retired' }] });
    // Template deleted, no revision of the form left.
    expect(draftFreshness({ documents: [{ templateId: 'gone', name: 'Old form', formNumber: 'QQ-1', revision: '1' }] }, lib, on).documents[0].state).toBe('missing');
    // Template deleted, but the form has a Live revision: that's an upgrade.
    expect(draftFreshness({ documents: [{ templateId: 'gone', name: 'X', formNumber: 'XF-1', revision: '01/24' }] }, lib, on).documents[0]).toMatchObject({ state: 'newer', latest: { id: 'x-new' } });
    // A revision that takes effect later isn't newer until its date.
    const future = mk('x-next', '01/27', '2027-01-01', 'Live', cur.mapping.fields);
    expect(draftFreshness({ documents: [doc(cur)] }, [...lib, future], on).state).toBe('current');
    expect(draftFreshness({ documents: [doc(cur)] }, [...lib, future], '2027-01-02').state).toBe('outdated');
  });

  it('carries a value under a renamed field and keeps account and order', () => {
    const req = { documents: [doc(other, { accountId: 'a-2', itemId: 'pi-b' }), doc(old, { accountId: 'a-1', itemId: 'pi-a' })], values: { 'XF-1:Owner_Name_Full': 'Jordan Miller', 'contact.fullname': 'J. Miller', note: 'hi', 'YF-2:Thing': 'kept' } };
    const { documents, values, report } = upgradeDraft(req, lib, on);
    expect(documents.map((d) => [d.templateId, d.accountId, d.itemId])).toEqual([
      ['y-1', 'a-2', 'pi-b'],
      ['x-new', 'a-1', 'pi-a'],
    ]);
    expect(documents[1]).toMatchObject({ revision: '10/26', name: cur.name });
    expect(values['XF-1:Owner_FullName']).toBe('Jordan Miller');
    expect(values['XF-1:Owner_Name_Full']).toBeUndefined();
    // Keys from a CRM source or an explicit key stay as they are.
    expect(values['contact.fullname']).toBe('J. Miller');
    expect(values.note).toBe('hi');
    expect(values['YF-2:Thing']).toBe('kept');
    expect(report.forms).toHaveLength(1);
    expect(report.forms[0]).toMatchObject({ itemId: 'pi-a', from: '03/25', to: '10/26', state: 'newer' });
    expect(report.forms[0].carried).toContain('Owner Full Name');
  });

  it('reports removed fields, new required fields and changed signers', () => {
    const { values, report } = upgradeDraft({ documents: [doc(old)], values: { 'XF-1:Reason_Text': 'Moving' } }, lib, on);
    const f = report.forms[0];
    expect(f.dropped).toEqual([{ label: 'Reason Text', value: 'Moving' }]);
    expect(values['XF-1:Reason_Text']).toBeUndefined();
    expect(f.newRequired).toEqual(['Witness Name']);
    expect(f.signersChanged).toBe(true);
    expect(describeFormUpgrade(f)).toBe('Rev 03/25 → 10/26 · 1 new required field · 1 value no longer used · signers changed');
    expect(upgradeAuditDetail(report)).toBe('XF-1 Rev 03/25 → 10/26');
  });

  it('keeps copies’ own values and never drops a form it can’t upgrade', () => {
    const lone = mk('z-1', '01/20', '2020-01-01', 'Retired', [], undefined, 'ZF-9');
    const items: PacketItem[] = [
      { id: 'pi-1', templateId: 'x-old' },
      { id: 'pi-2', templateId: 'x-old', copy: 2 },
      { id: 'pi-3', templateId: 'z-1' },
      { id: 'pi-4', templateId: 'gone', missing: { name: 'Old form', formNumber: 'QQ-1', revision: '1' } },
    ];
    const r = upgradePacketItems(items, { 'XF-1:Owner_Name_Full': 'One', 'pi-2/XF-1:Owner_Name_Full': 'Two' }, [...lib, lone], on);
    expect(r.items.map((i) => i.templateId)).toEqual(['x-new', 'x-new', 'z-1', 'gone']);
    expect(r.values).toMatchObject({ 'XF-1:Owner_FullName': 'One', 'pi-2/XF-1:Owner_FullName': 'Two' });
    expect(r.report.forms.map((f) => f.state)).toEqual(['newer', 'newer', 'retired', 'missing']);
    expect(r.report.forms[3].name).toBe('Old form');
    expect(describeFormUpgrade(r.report.forms[2])).toBe('No longer available – remove it to continue');
  });

  it('blocks send on a retired form with no successor, and on a missing form', () => {
    const lone = mk('z-1', '01/20', '2020-01-01', 'Retired', [], undefined, 'ZF-9');
    const fills = prefillPacket([{ template: lone, itemId: 'pi-3' }], scope, {});
    const res = runChecks(fills, { scope, values: {}, latestFor: (n) => latestLive([lone], n, on), missingForms: ['Old form (QQ-1 Rev 1)'] });
    expect(res.find((r) => r.id === 'current-revisions')).toMatchObject({ level: 'block', detail: expect.stringContaining('no longer available – remove it') });
    expect(res.find((r) => r.id === 'missing-forms')).toMatchObject({ level: 'block', detail: expect.stringContaining('Old form') });
  });
});

describe('attachment limits', () => {
  const files = (n: number, mb = 1) => Array.from({ length: n }, () => ({ size: mb * MB }));

  it('allows 10 files and blocks 11', () => {
    expect(checkAttachments(files(10))).toEqual([]);
    expect(checkAttachments(files(11))).toMatchObject([{ id: 'attachments:count', level: 'block' }]);
  });

  it('allows 30 MB in total and blocks anything over', () => {
    expect(checkAttachments(files(3, 10))).toEqual([]);
    expect(checkAttachments([...files(3, 10), { size: 1 }])).toMatchObject([{ id: 'attachments:size', level: 'block' }]);
  });

  it('uses the firm’s limits over the defaults', () => {
    const limits = attachmentLimits({ maxAttachments: 3, maxAttachmentsMB: 5 });
    expect(limits).toEqual({ maxFiles: 3, maxMB: 5 });
    expect(checkAttachments(files(4), limits).map((r) => r.id)).toEqual(['attachments:count']);
    expect(checkAttachments(files(2, 3), limits).map((r) => r.id)).toEqual(['attachments:size']);
    expect(attachmentLimits(undefined)).toEqual(DEFAULT_ATTACHMENT_LIMITS);
  });
});

describe('envelope email templates', () => {
  const ctx = { client: client.contact, advisor: { ...advisor, emailSignature: undefined }, firm: FIRM, forms: ['Beneficiary designation', 'IRA distribution', 'Transfer'] };

  it('fills tokens, and missing tokens become empty strings', () => {
    expect(fillTokens('Hi {client.firstname}, here are {forms} ({formCount}).', ctx)).toBe('Hi Jordan, here are beneficiary designation, ira distribution and more (3).');
    expect(fillTokens('{client.nosuchcolumn}|{nobody.x}|{advisor}|{firm.name}', { ...ctx, client: { ...client.contact, nosuchcolumn: undefined } })).toBe('||' + '|' + FIRM.name);
    expect(fillTokens('{advisor.signature}', ctx)).toBe(`${advisor.fullname}\n${advisor.phone}`);
    expect(fillTokens('{advisor.signature}', { ...ctx, advisor: { ...advisor, emailSignature: 'Jo\nEverence' } })).toBe('Jo\nEverence');
  });

  it('still cuts the subject to 100 characters', () => {
    const s = fillSubject(`Forms for {client.fullname}: ${'x'.repeat(120)}`, ctx);
    expect(s).toHaveLength(100);
    expect(s.startsWith('Forms for Jordan A. Miller: ')).toBe(true);
    expect(fillSubject('  {client.middlename}  Forms  ', { ...ctx, client: { ...client.contact, middlename: undefined } })).toBe('Forms');
  });
});
