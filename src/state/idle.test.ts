import { describe, expect, it } from 'vitest';
import { prefillPacket } from '../domain/prefill';
import { createDemoServices, resetDemo } from '../services/demo';
import { CLIENTS, FIRM, TEMPLATES, USERS } from '../services/demo/seed';
import { saveDraft } from './actions';
import { countdown, idleState, WARNING_MS } from './idle';

const MIN = 60_000;

describe('idle auto-save timing', () => {
  it('stays quiet, then counts down for 2 minutes, then is due', () => {
    const idle = 25 * MIN;
    expect(idleState(0, 24 * MIN, idle)).toEqual({ phase: 'active' });
    expect(idleState(0, 25 * MIN, idle)).toEqual({ phase: 'warning', remainingMs: WARNING_MS });
    expect(idleState(0, 26 * MIN + 30_000, idle)).toEqual({ phase: 'warning', remainingMs: 30_000 });
    expect(idleState(0, 27 * MIN, idle)).toEqual({ phase: 'due' });
    // Activity moves the clock.
    expect(idleState(20 * MIN, 27 * MIN, idle)).toEqual({ phase: 'active' });
  });

  it('formats the countdown', () => {
    expect(countdown(WARNING_MS)).toBe('2:00');
    expect(countdown(65_000)).toBe('1:05');
    expect(countdown(400)).toBe('0:01');
    expect(countdown(-5)).toBe('0:00');
  });

  it('notes an automatic save in the draft’s audit trail', async () => {
    resetDemo();
    const services = createDemoServices();
    const me = USERS[0];
    const t = TEMPLATES.find((x) => x.id === 'tpl-ev1120-0326')!;
    const fills = prefillPacket([{ template: t }], { client: CLIENTS['c-jordan'], advisor: me, firm: FIRM }, {});
    const packet = { items: [{ templateId: t.id }], values: {}, title: 'Beneficiaries', attachments: [], sharedWith: [] };
    const saved = await saveDraft({ services, packet, fills, contactId: 'c-jordan', me, owner: me, auditNote: 'saved automatically after 25 minutes idle' });
    expect(saved.audit.at(-1)).toMatchObject({ action: 'Draft saved', detail: 'saved automatically after 25 minutes idle' });
    const plain = await saveDraft({ services, packet, fills, contactId: 'c-jordan', me, owner: me, existing: saved });
    expect(plain.audit.at(-1)).toMatchObject({ action: 'Draft updated', detail: undefined });
  });
});
