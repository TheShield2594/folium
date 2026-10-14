import { describe, expect, it } from 'vitest';
import { CLIENTS, FIRM, TEMPLATES, USERS } from '../services/demo/seed';
import { runChecks } from './checks';
import { prefillPacket } from './prefill';
import { availableIn, normalizeState, parseStatesFromTitle, pickVariant } from './states';

describe('states', () => {
  it('reads codes and names from Dynamics', () => {
    expect(normalizeState('in')).toBe('IN');
    expect(normalizeState(' Indiana ')).toBe('IN');
    expect(normalizeState('District of Columbia')).toBe('DC');
    expect(normalizeState('ON')).toBeUndefined();
    expect(normalizeState('')).toBeUndefined();
  });

  it('treats a form with no states as approved everywhere', () => {
    expect(availableIn({}, 'PA')).toBe(true);
    expect(availableIn({ states: [] }, 'PA')).toBe(true);
    expect(availableIn({ states: ['IN', 'OH'] }, 'PA')).toBe(false);
    expect(availableIn({ states: ['IN', 'OH'] }, 'indiana')).toBe(true);
    // Unknown state: can't tell, so don't hide it.
    expect(availableIn({ states: ['IN'] }, undefined)).toBe(true);
  });

  it('reads the state list from a carrier title', () => {
    expect(parseStatesFromTitle('Adv Select App [AZ-CO-GA-WV] - 4471')).toEqual(['AZ', 'CO', 'GA', 'WV']);
    expect(parseStatesFromTitle('Annuity disclosure (CO, AZ)')).toEqual(['AZ', 'CO']);
    expect(parseStatesFromTitle('Rider [NY] and notice (NY/NJ)')).toEqual(['NJ', 'NY']);
  });

  it('ignores groups that aren’t all state codes', () => {
    expect(parseStatesFromTitle('Praxis Growth Index (IRA)')).toEqual([]);
    expect(parseStatesFromTitle('Application [AZ-XX-CO]')).toEqual([]);
    expect(parseStatesFromTitle('Transfer form [NEW]')).toEqual([]);
    expect(parseStatesFromTitle('Notice (in or out)')).toEqual([]);
    expect(parseStatesFromTitle('Beneficiary designation')).toEqual([]);
  });

  it('picks the version of a form for a state', () => {
    const group = [
      { id: 'multi', variantGroup: 'g', states: ['IN', 'OH'] },
      { id: 'va', variantGroup: 'g', states: ['VA'] },
      { id: 'other', variantGroup: 'h', states: ['VA'] },
    ];
    expect(pickVariant(group, 'g', 'VA')?.id).toBe('va');
    expect(pickVariant(group, 'g', 'oh')?.id).toBe('multi');
    expect(pickVariant(group, 'g', 'TX')).toBeUndefined();
    expect(pickVariant([...group, { id: 'all', variantGroup: 'g' }], 'g', 'TX')?.id).toBe('all');
  });
});

describe('state checks', () => {
  const sl200 = TEMPLATES.find((t) => t.id === 'tpl-sl200-0226')!;
  const bene = TEMPLATES.find((t) => t.id === 'tpl-ev1120-0326')!;
  const advisor = USERS[0];
  const run = (state: string | undefined, licensedStates?: string[]) => {
    const scope = { client: CLIENTS['c-jordan'], advisor, firm: FIRM, today: new Date(2026, 9, 13) };
    const fills = prefillPacket([{ template: sl200 }, { template: bene }], scope, {});
    return runChecks(fills, { scope, values: {}, latestFor: () => undefined, state, licensedStates });
  };

  it('blocks a form not approved in the packet’s state, and says where it is', () => {
    const r = run('VA').find((c) => c.id.endsWith(':state'));
    expect(r).toMatchObject({ level: 'block', templateId: sl200.id });
    expect(r?.detail).toBe('Not approved in VA. Approved in: IL, IN, KS, MI, OH, PA.');
    expect(run('IN').some((c) => c.level === 'block' && c.id.endsWith(':state'))).toBe(false);
    expect(run('IN').find((c) => c.id === 'state')?.level).toBe('pass');
  });

  it('warns when a state-limited form has no packet state', () => {
    expect(run(undefined).find((c) => c.id === 'state:unknown')?.level).toBe('warn');
  });

  it('leaves packets of forms with no states alone', () => {
    const scope = { client: CLIENTS['c-jordan'], advisor, firm: FIRM };
    const results = runChecks(prefillPacket([{ template: bene }], scope, {}), { scope, values: {}, latestFor: () => undefined, state: undefined });
    expect(results.some((c) => c.id.startsWith('state'))).toBe(false);
  });

  it('warns when the advisor isn’t licensed in the state', () => {
    expect(run('PA', ['IN', 'OH']).find((c) => c.id === 'state:licence')?.level).toBe('warn');
    expect(run('IN', ['IN', 'OH']).some((c) => c.id === 'state:licence')).toBe(false);
    expect(run('PA').some((c) => c.id === 'state:licence')).toBe(false);
  });
});
