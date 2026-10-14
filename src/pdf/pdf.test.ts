import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { prefillForm } from '../domain/prefill';
import { createDemoServices } from '../services/demo';
import { CLIENTS, FIRM, TEMPLATES, USERS } from '../services/demo/seed';
import { fillPdf, mergePdfs } from './fill';
import { inspectPdf } from './inspect';
import { fitsBox, helveticaWidth } from './layout';
import { runChecks } from '../domain/checks';
import type { FormTemplate } from '../domain/types';

const services = createDemoServices();
const scope = { client: CLIENTS['c-jordan'], advisor: USERS[0], firm: FIRM };

describe('pdf', () => {
  it('generates fillable templates whose fields match the mapping', async () => {
    const t = TEMPLATES.find((x) => x.id === 'tpl-ev1120-0326')!;
    const info = await inspectPdf(await services.templates.getPdf(t));
    expect(info.kind).toBe('fillable');
    expect(info.pageCount).toBe(t.pageCount);
    const names = new Set(info.fields.map((f) => f.name));
    for (const m of t.mapping.fields) expect(names.has(m.pdfField)).toBe(true);
    const owner = info.fields.find((f) => f.name === 'Owner_Name_Full')!;
    expect(owner.rects[0].page).toBe(1);
    expect(owner.rects[0].y).toBeGreaterThan(0);
  });

  it('classifies scanned forms as flat', async () => {
    const t = TEMPLATES.find((x) => x.pdfKind === 'flat')!;
    expect((await inspectPdf(await services.templates.getPdf(t))).kind).toBe('flat');
  });

  it('fills, keeps fields editable unless flattened, and merges', async () => {
    const t = TEMPLATES.find((x) => x.id === 'tpl-ev1120-0326')!;
    const blank = await services.templates.getPdf(t);
    const fill = prefillForm(t, scope, { 'bene.Prim.1.pct': '100' });

    const editable = await fillPdf(blank, fill.fields, { kind: 'fillable' });
    expect(editable.unknownFields).toEqual([]);
    const doc = await PDFDocument.load(editable.pdf);
    expect(doc.getForm().getTextField('Owner_Name_Full').getText()).toBe('Jordan A. Miller');
    expect(doc.getForm().getTextField('Owner_SSN').getText()).toBe('412-55-0193');
    expect(doc.getForm().getTextField('Bene1_Pct').getText()).toBe('100%');

    const flat = await fillPdf(blank, fill.fields, { kind: 'fillable', flatten: true });
    expect((await PDFDocument.load(flat.pdf)).getForm().getFields()).toHaveLength(0);

    const merged = await mergePdfs([editable.pdf, flat.pdf]);
    expect((await PDFDocument.load(merged)).getPageCount()).toBe(t.pageCount * 2);
  });

  it('reports MaxLen, and a long value is a check instead of a silent cut', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const acct = doc.getForm().createTextField('Acct_Number');
    acct.setMaxLength(10);
    acct.addToPage(page, { x: 50, y: 700, width: 120, height: 16 });
    doc.getForm().createTextField('Name').addToPage(page, { x: 50, y: 660, width: 200, height: 16 });
    const bytes = await doc.save();

    const info = await inspectPdf(bytes);
    expect(info.fields.find((f) => f.name === 'Acct_Number')!.maxLength).toBe(10);
    expect(info.fields.find((f) => f.name === 'Name')!.maxLength).toBeUndefined();

    const t: FormTemplate = {
      ...TEMPLATES[0],
      id: 'tpl-maxlen',
      pdfKind: 'fillable',
      mapping: { formNumber: 'X', revision: '1', signers: [], placements: [], checks: [], fields: [{ pdfField: 'Acct_Number', source: 'advisor', required: true, key: 'acct', limits: { maxLength: info.fields[0].maxLength } }] },
    };
    const fill = prefillForm(t, scope, { acct: 'IRA-22-4471-99' });
    expect(fill.fields[0].formatError).toMatch(/Up to 10 characters/);
    const checks = runChecks([fill], { scope, values: { acct: 'IRA-22-4471-99' }, latestFor: () => t });
    expect(checks.find((c) => c.id === 'format:acct')?.level).toBe('block');

    // The PDF can't hold it; fillPdf says so rather than cutting quietly.
    const out = await fillPdf(bytes, fill.fields, { kind: 'fillable' });
    expect(out.truncated).toEqual(['Acct_Number']);
  });

  it('measures overlay text with Helvetica widths and warns when it can’t fit at 6pt', async () => {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    for (const s of ['Jordan A. Miller', 'WWW mmm iii 0123 {|}~', '1408 Riverbend Ln, Apt #4']) {
      // No kerning, so never narrower than pdf-lib's measure and within 2% of it.
      const real = font.widthOfTextAtSize(s, 10);
      expect(helveticaWidth(s, 10)).toBeGreaterThanOrEqual(real - 1e-9);
      expect(helveticaWidth(s, 10)).toBeLessThan(real * 1.02);
    }
    expect(fitsBox('Jordan A. Miller', { width: 100 })).toBe(true);
    expect(fitsBox('A very long trust name that goes on and on and on and on', { width: 100 })).toBe(false);

    const t: FormTemplate = {
      ...TEMPLATES[0],
      id: 'tpl-overlay',
      pdfKind: 'flat',
      mapping: {
        formNumber: 'S',
        revision: '1',
        signers: [],
        placements: [],
        checks: [],
        fields: [
          { pdfField: 'Overlay_1', source: 'advisor', required: false, key: 'long', rect: { page: 1, x: 50, y: 100, width: 120, height: 16 } },
          { pdfField: 'Overlay_2', source: 'contact.fullname', required: false, rect: { page: 1, x: 50, y: 140, width: 120, height: 16 } },
        ],
      },
    };
    const long = 'x'.repeat(400);
    const checks = runChecks([prefillForm(t, scope, { long })], { scope, values: { long }, latestFor: () => t });
    const warn = checks.find((c) => c.id === `${t.id}:fit:long`)!;
    expect(warn.level).toBe('warn');
    expect(warn.title).toMatch(/may not fit/);
    expect(checks.some((c) => c.id.includes(':fit:') && c.fieldKey !== 'long')).toBe(false);
  });
});

