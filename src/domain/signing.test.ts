import { describe, expect, it, vi } from 'vitest';
import { createDemoServices } from '../services/demo';
import { injectFaults } from '../services/demo/faults';
import { guardServices } from '../services/guard';
import { createSigningRegistry } from '../services/registry';
import type { SigningProvider } from '../services/types';
import { defaultVerification, DOCUSIGN_MAIN, normalizeProviderId, providerAttachmentLimits, providerFor, verificationChoices } from './signing';

const groups = [
  { name: 'Goshen', memberIds: ['u-1'] },
  { name: 'Trust desk', memberIds: ['u-1', 'u-2'], signingProviderId: 'docusign:trust' },
];
const available = [DOCUSIGN_MAIN, 'docusign:trust', 'other:sign'];
const me = { systemuserid: 'u-1' };

describe('providerFor', () => {
  it('uses the firm default, else the first connection', () => {
    expect(providerFor({ systemuserid: 'u-9' }, groups, undefined, { defaultProviderId: 'other:sign' }, available)).toEqual({ id: 'other:sign', from: 'default' });
    expect(providerFor({ systemuserid: 'u-9' }, groups, undefined, {}, available)).toEqual({ id: DOCUSIGN_MAIN, from: 'fallback' });
  });

  it('lets a group override the default', () => {
    expect(providerFor(me, groups, undefined, { defaultProviderId: 'other:sign' }, available)).toEqual({ id: 'docusign:trust', from: 'group' });
  });

  it('lets the forms’ firm profile override the group', () => {
    expect(providerFor(me, groups, { name: 'Praxis', signingProviderId: 'other:sign' }, {}, available)).toEqual({ id: 'other:sign', from: 'firm' });
  });

  it('falls back with a warning when a configured connection is missing', () => {
    const r = providerFor(me, groups, { name: 'Praxis', signingProviderId: 'adobe:main' }, { defaultProviderId: 'docusign:gone' }, [DOCUSIGN_MAIN]);
    expect(r.id).toBe(DOCUSIGN_MAIN);
    expect(r.from).toBe('fallback');
    expect(r.warning).toMatch(/Praxis profile.*adobe:main/);
    expect(r.warning).toMatch(/Trust desk group/);
    expect(r.warning).toMatch(/firm default.*docusign:gone/);
  });

  it('reads requests from before connections as the main DocuSign connection', () => {
    expect(normalizeProviderId('DocuSign')).toBe(DOCUSIGN_MAIN);
    expect(normalizeProviderId(undefined)).toBe(DOCUSIGN_MAIN);
    expect(normalizeProviderId('other:sign')).toBe('other:sign');
  });
});

describe('capabilities', () => {
  const caps = { verification: ['email', 'sms'] as const };
  it('offers only the provider’s methods, keeping one already chosen so it can be flagged', () => {
    expect(verificationChoices({ verification: [...caps.verification] }, 'email')).toEqual(['email', 'sms']);
    expect(verificationChoices({ verification: [...caps.verification] }, 'kba')).toEqual(['email', 'sms', 'kba']);
    expect(defaultVerification({ verification: [...caps.verification] }, 'kba')).toBe('sms');
    expect(defaultVerification({ verification: ['email'] }, undefined)).toBe('email');
  });

  it('lowers the attachment limit to the provider’s', () => {
    expect(providerAttachmentLimits({ maxFiles: 10, maxMB: 30 }, { maxAttachmentsMb: 10 })).toEqual({ maxFiles: 10, maxMB: 10 });
    expect(providerAttachmentLimits({ maxFiles: 10, maxMB: 5 }, { maxAttachmentsMb: 10 })).toEqual({ maxFiles: 10, maxMB: 5 });
  });
});

describe('signing registry', () => {
  function stub(id: string): SigningProvider {
    const fail = () => Promise.reject(new Error('not used'));
    return {
      id,
      label: id,
      kind: 'other',
      capabilities: { verification: ['email'], accessCode: false, inSession: false, correctRecipient: false },
      create: fail,
      release: fail,
      getStatus: vi.fn(async () => ({ status: 'Sent' as const, recipients: [] })),
      downloadCompleted: fail,
      void: vi.fn(async () => undefined),
      resend: fail,
      correctRecipient: fail,
      signingUrl: fail,
      checkConnection: fail,
    };
  }

  it('sends each request’s actions to the connection that sent it', async () => {
    const main = stub(DOCUSIGN_MAIN);
    const other = stub('other:sign');
    const registry = createSigningRegistry([main, other]);
    const requests = [
      { provider: 'DocuSign', envelopeId: 'e-old' },
      { provider: 'other:sign', envelopeId: 'e-new' },
      { provider: DOCUSIGN_MAIN, envelopeId: 'e-main' },
    ];
    for (const r of requests) await registry.get(r.provider).getStatus(r.envelopeId);
    expect(main.getStatus).toHaveBeenCalledTimes(2);
    expect(other.getStatus).toHaveBeenCalledWith('e-new');
    await registry.get('other:sign').void('e-new', 'Wrong form');
    expect(other.void).toHaveBeenCalledWith('e-new', 'Wrong form');
  });

  it('opens a request whose connection is gone on the first one, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const registry = createSigningRegistry([stub(DOCUSIGN_MAIN)]);
    expect(registry.get('adobe:main').id).toBe(DOCUSIGN_MAIN);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    expect(() => createSigningRegistry([stub('a'), stub('a')])).toThrow(/share an id/);
  });

  it('keeps every connection, its label and capabilities through the guards and faults', () => {
    const services = guardServices(injectFaults(createDemoServices(), { mode: 'offline', afterMs: 60_000 }));
    expect(services.signing.list().map((p) => p.id)).toEqual([DOCUSIGN_MAIN, 'demo:altsign']);
    const alt = services.signing.get('demo:altsign');
    expect(alt.label).toBe('Second provider (demo)');
    expect(alt.capabilities).toMatchObject({ inSession: false, accessCode: false });
    expect(services.signing.get('DocuSign').capabilities.verification).toEqual(['email', 'sms', 'phone', 'kba']);
  });
});
