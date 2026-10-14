import type { DateLayout, FieldFormat, FieldLimits } from './types';

const digits = (s: string) => s.replace(/\D/g, '');
const pad = (n: number) => String(n).padStart(2, '0');

/** Read an ISO (YYYY-MM-DD) or US (M/D/YYYY) date. Undefined when it isn't a real calendar date. */
export function parseDate(v: string): { y: number; m: number; d: number } | undefined {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v.trim());
  if (!iso && !us) return undefined;
  const [y, m, d] = iso ? [+iso[1], +iso[2], +iso[3]] : [+us![3], +us![1], +us![2]];
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? { y, m, d } : undefined;
}

const isoOf = (p: { y: number; m: number; d: number }) => `${p.y}-${pad(p.m)}-${pad(p.d)}`;
const localIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * A date limit as an ISO date: an ISO date as is, or relative to `today`
 * (`today`, `-120y`, `+1y`, `-6m`, `+30d`). Undefined when the limit can't be read.
 */
export function resolveDateLimit(spec: string | undefined, today: Date = new Date()): string | undefined {
  if (!spec) return undefined;
  const s = spec.trim();
  if (s === 'today') return localIso(today);
  const rel = /^([+-]\d+)([dmy])$/.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (rel[2] === 'd') d.setDate(d.getDate() + n);
    else if (rel[2] === 'm') d.setMonth(d.getMonth() + n);
    else d.setFullYear(d.getFullYear() + n);
    return localIso(d);
  }
  const p = parseDate(s);
  return p ? isoOf(p) : undefined;
}

function layoutDate(p: { y: number; m: number; d: number }, layout: DateLayout = 'MM/DD/YYYY'): string {
  switch (layout) {
    case 'YYYY-MM-DD':
      return isoOf(p);
    case 'MMDDYYYY':
      return `${pad(p.m)}${pad(p.d)}${p.y}`;
    case 'DD/MM/YYYY':
      return `${pad(p.d)}/${pad(p.m)}/${p.y}`;
    default:
      return `${pad(p.m)}/${pad(p.d)}/${p.y}`;
  }
}

/** An SSN-or-TIN prints as an EIN (12-3456789) when that's how it was typed, otherwise as an SSN. */
const looksLikeEin = (v: string) => /^\s*\d{2}[-\s]\d{7}\s*$/.test(v);

const toNum = (v: string) => Number(v.replace(/[$,%\s]/g, ''));

