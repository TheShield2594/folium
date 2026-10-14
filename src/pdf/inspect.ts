import { PDFCheckBox, PDFDict, PDFDocument, PDFDropdown, PDFName, PDFRadioGroup, PDFTextField, type PDFField } from 'pdf-lib';
import type { FieldRect, PdfKind } from '../domain/types';

export interface InspectedField {
  name: string;
  type: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'other';
  rects: FieldRect[];
  /** The text field's MaxLen, when the PDF sets one. */
  maxLength?: number;
  /** Export values: each option of a radio group or dropdown, or a checkbox's "on" value. */
  options?: string[];
}

export interface PdfInspection {
  kind: PdfKind;
  pageCount: number;
  pages: { width: number; height: number }[];
  fields: InspectedField[];
}

function optionsOf(f: PDFField): string[] | undefined {
  if (f instanceof PDFRadioGroup || f instanceof PDFDropdown) return f.getOptions();
  if (f instanceof PDFCheckBox) {
    // The "on" appearance name of the first widget, e.g. /Yes or /Married.
    const on = f.acroField.getWidgets()[0]?.getOnValue();
    return on ? [on.decodeText()] : undefined;
  }
  return undefined;
}

function typeOf(f: PDFField): InspectedField['type'] {
  if (f instanceof PDFTextField) return 'text';
  if (f instanceof PDFCheckBox) return 'checkbox';
  if (f instanceof PDFRadioGroup) return 'radio';
  if (f instanceof PDFDropdown) return 'dropdown';
  return 'other';
}

/**
 * Read a template's AcroForm fields and where their widgets sit on each page, in
 * top-left page coordinates. Also classifies the PDF (fillable / XFA / flat), which
 * is the brief's spike #3 — run it against Marketing's real PDFs.
 */
export async function inspectPdf(bytes: Uint8Array): Promise<PdfInspection> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = doc.getPages();

  // Widget dict → page index, via each page's /Annots array.
  const widgetPage = new Map<PDFDict, number>();
  pages.forEach((p, i) => {
    const annots = p.node.Annots();
    if (!annots) return;
    for (let j = 0; j < annots.size(); j++) {
      const d = annots.lookup(j);
      if (d instanceof PDFDict) widgetPage.set(d, i);
    }
  });

  const form = doc.getForm();
  const isXfa = !!form.acroForm.dict.lookup(PDFName.of('XFA'));
  const fields: InspectedField[] = form.getFields().map((f) => ({
    name: f.getName(),
    type: typeOf(f),
    maxLength: f instanceof PDFTextField ? f.getMaxLength() || undefined : undefined,
    options: optionsOf(f),
    rects: f.acroField.getWidgets().map((w): FieldRect => {
      const r = w.getRectangle();
      const idx = widgetPage.get(w.dict) ?? 0;
      return { page: idx + 1, x: r.x, y: pages[idx].getHeight() - r.y - r.height, width: r.width, height: r.height };
    }),
  }));

  return {
    kind: isXfa ? 'xfa' : fields.length ? 'fillable' : 'flat',
    pageCount: pages.length,
    pages: pages.map((p) => ({ width: p.getWidth(), height: p.getHeight() })),
    fields,
  };
}
