import type { VerificationMethod } from './types';

// The firm's DocuSign setup (Administration › Settings › DocuSign), kept in its own
// `ev_foliumsetting` row ("DocuSign"). The integration key's secret never comes here:
// it lives in the custom connector, where Power Platform stores it encrypted. Each
// person signs in to DocuSign with their own login through their connection to that
// connector, so envelopes go out from their own DocuSign user.

export type DocuSignEnvironment = 'demo' | 'production';

export interface DocuSignSetup {
  /** Developer sandbox (`account-d.docusign.com`) or production (`account.docusign.com`). */
  environment: DocuSignEnvironment;
  /** API Account ID (a GUID) from DocuSign Admin › Apps and Keys. Every call names it. */
  accountId?: string;
  /** The Folium app's integration key (OAuth client ID). Public; used only to build the consent link. */
  integrationKey?: string;
  /** The custom connector's redirect URL, registered on the DocuSign app. */
  redirectUrl?: string;
  /** Identity-verification workflow IDs from DocuSign Admin › Identity Verification. */
  idv: { sms?: string; phone?: string; kba?: string };
}

/** Power Platform's redirect for custom connectors created before per-connector redirect URLs. */
export const DEFAULT_REDIRECT_URL = 'https://global.consent.azure-apim.net/redirect';

export const DOCUSIGN_ENVIRONMENTS: Record<DocuSignEnvironment, { label: string; authHost: string; apiHost: string }> = {
  demo: { label: 'Developer sandbox', authHost: 'account-d.docusign.com', apiHost: 'demo.docusign.net' },
  production: { label: 'Production', authHost: 'account.docusign.com', apiHost: 'your account’s base URI, e.g. na3.docusign.net' },
};

const trimOrUndefined = (s: unknown) => (typeof s === 'string' && s.trim() ? s.trim() : undefined);

/** A stored setup with defaults for anything missing (a missing row is a sandbox with nothing set). */
export function withDocuSignDefaults(s: Partial<DocuSignSetup> | undefined): DocuSignSetup {
  return {
    environment: s?.environment === 'production' ? 'production' : 'demo',
    accountId: trimOrUndefined(s?.accountId),
    integrationKey: trimOrUndefined(s?.integrationKey),
    redirectUrl: trimOrUndefined(s?.redirectUrl),
    idv: { sms: trimOrUndefined(s?.idv?.sms), phone: trimOrUndefined(s?.idv?.phone), kba: trimOrUndefined(s?.idv?.kba) },
  };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGuid = (s: string | undefined) => !!s && GUID.test(s.trim());

/** What's wrong with a setup before it's saved, by field. Empty when it can be saved. */
export function docuSignProblems(s: DocuSignSetup): Partial<Record<'accountId' | 'integrationKey' | 'redirectUrl' | 'sms' | 'phone' | 'kba', string>> {
  const out: ReturnType<typeof docuSignProblems> = {};
  if (s.accountId && !isGuid(s.accountId)) out.accountId = 'The API Account ID looks like 1a2b3c4d-…, 36 characters. It isn’t the short account number.';
  if (s.integrationKey && !isGuid(s.integrationKey)) out.integrationKey = 'The integration key looks like 1a2b3c4d-…, 36 characters.';
  if (s.redirectUrl && !/^https:\/\/\S+$/.test(s.redirectUrl)) out.redirectUrl = 'Enter the full https:// address from the custom connector’s Security tab.';
  for (const k of ['sms', 'phone', 'kba'] as const) if (s.idv[k] && !isGuid(s.idv[k])) out[k] = 'Workflow IDs look like 1a2b3c4d-…, 36 characters.';
  return out;
}

/** Whether Folium can send: the account is named. Each person still needs their own DocuSign sign-in. */
export const docuSignReady = (s: DocuSignSetup | undefined) => isGuid(s?.accountId);

/** Whether this verification method can be sent with the firm's setup. Email needs no workflow. */
export const methodSetUp = (s: DocuSignSetup | undefined, m: VerificationMethod) => m === 'email' || !!s?.idv[m];

/**
 * DocuSign's individual-consent link for the Folium app, for a person whose DocuSign
 * answers `consent_required`. Undefined until the integration key is set.
 */
export function consentUrl(s: DocuSignSetup | undefined): string | undefined {
  if (!s?.integrationKey) return undefined;
  const q = new URLSearchParams({ response_type: 'code', scope: 'signature', client_id: s.integrationKey, redirect_uri: s.redirectUrl ?? DEFAULT_REDIRECT_URL });
  return `https://${DOCUSIGN_ENVIRONMENTS[s.environment].authHost}/oauth/auth?${q}`;
}
