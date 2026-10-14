import { PDFCheckBox, PDFDocument, PDFDropdown, PDFRadioGroup, PDFTextField, StandardFonts, rgb } from 'pdf-lib';
import { isTruthy } from '../domain/format';
import type { FieldState } from '../domain/prefill';
import type { PdfKind } from '../domain/types';

export interface FillOptions {
  kind: PdfKind;
  /** Flatten so the client can't change prefilled values (signer fields stay open in DocuSign as tabs). */
  flatten?: boolean;
  /** Stamp a light "DRAFT" mark, used for in-progress downloads. */
  draftMark?: boolean;
}

export interface FillReport {
  pdf: Uint8Array;
  /** Mapped fields the PDF didn't have (a sign the mapping is stale). */
  unknownFields: string[];
  /**
   * Fields whose value was longer than the PDF's MaxLen and had to be cut. Review
   * blocks these when the mapping carries `limits.maxLength`; this catches mappings
   * that don't yet.
   */
  truncated: string[];
}

/** Fill a template PDF with prefill values, entirely in the browser (pdf-lib). */
export async function fillPdf(template: Uint8Array, fields: FieldState[], opts: FillOptions): Promise<FillReport> {
  const doc = await PDFDocument.load(template, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const unknownFields: string[] = [];
  const truncated: string[] = [];
  const pages = doc.getPages();

  // Locked fields print blank: whatever the advisor typed stays in the packet, not on the form.
  const toFill = fields.filter((f) => f.origin !== 'signer' && !f.locked && f.value !== '');
  const locked = fields.filter((f) => f.locked);

  if (opts.kind === 'fillable') {
    const form = doc.getForm();
    for (const f of toFill) {
      const field = form.getFieldMaybe(f.mapping.pdfField);
      if (!field) {
        unknownFields.push(f.mapping.pdfField);
        continue;
      }
      if (field instanceof PDFTextField) {
        const max = field.getMaxLength();
        if (max && f.display.length > max) truncated.push(f.mapping.pdfField);
        // pdf-lib throws past MaxLen, so cut it; the report says which fields lost text.
        field.setText(max ? f.display.slice(0, max) : f.display);
      } else if (field instanceof PDFCheckBox) {
        if (isTruthy(f.value)) field.check();
        else field.uncheck();
      } else if (field instanceof PDFDropdown) {
        const opt = field.getOptions().find((o) => o.toLowerCase() === f.display.toLowerCase());
        if (opt) field.select(opt);
      } else if (field instanceof PDFRadioGroup) {
        const opt = field.getOptions().find((o) => o.toLowerCase() === f.display.toLowerCase());
        if (opt) field.select(opt);
      }
    }
    // Keep the lock in the editable PDF: blank and read-only.
    for (const f of locked) {
      const field = form.getFieldMaybe(f.mapping.pdfField);
      if (!field) continue;
      if (field instanceof PDFTextField) field.setText('');
      else if (field instanceof PDFCheckBox) field.uncheck();
      else if (field instanceof PDFDropdown) field.clear();
      else if (field instanceof PDFRadioGroup) field.clear();
      field.enableReadOnly();
    }
    form.updateFieldAppearances(font);
    if (opts.flatten) form.flatten({ updateFieldAppearances: false });
  } else {
    // Flat or XFA: draw values as overlay text at the mapped boxes.
    for (const f of toFill) {
      const r = f.mapping.rect;
      if (!r) {
        unknownFields.push(f.mapping.pdfField);
        continue;
      }
      const page = pages[r.page - 1];
      if (!page) continue;
      const text = f.mapping.format === 'checkbox' ? (isTruthy(f.value) ? 'X' : '') : f.display;
      if (!text) continue;
      let size = Math.min(10, r.height - 3);
      while (size > 5 && font.widthOfTextAtSize(text, size) > r.width - 4) size -= 0.5;
      page.drawText(text, { x: r.x + 2, y: page.getHeight() - r.y - r.height + (r.height - size) / 2 + 1, size, font, color: rgb(0.05, 0.1, 0.2) });
    }
  }

  if (opts.draftMark) {
    for (const page of pages) {
      page.drawText('DRAFT — NOT FOR SIGNATURE', { x: 48, y: 14, size: 7, font, color: rgb(0.8, 0.31, 0) });
    }
  }

  return { pdf: await doc.save(), unknownFields, truncated };
}

/** Merge several PDFs into one (for "Download PDFs to sign in person" and print). */
export async function mergePdfs(parts: Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const bytes of parts) {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const copied = await out.copyPages(src, src.getPageIndices());
    copied.forEach((p) => out.addPage(p));
  }
  return out.save();
}
