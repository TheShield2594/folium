import { describe, expect, it } from 'vitest';
import { CLIENTS, FIRM, FIRMS, TEMPLATES, USERS } from '../services/demo/seed';
import { DEFAULT_FIRM_ID, envelopeDisclosure, firmFor, firmGroup, firmProblems, firmReason, normalizeFirms, setDefaultFirm, templateIssuers, templatesUsing } from './firms';
import { prefillPacket } from './prefill';
import type { FirmProfile, FormTemplate } from './types';

const [def, trust, praxis] = FIRMS;
const t = (x: Partial<FormTemplate>) => ({ source: 'Everence', ...x }) as Pick<FormTemplate, 'firmId' | 'issuer' | 'source'>;

describe('firmFor', () => {
  it('uses the template’s own firm first, even over its issuer', () => {
    expect(firmFor(t({ issuer: 'Praxis Mutual Funds', firmId: 'firm-trust' }), FIRMS)?.id).toBe('firm-trust');
  });

  it('matches the issuer, ignoring case and spaces', () => {
    expect(firmFor(t({ issuer: ' praxis mutual funds ' }), FIRMS)?.id).toBe('firm-praxis');
    expect(firmFor(t({ issuer: 'Everence Foundation' }), FIRMS)?.id).toBe('firm-trust');
    // No issuer: the source stands in for it.
    expect(firmFor(t({ source: 'Praxis' }), [...FIRMS.slice(0, 2), { ...praxis, issuers: ['Praxis'] }])?.id).toBe('firm-praxis');
  });

  it('falls back to the group’s default, then the firm default', () => {
    const carrier = t({ source: 'Carrier', issuer: 'Sample Annuity Co.' });
    expect(firmFor(carrier, FIRMS, { defaultFirmId: 'firm-praxis' })?.id).toBe('firm-praxis');
    expect(firmFor(carrier, FIRMS)?.id).toBe('firm-default');
    // An override naming a removed profile is passed over.
    expect(firmFor(t({ issuer: 'Sample Annuity Co.', firmId: 'gone' }), FIRMS, { defaultFirmId: 'also-gone' })?.id).toBe('firm-default');
  });

  it('has nothing to give with no profiles', () => {
    expect(firmFor(t({ issuer: 'Everence Financial' }), [])).toBeUndefined();
    expect(firmReason(t({}), [])).toBeUndefined();
  });

  it('says why a template gets its profile', () => {
    expect(firmReason(t({ firmId: 'firm-trust' }), FIRMS)).toBe('override');
    expect(firmReason(t({ issuer: 'Everence Trust Company' }), FIRMS)).toBe('issuer');
    expect(firmReason(t({ issuer: 'Sample Life Insurance Co.' }), FIRMS)).toBe('default');
  });

  it('takes the group default from the first of the person’s groups that names one', () => {
    const groups = [
      { id: 'g1', name: 'A', memberIds: ['u-1'] },
      { id: 'g2', name: 'B', memberIds: ['u-1'], defaultFirmId: 'firm-trust' },
      { id: 'g3', name: 'C', memberIds: ['u-2'], defaultFirmId: 'firm-praxis' },
    ];
    expect(firmGroup({ systemuserid: 'u-1' }, groups)?.id).toBe('g2');
    expect(firmGroup({ systemuserid: 'u-9' }, groups)).toBeUndefined();
  });
});

