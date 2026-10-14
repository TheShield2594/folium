import type { Placement, PlacementType, VerificationMethod } from '../../domain/types';
import type { SendRequest } from '../types';

// Converts Folium's neutral placements into DocuSign eSignature REST v2.1 shapes.
// Placements are stored as page + x/y in PDF points from the top-left, which is the
// same coordinate space DocuSign uses for xPosition/yPosition, so no anchor strings
// or server templates are needed — and switching vendors means writing a new
// converter, not remapping every form.

type TabList = Record<string, unknown>[];

export interface DocuSignTabs {
  signHereTabs?: TabList;
  initialHereTabs?: TabList;
  dateSignedTabs?: TabList;
  textTabs?: TabList;
  checkboxTabs?: TabList;
}

const TAB_KEY: Record<PlacementType, keyof DocuSignTabs> = {
  signature: 'signHereTabs',
  initials: 'initialHereTabs',
  dateSigned: 'dateSignedTabs',
  text: 'textTabs',
  checkbox: 'checkboxTabs',
};

export function placementsToTabs(placements: Placement[], role: string, documentId: string): DocuSignTabs {
  const tabs: DocuSignTabs = {};
  for (const p of placements.filter((x) => x.role === role)) {
    const key = TAB_KEY[p.type];
    const tab: Record<string, unknown> = {
      documentId,
      pageNumber: String(p.page),
      xPosition: String(Math.round(p.x)),
      yPosition: String(Math.round(p.y)),
    };
    if (p.optional) tab.optional = 'true';
    if (p.type === 'text') {
      tab.width = String(Math.round(p.width ?? 140));
      tab.height = String(Math.round(p.height ?? 18));
      tab.required = p.optional ? 'false' : 'true';
    }
    (tabs[key] ??= []).push(tab);
  }
  return tabs;
}

/** Joins the roles of one person who signs for several (see buildEnvelopeDefinition). */
export const ROLE_SEPARATOR = '+';

/** DocuSign identity-verification workflow IDs for the account (Settings › Identity Verification). */
export interface IdvWorkflows {
  sms?: string;
  /** Phone authentication. */
  phone?: string;
  kba?: string;
}

/** Weakest to strongest. Phone and SMS both prove the same phone, so they rank equally. */
export const AUTH_STRENGTH: Record<VerificationMethod, number> = { email: 0, sms: 1, phone: 1, kba: 2 };

/** For `clientUserId`: who an in-session signer is, stable across fresh signing links. */
export const clientUserIdFor = (s: { role: string; contactId?: string }) => s.contactId ?? s.role;

/**
 * The identity-verification settings for one signer. Throws rather than quietly sending
 * a financial form with weaker verification than the advisor chose.
 */
function authFor(method: VerificationMethod, phone: string | undefined, idv: IdvWorkflows, who: string): Record<string, unknown> {
  if (method === 'sms' || method === 'phone') {
    const workflowId = idv[method];
    const what = method === 'sms' ? 'SMS verification' : 'Phone authentication';
    if (!workflowId) throw new Error(`${what} isn’t set up for this DocuSign account. Choose another method or ask an administrator.`);
    const number = (phone ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    if (number.length !== 10) throw new Error(`${who} needs a ${method === 'sms' ? 'mobile' : 'phone'} number for ${what}.`);
    return {
      identityVerification: {
        workflowId,
        inputOptions: [{ name: 'phone_number_list', valueType: 'PhoneNumberList', phoneNumberList: [{ countryCode: '1', number }] }],
      },
    };
  }
  if (method === 'kba') {
    if (!idv.kba) throw new Error('ID-question (KBA) verification isn’t set up for this DocuSign account. Choose another method or ask an administrator.');
    return { identityVerification: { workflowId: idv.kba } };
  }
  return {};
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

/** Build an `envelopeDefinition` for POST /v2.1/accounts/{accountId}/envelopes. */
export function buildEnvelopeDefinition(req: SendRequest, idv: IdvWorkflows = {}, status: 'sent' | 'created' = 'sent') {
  const documents = req.documents.map((d, i) => ({
    documentId: String(i + 1),
    name: d.name,
    fileExtension: 'pdf',
    documentBase64: toBase64(d.pdf),
  }));
  const attachments = (req.attachments ?? []).map((a, i) => ({
    documentId: String(req.documents.length + i + 1),
    name: a.name,
    fileExtension: 'pdf',
    documentBase64: toBase64(a.pdf),
  }));

  // One person can hold two roles (joint owner and consenting spouse). They become one
  // DocuSign recipient with every role's tabs, so they get one email and sign once.
  const people = new Map<string, SendRequest['signers']>();
  for (const s of req.signers) {
    const key = `${s.name.trim().toLowerCase()}|${s.email.trim().toLowerCase()}`;
    people.set(key, [...(people.get(key) ?? []), s]);
  }
  const signers = [...people.values()].map((roles, i) => {
    const s = roles[0];
    const auth = roles.reduce((a, r) => (AUTH_STRENGTH[r.auth] > AUTH_STRENGTH[a] ? r.auth : a), s.auth);
    const phone = roles.find((r) => r.phone)?.phone;
    // Roles merged into one person use the first code set (the Send screen warns when they differ).
    const accessCode = roles.find((r) => r.accessCode?.trim())?.accessCode?.trim();
    const inSession = roles.find((r) => r.inSession);
    const merged: DocuSignTabs = {};
    req.documents.forEach((d, di) => {
      for (const r of roles) {
        const tabs = placementsToTabs(d.placements, r.role, String(di + 1));
        for (const [k, v] of Object.entries(tabs) as [keyof DocuSignTabs, TabList][]) (merged[k] ??= []).push(...v);
      }
    });
    return {
      recipientId: String(i + 1),
      roleName: roles.map((r) => r.role).join(ROLE_SEPARATOR),
      name: s.name,
      email: s.email,
      // An in-session signer doesn't wait in the routing order, as in Laser App.
      routingOrder: inSession ? '1' : String(Math.min(...roles.map((r) => r.order))),
      tabs: merged,
      ...(accessCode ? { accessCode } : {}),
      ...(inSession ? { clientUserId: clientUserIdFor(inSession) } : {}),
      ...authFor(auth, phone, idv, s.name),
    };
  });

  const carbonCopies = (req.ccs ?? []).map((c, i) => ({
    recipientId: String(signers.length + i + 1),
    name: c.name,
    email: c.email,
    routingOrder: String(Math.max(1, ...req.signers.map((s) => s.order)) + 1),
  }));

  return {
    emailSubject: req.subject.slice(0, 100),
    emailBlurb: req.message.slice(0, 10000),
    documents: [...documents, ...attachments],
    recipients: { signers, carbonCopies },
    notification: {
      useAccountDefaults: 'false',
      reminders: req.reminderDays
        ? { reminderEnabled: 'true', reminderDelay: String(req.reminderDays), reminderFrequency: String(req.reminderDays) }
        : { reminderEnabled: 'false' },
      expirations: { expireEnabled: 'true', expireAfter: String(req.expiresInDays ?? 120), expireWarn: '7' },
    },
    status,
  };
}
