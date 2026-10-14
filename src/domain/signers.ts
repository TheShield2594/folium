import { evaluateCondition, type ResolveScope } from './paths';
import type { FormTemplate, SignerAssignment, VerificationMethod } from './types';

export interface RoleNeed {
  role: string;
  /** Templates (by id) that need this role's signature. */
  templateIds: string[];
}

/** Every signer role the packet needs, honouring per-template conditions (e.g. spousal consent only if married). */
export function rolesForPacket(templates: FormTemplate[], scope: Omit<ResolveScope, 'account'>): RoleNeed[] {
  const map = new Map<string, string[]>();
  for (const t of templates) {
    for (const rule of t.mapping.signers) {
      if (!evaluateCondition(rule.condition, scope)) continue;
      const list = map.get(rule.role) ?? [];
      if (!list.includes(t.id)) list.push(t.id);
      map.set(rule.role, list);
    }
  }
  return [...map.entries()].map(([role, templateIds]) => ({ role, templateIds }));
}

/** Which CRM connection a template role usually maps to. */
const ROLE_TO_CONNECTION: Record<string, string> = {
  JointOwner: 'Joint owner',
  Joint: 'Joint owner',
  SpouseConsent: 'Spouse',
  Spouse: 'Spouse',
  Insured: 'Insured',
  TrustedContact: 'Trusted contact',
};

export const ROLE_LABELS: Record<string, string> = {
  Owner: 'Owner',
  JointOwner: 'Joint owner',
  Joint: 'Joint owner',
  SpouseConsent: 'Spousal consent',
  Spouse: 'Spouse',
  Insured: 'Insured',
  Advisor: 'Advisor',
  TrustedContact: 'Trusted contact',
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role.replace(/([a-z])([A-Z])/g, '$1 $2');
}

/** Build signer rows from roles, pulling names and contact details from CRM. */
export function assignSigners(
  needs: RoleNeed[],
  scope: Omit<ResolveScope, 'account'>,
  defaultAuth: VerificationMethod,
): SignerAssignment[] {
  const order = ['Owner', 'JointOwner', 'Joint', 'Insured', 'SpouseConsent', 'Spouse', 'TrustedContact', 'Advisor'];
  const sorted = [...needs].sort((a, b) => rank(a.role) - rank(b.role));
  function rank(r: string) {
    const i = order.indexOf(r);
    return i === -1 ? order.length : i;
  }

  return sorted.map((need, i): SignerAssignment => {
    const base = { role: need.role, order: i + 1, status: 'pending' as const };
    if (need.role === 'Owner') {
      const c = scope.client.contact;
      // Phone authentication can call a landline, so it falls back to the main number.
      const phone = c.mobilephone || (defaultAuth === 'phone' ? c.telephone1 : undefined);
      return { ...base, name: c.fullname, email: c.emailaddress1 ?? '', phone, contactId: c.contactid, auth: phone ? defaultAuth : 'email' };
    }
    if (need.role === 'Advisor') {
      return { ...base, name: scope.advisor.fullname, email: scope.advisor.email, phone: scope.advisor.phone, auth: 'email' };
    }
    const connRole = ROLE_TO_CONNECTION[need.role];
    const conn = connRole ? scope.client.connections.find((c) => c.role === connRole) : undefined;
    if (conn) {
      return { ...base, name: conn.contact.fullname, email: conn.contact.emailaddress1 ?? '', phone: conn.contact.mobilephone, contactId: conn.contact.contactid, auth: 'email' };
    }
    return { ...base, name: '', email: '', auth: 'email' };
  });
}

export interface SignerProblem {
  role: string;
  message: string;
}

export function validateSigners(signers: SignerAssignment[]): SignerProblem[] {
  const problems: SignerProblem[] = [];
  const emails = new Map<string, string>();
  for (const s of signers) {
    if (!s.name.trim()) problems.push({ role: s.role, message: `${roleLabel(s.role)} needs a name.` });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email)) problems.push({ role: s.role, message: `${roleLabel(s.role)} needs a valid email.` });
    if (s.auth === 'sms' && (s.phone ?? '').replace(/\D/g, '').length < 10) problems.push({ role: s.role, message: `${roleLabel(s.role)} needs a mobile number for SMS verification.` });
    if (s.auth === 'phone' && (s.phone ?? '').replace(/\D/g, '').length < 10) problems.push({ role: s.role, message: `${roleLabel(s.role)} needs a 10-digit phone number for phone authentication.` });
    const prior = emails.get(s.email.toLowerCase());
    // The same person in two roles is fine: the envelope merges them into one recipient.
    // Two different people on one address is not — DocuSign can't tell who signed.
    if (s.email && prior && prior.trim().toLowerCase() !== s.name.trim().toLowerCase())
      problems.push({ role: s.role, message: `${s.name} and ${prior} share an email. Each person needs their own to sign.` });
    if (s.email) emails.set(s.email.toLowerCase(), s.name);
  }
  return problems;
}

// ---------------------------------------------------------------- Access codes

/** Six random digits for a signer's DocuSign access code. */
export function generateAccessCode(random: (n: number) => number = cryptoInt): string {
  return Array.from({ length: 6 }, () => String(random(10))).join('');
}

function cryptoInt(n: number): number {
  const buf = new Uint32Array(1);
  // Reject the top of the range so every digit is equally likely.
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % n;
}

const personKey = (s: Pick<SignerAssignment, 'name' | 'email'>) => `${s.name.trim().toLowerCase()}|${s.email.trim().toLowerCase()}`;

/**
 * The signers as DocuSign gets them: with each one's access code, which exists only
 * here and in the envelope. Codes are keyed by role.
 */
export function envelopeSigners(signers: SignerAssignment[], codes: Record<string, string>): (SignerAssignment & { accessCode?: string })[] {
  return signers.map((s) => (codes[s.role]?.trim() ? { ...s, accessCode: codes[s.role].trim() } : s));
}

/**
 * The signers as the request saves them: `accessCodeSet`, never the code, and who
 * DocuSign has sent to first (in-session signers don't wait their turn).
 */
export function recordedSigners(signers: SignerAssignment[], codes: Record<string, string>): SignerAssignment[] {
  const first = Math.min(...signers.map((x) => x.order));
  return signers.map((s) => {
    const { accessCode: _drop, ...rest } = s as SignerAssignment & { accessCode?: string };
    return { ...rest, accessCodeSet: codes[s.role]?.trim() ? true : undefined, status: s.order === first || s.inSession ? 'sent' : 'pending' };
  });
}

/** One person holding two roles gets one DocuSign recipient, so one code: warn when their roles set different ones. */
export function accessCodeWarnings(signers: SignerAssignment[], codes: Record<string, string>): SignerProblem[] {
  const byPerson = new Map<string, SignerAssignment[]>();
  for (const s of signers) byPerson.set(personKey(s), [...(byPerson.get(personKey(s)) ?? []), s]);
  const out: SignerProblem[] = [];
  for (const roles of byPerson.values()) {
    const set = roles.filter((r) => codes[r.role]?.trim());
    if (new Set(set.map((r) => codes[r.role].trim())).size > 1) {
      out.push({ role: set[1].role, message: `${set[0].name} signs as ${set.map((r) => roleLabel(r.role)).join(' and ')} with different access codes. DocuSign uses the ${roleLabel(set[0].role)} code.` });
    }
  }
  return out;
}