describe('stored profiles', () => {
  it('makes the profile from before profiles the default, with no issuers', () => {
    const { id: _i, isDefault: _d, issuers: _s, ...old } = FIRM;
    const [only] = normalizeFirms([old]);
    expect(only).toMatchObject({ id: DEFAULT_FIRM_ID, isDefault: true, issuers: [], legalName: FIRM.legalName });
  });

  it('keeps exactly one default', () => {
    const firms = normalizeFirms([
      { ...trust, isDefault: true },
      { ...praxis, isDefault: true },
    ]);
    expect(firms.filter((f) => f.isDefault).map((f) => f.id)).toEqual(['firm-trust']);
    expect(normalizeFirms([trust, praxis]).filter((f) => f.isDefault).map((f) => f.id)).toEqual(['firm-trust']);
  });

  it('moves the firm-wide settings with the default', () => {
    const firms = [{ ...def, idleAutoSave: true, reportsUrl: 'https://app.powerbi.com/x', sending: { defaultAnyOrder: true } }, trust];
    const next = setDefaultFirm(firms, 'firm-trust');
    expect(next[1]).toMatchObject({ isDefault: true, idleAutoSave: true, reportsUrl: 'https://app.powerbi.com/x', sending: { defaultAnyOrder: true } });
    expect(next[0]).toMatchObject({ isDefault: false, idleAutoSave: undefined, reportsUrl: undefined, sending: undefined });
    expect(next[0].legalName).toBe(def.legalName);
  });

  it('won’t save a nameless profile or an issuer another profile has', () => {
    expect(firmProblems({ ...praxis, name: ' ' }, FIRMS).name).toBeTruthy();
    expect(firmProblems({ ...praxis, name: 'everence trust company' }, FIRMS).name).toMatch(/Another/);
    expect(firmProblems({ ...praxis, issuers: ['Praxis Mutual Funds', 'Everence Foundation'] }, FIRMS).issuers).toMatch(/Everence Foundation/);
    expect(firmProblems(praxis, FIRMS)).toEqual({});
  });

  it('lists the library’s issuers and the templates each profile fills', () => {
    const issuers = templateIssuers(TEMPLATES);
    expect(issuers).toContain('Everence Trust Company');
    expect(new Set(issuers.map((i) => i.toLowerCase())).size).toBe(issuers.length);
    const trustForms = templatesUsing(trust, TEMPLATES, FIRMS);
    expect(trustForms.length).toBeGreaterThan(0);
    expect(trustForms.every((x) => ['Everence Trust Company', 'Everence Foundation'].includes(x.issuer!))).toBe(true);
  });
});

describe('envelope disclosure', () => {
  it('starts with the default’s, then adds each different one once', () => {
    expect(envelopeDisclosure(def, [def, trust, trust, praxis])).toBe([def.disclosure, trust.disclosure, praxis.disclosure].join('\n\n'));
    expect(envelopeDisclosure(def, [def])).toBe(def.disclosure);
    expect(envelopeDisclosure({ disclosure: '' }, [undefined, { ...trust, disclosure: '  ' }])).toBe('');
  });
});

describe('prefill with several profiles', () => {
  const client = CLIENTS['c-jordan'];
  const advisor = USERS[0];
  const trustForm = TEMPLATES.find((x) => x.id === 'tpl-ev2210-0626')!;
  const praxisForm = TEMPLATES.find((x) => x.id === 'tpl-px310-0826')!;
  const scope = { client, advisor, firm: def, firms: FIRMS };
  const firmField = (fill: ReturnType<typeof prefillPacket>[number], source: string) => fill.fields.find((f) => f.mapping.source === source)!;

  it('fills each form’s firm fields from its own issuer’s profile', () => {
    const [a, b] = prefillPacket([{ template: trustForm }, { template: praxisForm }], scope, {});
    expect(firmField(a, 'firm.legalName')).toMatchObject({ value: trust.legalName, origin: 'firm', sourceLabel: 'Firm profile: Everence Trust Company', firm: { id: 'firm-trust' } });
    expect(firmField(b, 'firm.legalName')).toMatchObject({ value: praxis.legalName, firm: { id: 'firm-praxis' } });
    expect(a.firm?.id).toBe('firm-trust');
  });

  it('keeps a correction to one entity off the other entity’s form', () => {
    const [a0] = prefillPacket([{ template: trustForm }], scope, {});
    const key = firmField(a0, 'firm.legalName').key;
    expect(key).toBe('firm[firm-trust].legalName');
    const [a, b] = prefillPacket([{ template: trustForm }, { template: praxisForm }], scope, { [key]: 'Everence Trust Co.' });
    expect(firmField(a, 'firm.legalName')).toMatchObject({ value: 'Everence Trust Co.', origin: 'edited' });
    expect(firmField(b, 'firm.legalName').value).toBe(praxis.legalName);
  });

  it('keeps the default profile’s keys as they were, so saved drafts still fill', () => {
    const general = { ...trustForm, id: 'x', issuer: 'Everence Financial' };
    const [g] = prefillPacket([{ template: general }], scope, { 'firm.legalName': 'Edited' });
    expect(firmField(g, 'firm.legalName')).toMatchObject({ key: 'firm.legalName', value: 'Edited' });
  });

  it('fills from the one firm when there are no profiles', () => {
    const one: FirmProfile = { ...trust, isDefault: true };
    const [a] = prefillPacket([{ template: praxisForm }], { client, advisor, firm: one }, {});
    expect(firmField(a, 'firm.legalName')).toMatchObject({ value: trust.legalName, key: 'firm.legalName' });
  });
});
