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

/** DocuSign identity-verification workflow IDs for the account (Settings › Identity Verification). */
export interface IdvWorkflows {
  sms?: string;
  kba?: string;
}

function authFor(method: VerificationMethod, phone: string | undefined, idv: IdvWorkflows): Record<string, unknown> {
  if (method === 'sms' && phone && idv.sms) {
    const number = phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    return {
      identityVerification: {
        workflowId: idv.sms,
        inputOptions: [{ name: 'phone_number_list', valueType: 'PhoneNumberList', phoneNumberList: [{ countryCode: '1', number }] }],
      },
    };
  }
  if (method === 'kba' && idv.kba) return { identityVerification: { workflowId: idv.kba } };
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

  const signers = req.signers.map((s, i) => {
    const merged: DocuSignTabs = {};
    req.documents.forEach((d, di) => {
      const tabs = placementsToTabs(d.placements, s.role, String(di + 1));
      for (const [k, v] of Object.entries(tabs) as [keyof DocuSignTabs, TabList][]) (merged[k] ??= []).push(...v);
    });
    return {
      recipientId: String(i + 1),
      roleName: s.role,
      name: s.name,
      email: s.email,
      routingOrder: String(s.order),
      tabs: merged,
      ...authFor(s.auth, s.phone, idv),
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
