import type { FieldFormat, FieldRect, Placement } from '../domain/types';

// A small layout language for the demo form templates. In production the PDFs come
// from Marketing's SharePoint library; these specs exist so the demo (and the tests)
// have real AcroForm PDFs to prefill, render and send.

export interface SpecField {
  name: string;
  label: string;
  /** Longer label for Folium's UI when the printed label relies on its section for context. */
  uiLabel?: string;
  /** Width in twelfths of the content area. */
  span: number;
  source: string;
  required?: boolean;
  requiredWhen?: string;
  format?: FieldFormat;
  key?: string;
  help?: string;
  type?: 'text' | 'checkbox';
}

export interface SpecSection {
  title: string;
  note?: string;
  fields?: SpecField[];
  signatures?: { role: string; label: string; optional?: boolean }[];
}

export const PAGE_W = 612;
export const PAGE_H = 792;
export const MARGIN = 48;
const CONTENT_W = PAGE_W - MARGIN * 2;
const GAP = 10;
const ROW_H = 34;
const FIELD_H = 16;
const SECTION_H = 26;
const NOTE_H = 14;
const SIG_ROW_H = 54;
const HEADER_H = 78;
const FOOTER = 52;

export interface LaidOutField {
  field: SpecField;
  rect: FieldRect; // top-left origin
  labelAt: { page: number; x: number; y: number };
}

export interface LaidOutSection {
  section: SpecSection;
  page: number;
  y: number;
}

export interface Layout {
  pageCount: number;
  sections: LaidOutSection[];
  fields: LaidOutField[];
  placements: Placement[];
  signatureLines: { role: string; label: string; page: number; x: number; y: number; width: number }[];
  notes: { text: string; page: number; x: number; y: number }[];
}

export function layoutSpec(sections: SpecSection[]): Layout {
  let page = 1;
  let y = MARGIN + HEADER_H;
  const out: Layout = { pageCount: 1, sections: [], fields: [], placements: [], signatureLines: [], notes: [] };

  const ensure = (h: number) => {
    if (y + h > PAGE_H - FOOTER) {
      page += 1;
      y = MARGIN + 28;
    }
  };

  for (const section of sections) {
    ensure(SECTION_H + ROW_H);
    out.sections.push({ section, page, y });
    y += SECTION_H;
    if (section.note) {
      out.notes.push({ text: section.note, page, x: MARGIN, y });
      y += NOTE_H;
    }

    let col = 0;
    for (const field of section.fields ?? []) {
      const span = Math.min(12, Math.max(1, field.span));
      if (col + span > 12) {
        col = 0;
        y += ROW_H;
      }
      ensure(ROW_H);
      const unit = (CONTENT_W - GAP * 11) / 12;
      const x = MARGIN + col * (unit + GAP);
      const w = span * unit + (span - 1) * GAP;
      const isCheck = field.type === 'checkbox';
      out.fields.push({
        field,
        labelAt: { page, x: isCheck ? x + 16 : x, y: isCheck ? y + 14 : y + 8 },
        rect: isCheck ? { page, x, y: y + 4, width: 12, height: 12 } : { page, x, y: y + 12, width: w, height: FIELD_H },
      });
      col += span;
    }
    if ((section.fields ?? []).length) y += ROW_H + 4;

    if (section.signatures?.length) {
      for (const sig of section.signatures) {
        ensure(SIG_ROW_H);
        const sigW = CONTENT_W * 0.62;
        out.signatureLines.push({ role: sig.role, label: sig.label, page, x: MARGIN, y: y + 34, width: sigW });
        out.signatureLines.push({ role: sig.role, label: 'Date', page, x: MARGIN + sigW + 24, y: y + 34, width: CONTENT_W - sigW - 24 });
        out.placements.push({ role: sig.role, type: 'signature', page, x: MARGIN + 4, y: y + 6, optional: sig.optional });
        out.placements.push({ role: sig.role, type: 'dateSigned', page, x: MARGIN + sigW + 28, y: y + 20, optional: sig.optional });
        y += SIG_ROW_H;
      }
    }
    y += 6;
  }
  out.pageCount = page;
  return out;
}
