import { describe, expect, it } from 'vitest';
import { applyEnvelopeStatus, signingEventMessage, signingReturnUrl, withSigningEvent } from '../../domain/requests';
import { accessCodeWarnings, envelopeSigners, generateAccessCode, recordedSigners, validateSigners } from '../../domain/signers';
import type { SignatureRequest, SignerAssignment } from '../../domain/types';
import { isConsentRequired } from '../errors';
import type { SendRequest } from '../types';
import { buildEnvelopeDefinition } from './tabs';

const doc = { name: 'Form.pdf', pdf: new Uint8Array([1]), placements: [] };
const send = (signers: SendRequest['signers']): SendRequest => ({ documents: [doc], signers, subject: 'Sign', message: '' });
const jordan: SignerAssignment = { role: 'Owner', name: 'Jordan Miller', email: 'j@x.co', phone: '574-555-0118', order: 1, auth: 'email', contactId: 'c-jordan' };
const sam: SignerAssignment = { role: 'SpouseConsent', name: 'Sam Miller', email: 's@x.co', order: 2, auth: 'email' };

describe('access codes', () => {
  it('adds the code to the DocuSign recipient, alongside SMS', () => {
    const env = buildEnvelopeDefinition(send(envelopeSigners([{ ...jordan, auth: 'sms' }, sam], { Owner: '482913' })), { sms: 'wf-sms' });
    expect(env.recipients.signers[0]).toMatchObject({ accessCode: '482913', identityVerification: { workflowId: 'wf-sms' } });
    expect(env.recipients.signers[1]).not.toHaveProperty('accessCode');
  });

  it('gives merged roles one code, the first set, and warns when they differ', () => {
    const joint = { ...sam, role: 'JointOwner', order: 2 };
    const consent = { ...sam, order: 3 };
    const codes = { JointOwner: '111111', SpouseConsent: '222222' };
    const env = buildEnvelopeDefinition(send(envelopeSigners([joint, consent], codes)));
    expect(env.recipients.signers).toHaveLength(1);
    expect(env.recipients.signers[0].accessCode).toBe('111111');
    expect(accessCodeWarnings([joint, consent], codes)).toHaveLength(1);
    expect(accessCodeWarnings([joint, consent], { JointOwner: '111111', SpouseConsent: '111111' })).toEqual([]);
    expect(accessCodeWarnings([joint, consent], { SpouseConsent: '222222' })).toEqual([]);
  });

  it('never saves the code with the request', () => {
    const codes = { Owner: '482913' };
    const saved = recordedSigners(envelopeSigners([jordan, sam], codes), codes);
    expect(saved[0].accessCodeSet).toBe(true);
    expect(saved[1].accessCodeSet).toBeUndefined();
    expect(saved.map((s) => s.status)).toEqual(['sent', 'pending']);
    const req = { signers: saved, values: {}, audit: [] } as unknown as SignatureRequest;
    expect(JSON.stringify(req)).not.toContain('482913');
  });

  it('generates six digits', () => {
    for (let i = 0; i < 20; i++) expect(generateAccessCode()).toMatch(/^\d{6}$/);
    expect(generateAccessCode(() => 7)).toBe('777777');
  });
});

