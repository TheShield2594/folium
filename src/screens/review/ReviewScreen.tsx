import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { FieldState } from '../../domain/prefill';
import { inputsNeeded } from '../../domain/prefill';
import { summarize } from '../../domain/checks';
import { sourceKind } from '../../domain/paths';
import { useServices } from '../../services';
import { Toolbar } from '../../shell/Shell';
import { packetAsOnePdf, saveDraft } from '../../state/actions';
import { useActingFor, useApp } from '../../state/store';
import { Button, Empty, IconButton, Menu, Segmented, downloadBytes, openPdf, toast } from '../../ui/controls';
import { Icon } from '../../ui/Icon';
import { NoClient } from '../common/NoClient';
import { PdfView } from '../common/PdfView';
import { ShareSheet } from '../common/ShareSheet';
import { Steps } from '../common/Steps';
import { usePacketView } from '../common/usePacket';
import { AttachmentsCard } from './AttachmentsCard';
import { FieldEditor, FieldInput } from './FieldEditor';

export function ReviewScreen() {
  const client = useApp((s) => s.client);
  const packet = useApp((s) => s.packet);
  const setValue = useApp((s) => s.setValue);
  const setPacket = useApp((s) => s.setPacket);
  const contactId = useApp((s) => s.contactId);
  const me = useApp((s) => s.me);
  const refreshRequests = useApp((s) => s.refreshRequests);
  const markUsed = useApp((s) => s.markUsed);
  const requests = useApp((s) => s.requests);
  const owner = useActingFor();
  const services = useServices();
  const view = usePacketView();
  const navigate = useNavigate();

  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [zoom, setZoom] = useState<'fit' | 'large'>('fit');
  const [busy, setBusy] = useState<string>();
  const [sharing, setSharing] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasW, setCanvasW] = useState(700);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCanvasW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [view?.fills.length]);

  const fill = view?.fills[Math.min(active, (view?.fills.length ?? 1) - 1)];
  // Keep a field in the list once it has appeared, so it doesn't vanish mid-typing.
  const seen = useRef(new Set<string>());
  const needs = useMemo(() => {
    if (!view) return [];
    const now = inputsNeeded(view.fills);
    now.forEach((n) => seen.current.add(n.key));
    const all = view.fills.flatMap((f) => f.fields);
    const req = new Map(now.map((n) => [n.key, n.required]));
    // Fields named by a failing template check (pick-one boxes, shares) count as required.
    for (const fill of view.fills) {
      fill.template.mapping.checks.forEach((c, i) => {
        if (view.checks.find((r) => r.id === `${fill.template.id}:check:${i}`)?.level !== 'block') return;
        // Pick-one groups need attention as a set; for totals, the first share is enough.
        const names = c.type === 'oneOf' ? c.fields : 'fields' in c ? c.fields.slice(0, 1) : [c.field];
        for (const f of fill.fields) if (names.includes(f.mapping.pdfField) && req.has(f.key)) req.set(f.key, true);
      });
    }
    return [...seen.current]
      .map((key) => ({ key, fields: all.filter((f) => f.key === key), required: req.get(key) ?? all.some((f) => f.key === key && f.required) }))
      .filter((n) => n.fields.length > 0);
  }, [view]);
  const requiredNeeds = needs.filter((n) => n.required);
  const optionalNeeds = needs.filter((n) => !n.required);
  const [showOptional, setShowOptional] = useState(false);
  const sum = view ? summarize(view.checks) : undefined;
  const selectedField: FieldState | undefined = useMemo(() => fill?.fields.find((f) => f.key === selected) ?? view?.fills.flatMap((f) => f.fields).find((f) => f.key === selected), [fill, view, selected]);

  // Jump to the form + field for a key (from checks or the inputs list).
  function focusKey(key: string | undefined, templateId?: string) {
    if (!view || !key) return;
    const idx = templateId ? view.fills.findIndex((f) => f.template.id === templateId) : view.fills.findIndex((f) => f.fields.some((x) => x.key === key));
    if (idx >= 0) setActive(idx);
    setSelected(key);
    if (optionalNeeds.some((n) => n.key === key)) setShowOptional(true);
    requestAnimationFrame(() => document.getElementById(`in-${cssKey(key)}`)?.querySelector<HTMLElement>('input, select, textarea')?.focus());
  }

  function nextMissing() {
    const keys = needs.filter((n) => n.fields.some((f) => f.missing || f.formatError)).map((n) => n.key);
    if (!keys.length) return toast.ok('Nothing left to fill.');
    const i = selected ? keys.indexOf(selected) : -1;
    focusKey(keys[(i + 1) % keys.length]);
  }

  if (!client) return <NoClient />;
  if (!view || !packet.items.length) {
    return (
      <>
        <Toolbar title="Review" back={{ label: 'Forms', to: '/' }} />
        <div className="scroll" style={{ display: 'grid', placeItems: 'center' }}>
          <Empty icon="docs" title="No forms in this packet" action={<Button variant="filled" onClick={() => navigate('/')}>Find forms</Button>}>
            Add one or more forms, then come back to review what Folium filled in.
          </Empty>
        </div>
      </>
    );
  }

  async function onSaveDraft() {
    if (!contactId || !me || !owner || !view) return;
    setBusy('draft');
    try {
      const existing = packet.requestId ? requests.find((r) => r.id === packet.requestId) : undefined;
      const saved = await saveDraft({ services, packet, fills: view.fills, contactId, me, owner, existing, writePdfs: true });
      setPacket({ requestId: saved.id, title: saved.title });
      await refreshRequests();
      toast.ok(`Draft saved to ${client!.contact.firstname}’s SharePoint folder`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save draft');
    } finally {
      setBusy(undefined);
    }
  }

  async function download(mode: 'fillable' | 'flatten' | 'print') {
    if (!view) return;
    setBusy('download');
    try {
      const bytes = await packetAsOnePdf(services, view.fills, mode === 'fillable' ? 'fillable' : 'flatten');
      const name = `${client!.contact.lastname} - ${packet.title || view.fills.map((f) => f.template.formNumber).join(', ')}${mode === 'fillable' ? ' (fillable)' : ''}.pdf`;
      if (mode === 'print') openPdf(bytes);
      else downloadBytes(bytes, name);
      markUsed(view.templates.map((t) => t.id));
    } finally {
      setBusy(undefined);
    }
  }

  function renderNeed(key: string, fields: FieldState[]) {
    const f = fields[0];
    const forms = [...new Set(fields.map((x) => view!.fills.find((v) => v.template.id === x.templateId)?.template.name))];
    return (
      <div key={key} id={`in-${cssKey(key)}`} className={['input-row', selected === key && 'active'].filter(Boolean).join(' ')} onFocus={() => setSelected(key)}>
        <FieldInput field={f} value={packet.values[key] ?? f.value} onChange={(v) => setValue(key, v)} />
        <div className="where" style={{ marginTop: 6 }}>
          {forms.length > 1 ? `Used on ${forms.length} forms — enter it once` : forms[0]}
          {sourceKind(f.mapping.source) === 'crm' && ' · not on file in CRM'}
        </div>
      </div>
    );
  }

  const width = zoom === 'fit' ? Math.min(Math.max(canvasW - 48, 320), 860) : 980;

  return (
    <>
      <Toolbar title="Prefill & review" subtitle={`${client.contact.fullname} · ${view.fills.length} ${view.fills.length === 1 ? 'form' : 'forms'}`} back={{ label: 'Forms', to: '/' }}>
        <Steps current={1} />
        <Menu
          trigger={(p) => (
            <Button variant="gray" icon="download" busy={busy === 'download'} {...p}>
              Download
            </Button>
          )}
          items={[
            { label: 'Fillable PDF (editable)', icon: 'doc', onSelect: () => download('fillable') },
            { label: 'Flattened PDF to sign in person', icon: 'lock', onSelect: () => download('flatten') },
            { label: 'Print…', icon: 'printer', onSelect: () => download('print') },
          ]}
        />
        <Menu
          trigger={(p) => <IconButton icon="ellipsis" label="More" {...p} />}
          items={[
            { label: 'Save draft to SharePoint', icon: 'folder', onSelect: onSaveDraft },
            { label: 'Share with a colleague…', icon: 'share', onSelect: () => setSharing(true) },
          ]}
        />
        <Button variant="gray" icon="folder" busy={busy === 'draft'} onClick={onSaveDraft} className="hide-narrow">
          Save draft
        </Button>
        <Button variant="filled" iconAfter="chevronRight" onClick={() => navigate('/send')}>
          Signers
        </Button>
      </Toolbar>

      <div className="doc-tabs" role="tablist" aria-label="Forms in this packet">
        {view.fills.map((f, i) => (
          <button key={f.template.id} role="tab" className="doc-tab" aria-selected={i === active} onClick={() => setActive(i)}>
            {f.template.name}
            {f.missingCount ? <span className="count-dot">{f.missingCount}</span> : <Icon name="checkCircle" size={16} className="ok" />}
          </button>
        ))}
      </div>

      <div className="review" style={{ flex: 1, minHeight: 0 }}>
        <section className="review-canvas" ref={canvasRef} aria-label={`${fill?.template.name} preview`}>
          <div className="row wrap" style={{ maxWidth: width, margin: '0 auto 14px', justifyContent: 'space-between' }}>
            <div className="legend" aria-label="Legend">
              <span><i style={{ background: 'var(--hl-crm)', boxShadow: 'inset 0 -1.5px 0 var(--hl-crm-line)' }} />From CRM</span>
              <span><i style={{ background: 'var(--hl-need)', boxShadow: 'inset 0 0 0 1.25px var(--hl-need-line)' }} />Needs input</span>
              <span><i style={{ background: 'var(--hl-edit)', boxShadow: 'inset 0 -1.5px 0 var(--hl-edit-line)' }} />Entered or changed</span>
              <span><i style={{ background: 'rgba(0,128,189,.1)', boxShadow: 'inset 0 0 0 1px rgba(0,128,189,.35)' }} />Signer completes</span>
              <span><i style={{ background: '#fff8d6', boxShadow: '0 0 0 1px #d4a400' }} />Signature tab</span>
            </div>
            <Segmented
              label="Zoom"
              value={zoom}
              onChange={setZoom}
              options={[
                { value: 'fit', label: 'Fit' },
                { value: 'large', label: 'Large' },
              ]}
            />
          </div>
          {fill && (
            <PdfView
              key={fill.template.id}
              template={fill.template}
              fields={fill.fields}
              placements={fill.template.mapping.placements}
              width={width}
              activeKey={selected}
              onFieldClick={(f) => f.origin !== 'signer' && focusKey(f.key, f.templateId)}
              pageLabel={(p) => (
                <span className="t-footnote c3">
                  {fill.template.formNumber} · page {p} of {fill.template.pageCount}
                </span>
              )}
            />
          )}
        </section>

        <aside className="review-side stack-4" aria-label="Review panel">
          {selectedField && (
            <FieldEditor
              field={selectedField}
              value={packet.values[selectedField.key]}
              onChange={(v) => setValue(selectedField.key, v)}
              onClose={() => setSelected(undefined)}
              usedOn={view.fills.filter((f) => f.fields.some((x) => x.key === selectedField.key)).map((f) => f.template.name)}
            />
          )}

          <section className="stack-3" aria-labelledby="needs-h">
            <div className="row">
              <h2 id="needs-h" className="t-title3 grow">Needs your input</h2>
              {requiredNeeds.length > 0 && (
                <Button variant="plain" size="sm" iconAfter="arrowRight" onClick={nextMissing}>
                  Next
                </Button>
              )}
            </div>
            {requiredNeeds.length === 0 ? (
              <div className="banner ok">
                <Icon name="checkCircle" size={18} />
                Everything required is filled.
              </div>
            ) : (
              requiredNeeds.map((n) => renderNeed(n.key, n.fields))
            )}
            {optionalNeeds.length > 0 && (
              <>
                <button className="btn btn-plain btn-sm" style={{ alignSelf: 'flex-start' }} aria-expanded={showOptional} onClick={() => setShowOptional(!showOptional)}>
                  <Icon name={showOptional ? 'chevronDown' : 'chevronRight'} size={14} strokeWidth={2.2} />
                  {optionalNeeds.length} optional {optionalNeeds.length === 1 ? 'field' : 'fields'}
                </button>
                {showOptional && optionalNeeds.map((n) => renderNeed(n.key, n.fields))}
              </>
            )}
          </section>

          <section className="card" aria-labelledby="checks-h">
            <div className="card-head">
              <h2 id="checks-h">Checks before send</h2>
              {sum && (sum.blocking ? <span className="badge badge-warn">{sum.blocking} to fix</span> : <span className="badge badge-accent">All clear</span>)}
            </div>
            <div style={{ padding: '0 8px 10px' }}>
              {view.checks.map((c) => {
                const content = (
                  <>
                    <Icon name={c.level === 'pass' ? 'checkCircle' : c.level === 'warn' ? 'info' : 'warning'} size={18} className={c.level === 'pass' ? 'c-accent' : c.level === 'warn' ? 'c-info' : 'c-warn'} />
                    <span className="grow">
                      <span style={{ fontWeight: c.level === 'pass' ? 400 : 600 }}>{c.title}</span>
                      {c.detail && <span className="t-footnote c3" style={{ display: 'block' }}>{c.detail}</span>}
                    </span>
                  </>
                );
                return c.level !== 'pass' && (c.fieldKey || c.templateId) ? (
                  <button key={c.id} className="check-row" onClick={() => focusKey(c.fieldKey, c.templateId)}>
                    {content}
                    <Icon name="chevronRight" size={14} className="c3" />
                  </button>
                ) : (
                  <div key={c.id} className="check-row">
                    {content}
                  </div>
                );
              })}
            </div>
          </section>

          <AttachmentsCard />

          {fill && (
            <section className="card card-pad stack-3" aria-labelledby="prov-h">
              <div className="row">
                <h2 id="prov-h" className="t-headline grow">Where values came from</h2>
                <IconButton icon="info" label="Edits on this screen change the form only. Use Contact & accounts to fix the CRM record." size={16} />
              </div>
              <dl className="prov">
                {fill.fields
                  .filter((f) => f.value && f.origin !== 'signer')
                  .slice(0, 14)
                  .map((f) => (
                    <div key={f.mapping.pdfField} style={{ display: 'contents' }}>
                      <dt>{f.label}</dt>
                      <dd>{f.origin === 'edited' ? 'Changed by you' : f.sourceLabel}</dd>
                    </div>
                  ))}
              </dl>
              <p className="t-footnote c3">Edits here change the form only, never the CRM record.</p>
            </section>
          )}
        </aside>
      </div>
      {sharing && <ShareSheet onClose={() => setSharing(false)} />}
    </>
  );
}

const cssKey = (k: string) => k.replace(/[^a-zA-Z0-9_-]/g, '_');
