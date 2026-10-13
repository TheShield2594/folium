import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { layoutSpec, MARGIN, PAGE_H, PAGE_W, type SpecSection } from './layout';

export interface GenerateOptions {
  title: string;
  formNumber: string;
  revision: string;
  issuer: string;
  intro?: string;
  sections: SpecSection[];
  /** `flat` draws boxes only (like a scanned form); no AcroForm fields. */
  kind: 'fillable' | 'flat';
}

const INK = rgb(0.11, 0.13, 0.14);
const MUTED = rgb(0.38, 0.41, 0.42);
const RULE = rgb(0.75, 0.77, 0.77);
const BRAND = rgb(0.208, 0.518, 0.314); // Everence grass

/** Build a realistic-looking financial services form, used as demo template content. */
export async function generateTemplatePdf(opts: GenerateOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${opts.title} (${opts.formNumber})`);
  doc.setAuthor(opts.issuer);
  doc.setSubject(`Rev ${opts.revision}`);
  doc.setProducer('Folium demo template');
  doc.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  doc.setModificationDate(new Date('2026-01-01T00:00:00Z'));

  const sans = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const serif = await doc.embedFont(StandardFonts.TimesRomanBold);
  const layout = layoutSpec(opts.sections);
  const pages = Array.from({ length: layout.pageCount }, () => doc.addPage([PAGE_W, PAGE_H]));
  const form = opts.kind === 'fillable' ? doc.getForm() : undefined;
  const Y = (top: number) => PAGE_H - top; // top-left → PDF bottom-left

  pages.forEach((page, i) => {
    if (i === 0) {
      page.drawRectangle({ x: MARGIN, y: Y(MARGIN + 4), width: 6, height: 26, color: BRAND });
      page.drawText(opts.issuer.toUpperCase(), { x: MARGIN + 14, y: Y(MARGIN + 10), size: 8, font: bold, color: MUTED });
      page.drawText(opts.title, { x: MARGIN + 14, y: Y(MARGIN + 30), size: 18, font: serif, color: INK });
      if (opts.intro) page.drawText(opts.intro, { x: MARGIN, y: Y(MARGIN + 56), size: 8, font: sans, color: MUTED, maxWidth: PAGE_W - MARGIN * 2, lineHeight: 10 });
      page.drawLine({ start: { x: MARGIN, y: Y(MARGIN + 70) }, end: { x: PAGE_W - MARGIN, y: Y(MARGIN + 70) }, thickness: 1.5, color: INK });
    } else {
      page.drawText(`${opts.title} — continued`, { x: MARGIN, y: Y(MARGIN + 6), size: 9, font: bold, color: MUTED });
    }
    const foot = `${opts.formNumber}  ·  Rev ${opts.revision}  ·  Page ${i + 1} of ${layout.pageCount}`;
    page.drawText(foot, { x: PAGE_W - MARGIN - sans.widthOfTextAtSize(foot, 7), y: 28, size: 7, font: sans, color: MUTED });
  });

  for (const s of layout.sections) {
    const page = pages[s.page - 1];
    page.drawRectangle({ x: MARGIN, y: Y(s.y + 18), width: PAGE_W - MARGIN * 2, height: 16, color: rgb(0.914, 0.953, 0.953) });
    page.drawText(s.section.title.toUpperCase(), { x: MARGIN + 6, y: Y(s.y + 13), size: 8, font: bold, color: INK });
  }
  for (const n of layout.notes) {
    pages[n.page - 1].drawText(n.text, { x: n.x, y: Y(n.y + 6), size: 7.5, font: sans, color: MUTED, maxWidth: PAGE_W - MARGIN * 2 });
  }

  for (const lf of layout.fields) {
    const page = pages[lf.rect.page - 1];
    const { x, y, width, height } = lf.rect;
    page.drawText(lf.field.label + (lf.field.required ? ' *' : ''), { x: lf.labelAt.x, y: Y(lf.labelAt.y), size: 6.5, font: sans, color: MUTED });
    if (lf.field.type === 'checkbox') {
      page.drawRectangle({ x, y: Y(y + height), width, height, borderColor: INK, borderWidth: 0.75 });
      if (form) {
        const cb = form.createCheckBox(lf.field.name);
        cb.addToPage(page, { x: x + 1, y: Y(y + height) + 1, width: width - 2, height: height - 2, borderWidth: 0 });
      }
    } else {
      page.drawLine({ start: { x, y: Y(y + height) }, end: { x: x + width, y: Y(y + height) }, thickness: 0.6, color: RULE });
      if (form) {
        const tf = form.createTextField(lf.field.name);
        tf.addToPage(page, { x, y: Y(y + height), width, height, borderWidth: 0, font: sans });
        tf.setFontSize(9);
      }
    }
  }

  for (const line of layout.signatureLines) {
    const page = pages[line.page - 1];
    page.drawLine({ start: { x: line.x, y: Y(line.y) }, end: { x: line.x + line.width, y: Y(line.y) }, thickness: 0.8, color: INK });
    const label = line.label === 'Date' ? 'Date' : `${line.label} signature`;
    page.drawText(label, { x: line.x, y: Y(line.y + 10), size: 7, font: sans, color: MUTED });
  }

  return doc.save({ useObjectStreams: false });
}
