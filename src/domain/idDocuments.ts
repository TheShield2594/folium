import type { ClientRecord, Contact, FieldFormat } from './types';

// ID documents many account forms ask for: driver's licence, passport, green card and
// citizenship, for the client and the spouse. Sources read `id.<who>.<attr>`
// (`id.client.dlNumber`, `id.spouse.passportExpires`).
//
// Whether Dynamics 365 holds these is still to be confirmed with Everence. The power
// service copies whichever contact columns ID_DOCUMENT_COLUMNS (power/config.ts) names
// into `Contact.idDocuments`; until any are named, every ID field is empty from CRM and
// the advisor enters it at review. The value is keyed by its source, so it's entered
// once per packet and fills every form that asks for it.

export type IdAttr =
  | 'dlNumber'
  | 'dlState'
  | 'dlIssued'
  | 'dlExpires'
  | 'passportNumber'
  | 'passportCountry'
  | 'passportExpires'
  | 'greenCardNumber'
  | 'greenCardExpires'
  | 'citizenship';

export const ID_FIELDS: { attr: IdAttr; label: string; format?: FieldFormat; sensitive?: boolean }[] = [
  { attr: 'dlNumber', label: 'Driver’s licence number', sensitive: true },
  { attr: 'dlState', label: 'Driver’s licence state' },
  { attr: 'dlIssued', label: 'Driver’s licence issued', format: 'date' },
  { attr: 'dlExpires', label: 'Driver’s licence expires', format: 'date' },
  { attr: 'passportNumber', label: 'Passport number', sensitive: true },
  { attr: 'passportCountry', label: 'Passport country' },
  { attr: 'passportExpires', label: 'Passport expires', format: 'date' },
  { attr: 'greenCardNumber', label: 'Green card number', sensitive: true },
  { attr: 'greenCardExpires', label: 'Green card expires', format: 'date' },
  { attr: 'citizenship', label: 'Citizenship' },
];

/** Whose ID: the client, or the person connected as Spouse. */
export const ID_PEOPLE = [
  { who: 'client', label: 'Client' },
  { who: 'spouse', label: 'Spouse' },
] as const;
export type IdPerson = (typeof ID_PEOPLE)[number]['who'];

const ID_RE = /^id\.(client|spouse)\.([A-Za-z]+)$/;

/** `id.client.dlNumber` → its person and field, or undefined for any other source. */
export function parseIdSource(source: string): { who: IdPerson; field: (typeof ID_FIELDS)[number] } | undefined {
  const m = ID_RE.exec(source);
  const field = m && ID_FIELDS.find((f) => f.attr === m[2]);
  return m && field ? { who: m[1] as IdPerson, field } : undefined;
}

/** Whether a value key holds an ID document number (kept out of the local journal, like SSNs). */
export const isIdNumberKey = (key: string) => !!parseIdSource(key)?.field.sensitive;

/** The contact an ID source is about. */
const personFor = (client: ClientRecord, who: IdPerson): Contact | undefined =>
  who === 'client' ? client.contact : client.connections.find((c) => c.role.toLowerCase() === 'spouse')?.contact;

/** An ID document value from CRM, when Dynamics holds it. */
export function resolveIdSource(source: string, client: ClientRecord): string | undefined {
  const id = parseIdSource(source);
  if (!id) return undefined;
  const v = personFor(client, id.who)?.idDocuments?.[id.field.attr];
  return v ? String(v) : undefined;
}

/** Fill-from choices for the mapping editor: every ID field, for each person. */
export const ID_SOURCE_OPTIONS: [string, string][] = ID_PEOPLE.flatMap((p) => ID_FIELDS.map((f): [string, string] => [`id.${p.who}.${f.attr}`, `${p.label} · ${f.label}`]));

/**
 * Copy the contact columns that hold ID documents into `idDocuments`. `columns` maps
 * each field to its Dataverse column; fields with no column stay absent.
 */
export function readIdDocuments(row: Record<string, unknown>, columns: Partial<Record<IdAttr, string>>): Partial<Record<IdAttr, string>> | undefined {
  const out: Partial<Record<IdAttr, string>> = {};
  for (const [attr, col] of Object.entries(columns) as [IdAttr, string][]) {
    const v = row[col];
    if (v !== undefined && v !== null && v !== '') out[attr] = String(v).slice(0, attr.endsWith('Issued') || attr.endsWith('Expires') ? 10 : undefined);
  }
  return Object.keys(out).length ? out : undefined;
}