/** Normalise a raw value into the form it should appear on the PDF. */
export function formatValue(raw: string | undefined, format: FieldFormat | undefined, limits?: FieldLimits): string {
  if (raw === undefined || raw === null) return '';
  const v = String(raw).trim();
  if (!v) return '';
  switch (format) {
    case 'date': {
      const p = parseDate(v);
      return p ? layoutDate(p, limits?.dateLayout) : v;
    }
    case 'ssn': {
      const d = digits(v);
      return d.length === 9 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : v;
    }
    case 'ein': {
      const d = digits(v);
      return d.length === 9 ? `${d.slice(0, 2)}-${d.slice(2)}` : v;
    }
    case 'ssnOrTin': {
      const d = digits(v);
      if (d.length !== 9) return v;
      return looksLikeEin(v) ? `${d.slice(0, 2)}-${d.slice(2)}` : `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
    }
    case 'ssnLast4':
      return digits(v).slice(-4);
    case 'phone': {
      const d = digits(v).replace(/^1(?=\d{10}$)/, '');
      return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : v;
    }
    case 'zip': {
      const d = digits(v);
      return d.length === 9 ? `${d.slice(0, 5)}-${d.slice(5)}` : v;
    }
    case 'currency': {
      const n = toNum(v);
      return Number.isFinite(n) ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : v;
    }
    case 'percent': {
      const n = toNum(v);
      return Number.isFinite(n) ? `${n}%` : v;
    }
    case 'integer': {
      const n = toNum(v);
      return Number.isInteger(n) ? String(n) : v;
    }
    case 'decimal': {
      const n = toNum(v);
      return Number.isFinite(n) ? String(n) : v;
    }
    case 'checkbox':
      return isTruthy(v) ? 'Yes' : 'No';
    default:
      return v;
  }
}

export function isTruthy(v: string | undefined): boolean {
  return !!v && /^(true|yes|y|x|on|1|checked)$/i.test(v.trim());
}

const usDate = (iso: string) => layoutDate(parseDate(iso)!);
const fmtNum = (n: number, format: FieldFormat) => (format === 'currency' ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : format === 'percent' ? `${n}%` : String(n));

/** "between 1 and 10", "at least 1", "up to 10", for messages. */
function rangeText(min: number | undefined, max: number | undefined, format: FieldFormat): string {
  if (min !== undefined && max !== undefined) return `from ${fmtNum(min, format)} to ${fmtNum(max, format)}`;
  if (min !== undefined) return `of at least ${fmtNum(min, format)}`;
  return `of at most ${fmtNum(max!, format)}`;
}

function checkRange(n: number, min: number | undefined, max: number | undefined, noun: string, format: FieldFormat): string | undefined {
  if ((min !== undefined && n < min) || (max !== undefined && n > max)) return `Enter ${noun} ${rangeText(min, max, format)}.`;
  return undefined;
}

/**
 * Returns a message when a value doesn't fit its format or limits, or undefined when
 * it's fine (or empty). Pass `today` to pin relative date limits (tests, prefill scope).
 */
export function validateFormat(raw: string | undefined, format: FieldFormat | undefined, limits?: FieldLimits, today?: Date): string | undefined {
  const v = (raw ?? '').trim();
  if (!v) return undefined;
  const shape = shapeError(v, format, limits, today);
  if (shape) return shape;
  // Length is measured on what prints, so a box's MaxLen catches a long formatted value too.
  if (limits?.maxLength || limits?.minLength) {
    const printed = format === 'checkbox' ? v : formatValue(v, format, limits);
    if (limits.maxLength && printed.length > limits.maxLength) return `Up to ${limits.maxLength} characters (this is ${printed.length}).`;
    if (limits.minLength && printed.length < limits.minLength) return `At least ${limits.minLength} characters.`;
  }
  return undefined;
}

function shapeError(v: string, format: FieldFormat | undefined, limits: FieldLimits | undefined, today?: Date): string | undefined {
  switch (format) {
    case undefined:
    case 'text':
    case 'checkbox':
      return undefined;
    case 'date': {
      const p = parseDate(v);
      if (!p) return 'Use a real date, like 04/18/1971.';
      const iso = isoOf(p);
      const min = resolveDateLimit(limits?.dateMin, today);
      const max = resolveDateLimit(limits?.dateMax, today);
      const describe = (spec: string, resolved: string) => (spec.trim() === 'today' ? 'today' : usDate(resolved));
      if (min && max && (iso < min || iso > max)) return `Enter a date from ${describe(limits!.dateMin!, min)} to ${describe(limits!.dateMax!, max)}.`;
      if (min && iso < min) return `Enter a date on or after ${describe(limits!.dateMin!, min)}.`;
      if (max && iso > max) return `Enter a date on or before ${describe(limits!.dateMax!, max)}.`;
      return undefined;
    }
    case 'ssn':
      return digits(v).length === 9 && /^[\d\s-]+$/.test(v) ? undefined : 'A Social Security number has 9 digits.';
    case 'ein':
      return /^\d{2}-?\d{7}$/.test(v) ? undefined : 'Enter an EIN like 12-3456789.';
    case 'ssnOrTin':
      return /^(\d{3}-?\d{2}-?\d{4}|\d{2}-\d{7})$/.test(v) ? undefined : 'Enter an SSN (123-45-6789) or EIN (12-3456789).';
    case 'ssnLast4':
      return digits(v).length === 4 ? undefined : 'Enter the last 4 digits.';
    case 'phone':
      return digits(v).replace(/^1(?=\d{10}$)/, '').length === 10 ? undefined : 'Enter a 10-digit phone number.';
    case 'zip':
      return /^\d{5}(-?\d{4})?$/.test(v) ? undefined : 'ZIP codes are 5 or 9 digits.';
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? undefined : 'That doesn’t look like an email address.';
    case 'currency': {
      const n = toNum(v);
      if (!Number.isFinite(n)) return 'Enter a dollar amount.';
      return checkRange(n, limits?.min, limits?.max, 'an amount', format);
    }
    case 'percent': {
      const n = toNum(v);
      const min = limits?.min ?? 0;
      const max = limits?.max ?? 100;
      if (!Number.isFinite(n)) return `Enter a percentage ${rangeText(min, max, format)}.`;
      return checkRange(n, min, max, 'a percentage', format);
    }
    case 'integer': {
      // Plain digits, or digits grouped in thousands (1,200), never a stray comma.
      if (!/^-?(\d{1,3}(,\d{3})+|\d+)$/.test(v)) return 'Enter a whole number.';
      return checkRange(toNum(v), limits?.min, limits?.max, 'a whole number', format);
    }
    case 'decimal': {
      const n = toNum(v);
      if (!/^-?[\d,]*\.?\d+$/.test(v.replace(/\s/g, '')) || !Number.isFinite(n)) return 'Enter a number.';
      return checkRange(n, limits?.min, limits?.max, 'a number', format);
    }
  }
}

/** Mask sensitive values for on-screen display (the PDF still gets the full value). */
export function maskValue(v: string, format: FieldFormat | undefined): string {
  if (format === 'ssn' || (format === 'ssnOrTin' && !looksLikeEin(v))) {
    const d = digits(v);
    return d.length >= 4 ? `•••-••-${d.slice(-4)}` : v;
  }
  return v;
}

export function prettifyFieldName(name: string): string {
  return name
    .replace(/[_.]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

export function toNumber(v: string | undefined): number {
  if (!v) return 0;
  const n = Number(String(v).replace(/[$,%\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------- Envelope email templates

/** What envelope subject and message tokens can read. */
export interface MessageContext {
  /** The D365 contact: `{client.<column>}`. */
  client: object;
  /** The acting advisor's profile: `{advisor.<field>}`. */
  advisor: { fullname?: string; phone?: string; emailSignature?: string };
  /** The firm profile: `{firm.<field>}`. */
  firm?: object;
  /** Form names in the packet, in order. */
  forms: string[];
}

/** "a", "a and b", "a, b and more". */
export function listForms(names: string[]): string {
  return names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and more`;
}

/**
 * Fill `{client.firstname}`, `{advisor.fullname}`, `{firm.name}`, `{forms}`,
 * `{formCount}` and `{advisor.signature}` (the advisor's email signature, else their
 * name and phone). Unknown or empty tokens become empty strings, so a missing CRM value
 * never prints "{client.middlename}".
 */
export function fillTokens(text: string, ctx: MessageContext): string {
  return text.replace(/\{\s*([a-zA-Z]+)(?:\.([a-zA-Z0-9_]+))?\s*\}/g, (_m, root: string, attr?: string) => {
    const read = (o: object | undefined) => {
      const v = attr && o ? (o as Record<string, unknown>)[attr] : undefined;
      return v === undefined || v === null || typeof v === 'object' ? '' : String(v);
    };
    switch (root) {
      case 'forms':
        return attr ? '' : listForms(ctx.forms.map((f) => f.toLowerCase()));
      case 'formCount':
        return attr ? '' : String(ctx.forms.length);
      case 'client':
        return read(ctx.client);
      case 'advisor':
        if (attr === 'signature') return ctx.advisor.emailSignature || [ctx.advisor.fullname, ctx.advisor.phone].filter(Boolean).join('\n');
        return read(ctx.advisor);
      case 'firm':
        return read(ctx.firm);
      default:
        return '';
    }
  });
}

/** DocuSign's limit on an envelope's email subject. */
export const SUBJECT_MAX = 100;

/** The email subject from a template: tokens filled, whitespace tidied, cut to DocuSign's 100 characters. */
export const fillSubject = (template: string, ctx: MessageContext) =>
  fillTokens(template, ctx)
    .replace(/\s+/g, ' ')
    // An empty token can leave "Priya : forms"; close the gap before punctuation.
    .replace(/ ([,.:;!?])/g, '$1')
    .trim()
    .slice(0, SUBJECT_MAX);
