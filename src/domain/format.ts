import type { FieldFormat } from './types';

const digits = (s: string) => s.replace(/\D/g, '');

/** Normalise a raw value into the form it should appear on the PDF. */
export function formatValue(raw: string | undefined, format: FieldFormat | undefined): string {
  if (raw === undefined || raw === null) return '';
  const v = String(raw).trim();
  if (!v) return '';
  switch (format) {
    case 'date': {
      const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
      return iso ? `${iso[2]}/${iso[3]}/${iso[1]}` : v;
    }
    case 'ssn': {
      const d = digits(v);
      return d.length === 9 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : v;
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
      const n = Number(v.replace(/[$,\s]/g, ''));
      return Number.isFinite(n) ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : v;
    }
    case 'percent': {
      const n = Number(v.replace(/[%\s]/g, ''));
      return Number.isFinite(n) ? `${n}%` : v;
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

/** Returns a message when a value doesn't fit its format, or undefined when it's fine (or empty). */
export function validateFormat(raw: string | undefined, format: FieldFormat | undefined): string | undefined {
  const v = (raw ?? '').trim();
  if (!v || !format) return undefined;
  switch (format) {
    case 'date': {
      const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
      const [y, m, d] = iso ? [+iso[1], +iso[2], +iso[3]] : us ? [+us[3], +us[1], +us[2]] : [NaN, NaN, NaN];
      const dt = new Date(y, m - 1, d);
      return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? undefined : 'Use a real date, like 04/18/1971.';
    }
    case 'ssn':
      return digits(v).length === 9 ? undefined : 'A Social Security number has 9 digits.';
    case 'ssnLast4':
      return digits(v).length === 4 ? undefined : 'Enter the last 4 digits.';
    case 'phone':
      return digits(v).replace(/^1(?=\d{10}$)/, '').length === 10 ? undefined : 'Enter a 10-digit phone number.';
    case 'zip':
      return /^\d{5}(-?\d{4})?$/.test(v) ? undefined : 'ZIP codes are 5 or 9 digits.';
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? undefined : 'That doesn’t look like an email address.';
    case 'currency':
      return Number.isFinite(Number(v.replace(/[$,\s]/g, ''))) ? undefined : 'Enter a dollar amount.';
    case 'percent': {
      const n = Number(v.replace(/[%\s]/g, ''));
      return Number.isFinite(n) && n >= 0 && n <= 100 ? undefined : 'Enter a percentage from 0 to 100.';
    }
    default:
      return undefined;
  }
}

/** Mask sensitive values for on-screen display (the PDF still gets the full value). */
export function maskValue(v: string, format: FieldFormat | undefined): string {
  if (format === 'ssn') {
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
