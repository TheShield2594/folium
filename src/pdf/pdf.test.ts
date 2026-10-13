import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { prefillForm } from '../domain/prefill';
import { createDemoServices } from '../services/demo';
import { CLIENTS, FIRM, TEMPLATES, USERS } from '../services/demo/seed';
import { fillPdf, mergePdfs } from './fill';
import { inspectPdf } from './inspect';

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
});
