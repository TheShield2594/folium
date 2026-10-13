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
      return { ...base, name: c.fullname, email: c.emailaddress1 ?? '', phone: c.mobilephone, contactId: c.contactid, auth: c.mobilephone ? defaultAuth : 'email' };
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
    const prior = emails.get(s.email.toLowerCase());
    if (s.email && prior && prior !== s.name) problems.push({ role: s.role, message: `${s.name} and ${prior} share an email. DocuSign needs each signer to have their own.` });
    if (s.email) emails.set(s.email.toLowerCase(), s.name);
  }
  return problems;
}
