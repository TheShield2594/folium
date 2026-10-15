import type { FirmProfile, UserGroup, UserProfile, VerificationMethod } from './types';

// E-signature connections (#30). Each provider and account pair is one connection with
// its own id (`docusign:main`), so a second DocuSign account or another provider is a
// new adapter and connection, not a change to Send and Requests. A request remembers
// the connection that sent it.

/** The connection every Folium had before connections: the `foliumdocusign` connector. */
export const DOCUSIGN_MAIN = 'docusign:main';

/** What a provider can do. The Send and Requests screens offer only these. */
export interface ProviderCapabilities {
  /** Ways a signer can prove who they are, in the order the Send screen lists them. */
  verification: VerificationMethod[];
  /** A per-signer access code the advisor gives the client. */
  accessCode: boolean;
  /** Signing now on the advisor's device (embedded signing). */
  inSession: boolean;
  /** Changing a signer's name, email or phone after sending. */
  correctRecipient: boolean;
  /** Most megabytes of supporting documents the provider takes on one envelope, when it's lower than the firm's limit. */
  maxAttachmentsMb?: number;
  /** Days an envelope can stay open, when the provider limits the choices. */
  expiryDays?: number[];
}

/** Firm-wide e-signature choices, in the "Signing" `ev_foliumsetting` row. Accounts are always company-level. */
export interface SigningSettings {
  /** The connection used unless a firm profile or group says otherwise. Unset: the first registered. */
  defaultProviderId?: string;
  /** Let people pick another connection on the Send screen. Off: the rules below decide. */
  userChoice?: boolean;
}

export const VERIFICATION_LABEL: Record<VerificationMethod, string> = { email: 'Email only', sms: 'SMS code', phone: 'Phone call', kba: 'ID questions (KBA)' };

/** Expiry choices when the provider doesn't limit them. */
export const DEFAULT_EXPIRY_DAYS = [30, 60, 120];

/** A stored connection id as today's: rows from before connections say `DocuSign`. */
export function normalizeProviderId(id: string | undefined): string {
  const v = id?.trim();
  if (!v || v.toLowerCase() === 'docusign') return DOCUSIGN_MAIN;
  return v;
}

export interface ProviderChoice {
  id: string;
  /** Why: the firm profile's, the group's, the firm default, or the first registered. */
  from: 'firm' | 'group' | 'default' | 'fallback';
  /** Set when a configured connection isn't registered and Folium fell back. */
  warning?: string;
}

/**
 * The connection a packet sends with:
 * 1. the firm profile of the packet's forms (the entity's own account)
 * 2. the first of the sender's groups that names one
 * 3. the firm default
 * 4. the first registered connection
 * A configured id that isn't registered (removed, or a typo) is skipped with a warning.
 */
export function providerFor(
  user: Pick<UserProfile, 'systemuserid'> | undefined,
  groups: Pick<UserGroup, 'memberIds' | 'signingProviderId' | 'name'>[],
  firm: Pick<FirmProfile, 'signingProviderId' | 'name'> | undefined,
  settings: SigningSettings | undefined,
  available: string[],
): ProviderChoice {
  const warnings: string[] = [];
  const ok = (id: string | undefined, where: string) => {
    if (!id) return false;
    if (available.includes(id)) return true;
    warnings.push(`${where} names the e-signature connection “${id}”, which isn’t set up`);
    return false;
  };
  const done = (id: string, from: ProviderChoice['from']): ProviderChoice => ({ id, from, ...(warnings.length ? { warning: `${warnings.join('; ')}. Using ${id} instead.` } : {}) });
  if (ok(firm?.signingProviderId, `The ${firm?.name || 'firm'} profile`)) return done(firm!.signingProviderId!, 'firm');
  const group = user ? groups.find((g) => g.memberIds.includes(user.systemuserid) && !!g.signingProviderId) : undefined;
  if (group && ok(group.signingProviderId, `The ${group.name} group`)) return done(group.signingProviderId!, 'group');
  if (ok(settings?.defaultProviderId, 'The firm default')) return done(settings!.defaultProviderId!, 'default');
  return done(available[0] ?? DOCUSIGN_MAIN, 'fallback');
}

/** The verification methods a provider offers, keeping the one already chosen so the Send screen can say it's not available. */
export function verificationChoices(caps: Pick<ProviderCapabilities, 'verification'>, current?: VerificationMethod): VerificationMethod[] {
  return current && !caps.verification.includes(current) ? [...caps.verification, current] : caps.verification;
}

/** A signer's default verification on this provider: theirs if it's offered, else SMS, else the first offered. */
export function defaultVerification(caps: Pick<ProviderCapabilities, 'verification'>, preferred: VerificationMethod | undefined): VerificationMethod {
  if (preferred && caps.verification.includes(preferred)) return preferred;
  if (caps.verification.includes('sms')) return 'sms';
  return caps.verification[0] ?? 'email';
}

/** The firm's limits on supporting documents, lowered to the provider's when it takes less. */
export function providerAttachmentLimits(limits: { maxFiles: number; maxMB: number }, caps: Pick<ProviderCapabilities, 'maxAttachmentsMb'>): { maxFiles: number; maxMB: number } {
  return caps.maxAttachmentsMb && caps.maxAttachmentsMb < limits.maxMB ? { ...limits, maxMB: caps.maxAttachmentsMb } : limits;
}