describe('in-session signing', () => {
  it('sets clientUserId and routing order 1 for an in-session signer', () => {
    const env = buildEnvelopeDefinition(send([{ ...jordan, order: 2, inSession: true }, { ...sam, order: 1 }]));
    expect(env.recipients.signers[0]).toMatchObject({ clientUserId: 'c-jordan', routingOrder: '1' });
    expect(env.recipients.signers[1]).not.toHaveProperty('clientUserId');
    // Without a contact, the role identifies them.
    expect(buildEnvelopeDefinition(send([{ ...sam, inSession: true }])).recipients.signers[0].clientUserId).toBe('SpouseConsent');
  });

  it('records an in-session signer as sent even when later in the order', () => {
    expect(recordedSigners([jordan, { ...sam, inSession: true }], {}).map((s) => s.status)).toEqual(['sent', 'sent']);
  });

  it('builds the return URL and reads DocuSign’s events', () => {
    const url = signingReturnUrl('https://apps.example/play/app?demo=1#/requests', 'env-1', 'Owner');
    expect(url).toBe('https://apps.example/play/app?demo=1#/signing-return?envelope=env-1&role=Owner');
    expect(withSigningEvent(url, 'signing_complete')).toMatch(/&event=signing_complete$/);
    expect(withSigningEvent('https://x/#/a', 'cancel')).toBe('https://x/#/a?event=cancel');
    expect(signingEventMessage('signing_complete', 'Jordan')).toMatchObject({ done: true, audit: 'Signed in session' });
    expect(signingEventMessage('cancel', 'Jordan').done).toBe(false);
    expect(signingEventMessage('ttl_expired', 'Jordan').text).toMatch(/fresh one/);
  });

  it('lets a cancelled session be reopened with a fresh link (demo)', async () => {
    const { createDemoServices, demoSignInSession } = await import('../demo');
    const signing = createDemoServices().signing.get('docusign:main');
    const { envelopeId } = await signing.create(send([{ ...jordan, inSession: true }, { ...sam, order: 2 }]));
    await signing.release(envelopeId);
    const first = await signing.signingUrl(envelopeId, 'Owner', 'https://app/#/signing-return?envelope=x');
    const second = await signing.signingUrl(envelopeId, 'Owner', 'https://app/#/signing-return?envelope=x');
    expect(first).toContain('#/demo-signing?');
    expect(second).toContain('#/demo-signing?');
    await expect(signing.signingUrl(envelopeId, 'SpouseConsent', 'x')).rejects.toThrow(/by email/);

    const before = await signing.getStatus(envelopeId);
    expect(before.recipients.find((r) => r.role === 'Owner')?.status).toBe('sent');
    demoSignInSession(envelopeId, 'Owner');
    const after = await signing.getStatus(envelopeId);
    expect(after.recipients.find((r) => r.role === 'Owner')?.status).toBe('completed');

    const req = { status: 'Sent', signers: recordedSigners([{ ...jordan, inSession: true }, { ...sam, order: 2 }], {}), audit: [] } as unknown as SignatureRequest;
    const { next, changed } = applyEnvelopeStatus(req, after);
    expect(changed).toBe(true);
    expect(next.signers[0].status).toBe('signed');
    expect(next.audit.some((a) => a.action === 'Signed')).toBe(true);
  });
});

describe('phone authentication', () => {
  it('builds identityVerification from the phone workflow and throws when it isn’t set up', () => {
    const env = buildEnvelopeDefinition(send([{ ...jordan, auth: 'phone' }]), { phone: 'wf-phone' });
    expect(env.recipients.signers[0]).toHaveProperty('identityVerification.workflowId', 'wf-phone');
    expect(env.recipients.signers[0]).toHaveProperty('identityVerification.inputOptions.0.phoneNumberList.0.number', '5745550118');
    expect(() => buildEnvelopeDefinition(send([{ ...jordan, auth: 'phone' }]), { sms: 'wf-sms' })).toThrow(/Phone authentication isn’t set up/);
    expect(() => buildEnvelopeDefinition(send([{ ...jordan, auth: 'phone', phone: '' }]), { phone: 'wf-phone' })).toThrow(/phone number/);
  });

  it('needs a 10-digit number and ranks with SMS, below KBA', () => {
    expect(validateSigners([{ ...jordan, auth: 'phone', phone: '555-0118' }])[0].message).toMatch(/10-digit phone/);
    expect(validateSigners([{ ...jordan, auth: 'phone' }])).toEqual([]);
    const merged = (a: SignerAssignment['auth'], b: SignerAssignment['auth']) =>
      buildEnvelopeDefinition(send([{ ...sam, auth: a, phone: '5745550118' }, { ...sam, role: 'JointOwner', auth: b, phone: '5745550118' }]), { sms: 'wf-sms', phone: 'wf-phone', kba: 'wf-kba' }).recipients.signers[0];
    expect(merged('email', 'phone')).toHaveProperty('identityVerification.workflowId', 'wf-phone');
    expect(merged('phone', 'sms')).toHaveProperty('identityVerification.workflowId', 'wf-phone');
    expect(merged('phone', 'kba')).toHaveProperty('identityVerification.workflowId', 'wf-kba');
  });
});

describe('consent', () => {
  it('recognises DocuSign’s consent_required', () => {
    expect(isConsentRequired(new Error('{"error":"consent_required"}'))).toBe(true);
    expect(isConsentRequired({ error: { code: 'consent_required', message: 'Consent required' } })).toBe(true);
    expect(isConsentRequired(new Error('Bad request'))).toBe(false);
  });
});
