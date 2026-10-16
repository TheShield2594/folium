import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { FieldState } from '../../domain/prefill';
import { defaultDraftTitle, upgradePacketItems, type UpgradeReport } from '../../domain/drafts';
import { canDownload, sharingAllowed } from '../../domain/policy';
import { draftsAllowed, retentionDays } from '../../domain/requests';
import { blockKey, choiceOptions, copyScope, fillBlockFromPerson, inputsNeeded, personBlocks, relatedPeople, snapshotDiff } from '../../domain/prefill';
import type { SignatureRequest } from '../../domain/types';
import { formLabel, goodOrder, outputGate, summarize, type CheckResult } from '../../domain/checks';
import { sourceKind } from '../../domain/paths';
import { useServices } from '../../services';
import { Toolbar } from '../../shell/Shell';
import { audit, packetAsOnePdf, saveDraft } from '../../state/actions';
import { track, useActingFor, useApp } from '../../state/store';
import { Button, Empty, IconButton, Menu, Segmented, Select, downloadBytes, openPdf, toast } from '../../ui/controls';
import { Icon } from '../../ui/Icon';
import { BlockersSheet } from '../common/BlockersSheet';
import { NoClient } from '../common/NoClient';
import { PdfView } from '../common/PdfView';
import { NameSheet } from '../common/NameSheet';
import { ShareSheet } from '../common/ShareSheet';
import { Steps } from '../common/Steps';
import { UpgradeSheet } from '../common/UpgradeSheet';
import { missingLabel, usePacketView } from '../common/usePacket';
import { fmtDay } from '../requests/RequestCard';
import { AttachmentsCard } from './AttachmentsCard';
import { FieldEditor, FieldInput } from './FieldEditor';
import { ReportProblemSheet } from './ReportProblemSheet';

/** Prefill & review: the packet's forms as PDFs with what Folium filled in, what's missing, and the pre-send checks. */
export function ReviewScreen() {
  const client = useApp((s) => s.client);
  const packet = useApp((s) => s.packet);
  const setValue = useApp((s) => s.setValue);
  const setValues = useApp((s) => s.setValues);
  const setPacket = useApp((s) => s.setPacket);
  const contactId = useApp((s) => s.contactId);
  const me = useApp((s) => s.me);
  const refreshRequests = useApp((s) => s.refreshRequests);
  const markUsed = useApp((s) => s.markUsed);
  const firm = useApp((s) => s.firm);
  const requests = useApp((s) => s.requests);
  const setPacketAccount = useApp((s) => s.setPacketAccount);
  const removeFromPacket = useApp((s) => s.removeFromPacket);
  const upgradePacket = useApp((s) => s.upgradePacket);
  const applyFix = useApp((s) => s.applyFix);
  const showAssist = useApp((s) => s.showAssist);
  const templates = useApp((s) => s.templates);
  const owner = useActingFor();
  const services = useServices();
  const view = usePacketView();
  const navigate = useNavigate();

  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<string>();
  /**
   * The field in the "Selected field" editor. Separate from `selected` so focusing a row
   * in Needs your input only highlights it: changing the editor above the list mid-click
   * would move the row out from under the pointer (and a checkbox would miss the click).
   */
  const [editorKey, setEditorKey] = useState<string>();
  const [zoom, setZoom] = useState<'fit' | 'large'>('fit');
  const [busy, setBusy] = useState<string>();
  const [sharing, setSharing] = useState(false);
  const [naming, setNaming] = useState(false);
  /** "Report a problem": the packet item and the PDF fields to start with. */
  const [reporting, setReporting] = useState<{ itemId: string; fieldKeys: string[] }>();
  /** The changes "Update" would make, shown before they're made. */
  const [upgrade, setUpgrade] = useState<UpgradeReport>();
  // With retention set to 0 the firm keeps no drafts: no Save draft, no Share.
  const policy = useApp((s) => s.policy);
  const canSaveDrafts = draftsAllowed(policy);
  const canShare = sharingAllowed(policy);
  /** Set when an output was refused, to list what's blocking it. */
  const [blocked, setBlocked] = useState<{ title: string; blockers: CheckResult[] }>();
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
        if (view.checks.find((r) => r.id === `${fill.itemId}:check:${i}`)?.level !== 'block') return;
        // Pick-one groups need attention as a set; for totals, the first share is enough.
        const names = c.type === 'oneOf' ? c.fields : 'fields' in c ? c.fields.slice(0, 1) : [c.field];
        for (const f of fill.fields) if (names.includes(f.mapping.pdfField) && req.has(f.key)) req.set(f.key, true);
      });
    }
    return [...seen.current]
      .map((key) => ({ key, fields: all.filter((f) => f.key === key), required: req.get(key) ?? all.some((f) => f.key === key && f.required) }))
      // A locked field leaves the list while it's locked, and comes back if it unlocks.
      .filter((n) => n.fields.length > 0 && !n.fields.every((f) => f.locked));
  }, [view]);
  const requiredNeeds = needs.filter((n) => n.required);
  const optionalNeeds = needs.filter((n) => !n.required);
  const [showOptional, setShowOptional] = useState(false);
  const sum = view ? summarize(view.checks) : undefined;
  const order = view ? goodOrder(view.checks) : undefined;
  // Checks lead while anything blocks; otherwise the field inputs do.
  const [chosenTab, setTab] = useState<'checks' | 'fields'>();
  // Checks lead while anything blocks, decided once the packet's checks are known (the
  // client may still be loading on the first render). After that the advisor's choice stands.
  useEffect(() => {
    if (!chosenTab && sum) setTab(sum.blocking ? 'checks' : 'fields');
  }, [chosenTab, sum]);
  const tab = chosenTab ?? 'fields';
  const changedSince = useMemo(() => (view ? snapshotDiff(packet.snapshot, view.fills) : []), [view, packet.snapshot]);
  const replaced = packet.items.filter((i) => i.accountReplaced);

  /** Settle one "changed in Dynamics" row: keep the saved value as an override, or take the new one. */
  function settleChange(key: string, keep: string | undefined) {
    setValue(key, keep);
    const { [key]: _done, ...rest } = useApp.getState().packet.snapshot ?? {};
    setPacket({ snapshot: rest });
  }
  const selectedField: FieldState | undefined = useMemo(() => fill?.fields.find((f) => f.key === editorKey) ?? view?.fills.flatMap((f) => f.fields).find((f) => f.key === editorKey), [fill, view, editorKey]);

  // Jump to the form + field for a key (from checks or the inputs list). `formId` is a
  // packet item id, or a template id for checks that only know the form.
  function focusKey(key: string | undefined, formId?: string) {
    if (!view) return;
    const byItem = formId ? view.fills.findIndex((f) => f.itemId === formId) : -1;
    const idx = byItem >= 0 ? byItem : formId ? view.fills.findIndex((f) => f.template.id === formId) : view.fills.findIndex((f) => f.fields.some((x) => x.key === key));
    if (idx >= 0) setActive(idx);
    // Form-level checks (an out-of-date revision) just switch to the form.
    if (!key) return;
    setSelected(key);
    setEditorKey(key);
    setTab('fields');
    if (optionalNeeds.some((n) => n.key === key)) setShowOptional(true);
    requestAnimationFrame(() => document.getElementById(`in-${cssKey(key)}`)?.querySelector<HTMLElement>('input, select, textarea')?.focus());
  }

  /** The open checks about a field, so its input and its box on the page are described by them. */
  function checkIdsFor(key: string, itemId?: string): string | undefined {
    const ids = (view?.checks ?? [])
      .filter((c) => c.level !== 'pass' && c.fieldKey === key && (!itemId || !c.itemId || c.itemId === itemId))
      .map((c) => checkId(c.id));
    return ids.length ? ids.join(' ') : undefined;
  }

  /** Apply a check's fix, show the form and field it changed, and offer Undo. */
  function fix(c: CheckResult) {
    if (!view || !c.fix) return;
    const key = c.fix.fieldKey ?? c.fieldKey;
    const undo = applyFix(c);
    const idx = view.fills.findIndex((f) => f.itemId === c.itemId);
    if (idx >= 0) setActive(idx);
    if (key) {
      setSelected(key);
      setTimeout(() => document.querySelector(`.review-canvas .hl[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60);
    }
    toast.ok(c.fix.resolvedLabel, undo ? { label: 'Undo', onClick: undo } : undefined);
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

  /** The first save asks for a name; later saves update the same draft. */
  function onSaveDraft() {
    if (!packet.requestId) return setNaming(true);
    writeDraft(packet.title).catch((e) => toast.error(e instanceof Error ? e.message : 'Could not save draft'));
  }

  async function writeDraft(title: string, into?: SignatureRequest) {
    if (!contactId || !me || !owner || !view) return;
    setBusy('draft');
    try {
      const existing = into ?? (packet.requestId ? requests.find((r) => r.id === packet.requestId) : undefined);
      const saved = await saveDraft({
        services,
        packet: { ...packet, title },
        fills: view.fills,
        contactId,
        me,
        owner,
        existing,
        writePdfs: true,
        trackUsage: true,
        retentionDays: retentionDays(policy),
        // Keep the row's identity even if writing the PDFs fails, so a retry updates it.
        onSaved: (row) => setPacket({ requestId: row.id, title: row.title, attachments: row.attachments, snapshot: row.prefillSnapshot, formsUpdated: undefined, dirty: false }),
      });
      setPacket({ requestId: saved.id, title: saved.title, attachments: saved.attachments, snapshot: saved.prefillSnapshot, formsUpdated: undefined, dirty: false });
      toast.ok(saved.expiresOn ? `Saved to ${client!.contact.firstname}’s SharePoint folder. Kept until ${fmtDay(saved.expiresOn)}.` : `Draft saved to ${client!.contact.firstname}’s SharePoint folder`);
    } finally {
      await refreshRequests().catch(() => undefined);
      setBusy(undefined);
    }
  }

  async function download(mode: 'fillable' | 'flatten' | 'print') {
    if (!view || !canDownload(mode, policy)) return;
    // Anything a client could wet-sign needs every blocking check cleared first.
    const gate = outputGate(view.checks, mode, { blockFillable: firm?.blockFillableWhenIncomplete });
    if (!gate.allowed) {
      setBlocked({ title: mode === 'print' ? 'Can’t print yet' : mode === 'flatten' ? 'Can’t make the PDF to sign yet' : 'Can’t download yet', blockers: gate.blockers });
      return;
    }
    setBusy('download');
    try {
      const bytes = await packetAsOnePdf(services, view.fills, mode === 'fillable' ? 'fillable' : 'flatten', gate.draftMark);
      const name = `${client!.contact.lastname} - ${packet.title || view.fills.map((f) => f.template.formNumber).join(', ')}${mode === 'fillable' ? (gate.draftMark ? ' (fillable, draft)' : ' (fillable)') : ''}.pdf`;
      if (mode === 'print') openPdf(bytes);
      else downloadBytes(bytes, name);
      markUsed(view.templates.map((t) => t.id));
      track(mode === 'fillable' ? 'pdf.fillable' : mode === 'flatten' ? 'pdf.flattened' : 'pdf.print', view.fills.map((f) => f.template), {
        requestId: packet.requestId,
        detail: { mode: mode === 'fillable' && gate.draftMark ? 'fillable-draft' : mode },
      });
      if (gate.draftMark) recordIncompleteDownload(gate.blockers);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not build the PDF');
    } finally {
      setBusy(undefined);
    }
  }

  /** Let supervision see that an incomplete (draft-marked) PDF left Folium. Needs a saved draft to note it on. */
  function recordIncompleteDownload(blockers: CheckResult[]) {
    const row = packet.requestId ? requests.find((r) => r.id === packet.requestId) : undefined;
    if (!row || !me) return;
    const detail = `${blockers.length} open ${blockers.length === 1 ? 'check' : 'checks'}: ${blockers.map((b) => b.title).join('; ')}`.slice(0, 400);
    services.requests
      .save({ ...row, audit: [...row.audit, audit(me, 'Downloaded editable PDF marked draft', detail)] })
      .then(() => refreshRequests())
      .catch(() => undefined);
  }

  /**
   * Fill a person block on the open form from someone related to the client. Forms
   * that share the block's keys follow (the same beneficiary 2 everywhere); an added
   * copy keeps its own.
   */
  function pickPerson(block: string, choice: string) {
    if (!view || !fill) return;
    const scope = copyScope({ id: fill.itemId, copy: fill.copy });
    const same = view.fills.filter((f) => copyScope({ id: f.itemId, copy: f.copy }) === scope);
    const people = relatedPeople(client!);
    const k = blockKey(block, fill);
    const { [k]: _old, ...rest } = packet.personBlocks ?? {};
    if (choice === 'crm') {
      // Back to what the template maps: drop the overrides.
      setValues(Object.fromEntries(Object.keys(fillBlockFromPerson(same, block, undefined)).map((key) => [key, undefined])));
      setPacket({ personBlocks: rest });
      return;
    }
    const person = choice === 'new' ? undefined : people[Number(choice)];
    setValues(fillBlockFromPerson(same, block, person));
    setPacket({ personBlocks: { ...rest, [k]: person ? { contactId: person.contactId, name: person.name, role: person.role } : { name: 'Someone new', role: '' } } });
  }

  /** The choices a set of boxes or a radio group sharing a key offers, across the packet. */
  const choicesFor = (key: string) => choiceOptions(view!.fills.flatMap((x) => x.fields).filter((x) => x.key === key));

  function renderNeed(key: string, fields: FieldState[]) {
    const f = fields[0];
    const forms = [...new Set(fields.map((x) => view!.fills.find((v) => v.itemId === x.itemId)).map((v) => (v ? formLabel(v) : undefined)))];
    return (
      <div key={key} id={`in-${cssKey(key)}`} className={['input-row', selected === key && 'active'].filter(Boolean).join(' ')} onFocus={() => setSelected(key)}>
        <FieldInput field={f} value={packet.values[key] ?? f.value} onChange={(v) => setValue(key, v)} choices={choicesFor(key)} describedBy={checkIdsFor(key)} />
        <div className="where" style={{ marginTop: 6 }}>
          {forms.length > 1 ? `Used on ${forms.length} forms — enter it once` : forms[0]}
          {sourceKind(f.mapping.source) === 'crm' && ' · not on file in CRM'}
        </div>
      </div>
    );
  }

  // The firm decides which PDFs can leave Folium (`pdfDownload`); e-signature always can.
  const downloads = [
    ...(canDownload('fillable', policy) ? [{ label: sum?.blocking ? 'Fillable PDF (marked draft)' : 'Fillable PDF (editable)', icon: 'doc' as const, onSelect: () => download('fillable') }] : []),
    ...(canDownload('flatten', policy)
      ? [{ label: sum?.blocking ? `Flattened PDF to sign in person (${sum.blocking} to fix)` : 'Flattened PDF to sign in person', icon: 'lock' as const, onSelect: () => download('flatten') }]
      : []),
    ...(canDownload('print', policy) ? [{ label: sum?.blocking ? `Print… (${sum.blocking} to fix)` : 'Print…', icon: 'printer' as const, onSelect: () => download('print') }] : []),
  ];

  const width = zoom === 'fit' ? Math.min(Math.max(canvasW - 48, 320), 860) : 980;

  return (
    <>
      <Toolbar title="Prefill & review" subtitle={`${client.contact.fullname} · ${view.fills.length} ${view.fills.length === 1 ? 'form' : 'forms'}`} back={{ label: 'Forms', to: '/' }}>
        <Steps current={1} locked={sum?.blocking ? [2] : undefined} />
        {downloads.length > 0 && (
          <Menu
            trigger={(p) => (
              <Button variant="gray" icon="download" busy={busy === 'download'} {...p}>
                Download
              </Button>
            )}
            items={downloads}
          />
        )}
        <Menu
          trigger={(p) => <IconButton icon="ellipsis" label="More" {...p} />}
          items={[
            ...(canSaveDrafts ? [{ label: 'Save draft to SharePoint', icon: 'folder' as const, onSelect: onSaveDraft }] : []),
            ...(canShare ? [{ label: 'Share with a colleague…', icon: 'share' as const, onSelect: () => setSharing(true) }] : []),
            ...(fill ? [{ label: `Report a problem with ${fill.template.formNumber}…`, icon: 'flag' as const, onSelect: () => setReporting({ itemId: fill.itemId, fieldKeys: [] }) }] : []),
          ]}
        />
        {canSaveDrafts && (
          <Button variant="gray" icon="folder" busy={busy === 'draft'} onClick={onSaveDraft} className="hide-narrow">
            Save draft
          </Button>
        )}
        <Button
          variant="filled"
          iconAfter="chevronRight"
          disabled={!!sum?.blocking}
          title={sum?.blocking ? `Fix ${sum.blocking} ${sum.blocking === 1 ? 'item' : 'items'} before adding signers` : undefined}
          onClick={() => navigate('/send')}
        >
          Signers
        </Button>
      </Toolbar>

      <div className="review" style={{ flex: 1, minHeight: 0 }}>
        <nav className="forms-rail" aria-labelledby="rail-h">
          <h2 id="rail-h" className="rail-head">Forms in packet</h2>
          <div
            className="rail-tabs"
            role="tablist"
            aria-labelledby="rail-h"
            aria-orientation="vertical"
            onKeyDown={(e) => {
              // Arrow keys move between forms, as in any tab list; Tab moves on to the form itself.
              const n = view.fills.length;
              const next = e.key === 'ArrowDown' || e.key === 'ArrowRight';
              const prev = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
              const to = next ? (active + 1) % n : prev ? (active - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
              if (to < 0) return;
              e.preventDefault();
              setActive(to);
              document.getElementById(`doc-tab-${to}`)?.focus();
            }}
          >
            {view.fills.map((f, i) => {
              const open = view.checks.filter((c) => c.level === 'block' && c.itemId === f.itemId).length;
              return (
                <button
                  key={f.itemId}
                  id={`doc-tab-${i}`}
                  type="button"
                  role="tab"
                  className="form-tile"
                  aria-selected={i === active}
                  aria-controls="doc-panel"
                  tabIndex={i === active ? 0 : -1}
                  onClick={() => setActive(i)}
                >
                  <span className="name">{formLabel(f)}</span>
                  <span className="meta">
                    {f.template.formNumber} · Rev {f.template.revision}
                  </span>
                  <span className="status">
                    <i className={['dot sm', open && 'attention'].filter(Boolean).join(' ')} aria-hidden="true" />
                    {open ? `${open} to fix` : 'In good order'}
                  </span>
                </button>
              );
            })}
          </div>
          {showAssist &&
            [...new Set(view.fills.map((f) => f.template.id))]
              .filter((id) => packet.reasons?.[id])
              .map((id) => (
                <p key={id} className="why-added">
                  {packet.reasons![id]}
                </p>
              ))}
        </nav>

        <section className="review-canvas" ref={canvasRef} id="doc-panel" role="tabpanel" aria-labelledby={`doc-tab-${active}`}>
          <div className="row wrap" style={{ maxWidth: width, margin: '0 auto 14px', justifyContent: 'space-between' }}>
            <div className="legend" role="group" aria-label="Legend">
              <span><i className="hl-crm" />From Dynamics 365</span>
              <span><i className="hl-edit" />Entered once</span>
              <span><i className="hl-need" style={{ animation: 'none' }} />Needs input</span>
              <span><i className="hl-signer" />Signature</span>
              <span><i style={{ background: '#fff8d6', boxShadow: '0 0 0 1px #d4a400' }} />DocuSign tab</span>
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
              key={fill.itemId}
              template={fill.template}
              fields={fill.fields}
              placements={fill.template.mapping.placements}
              width={width}
              activeKey={selected}
              onFieldClick={(f) => focusKey(f.key, f.itemId)}
              canActivate={(f) => f.origin !== 'signer'}
              describedBy={(f) => checkIdsFor(f.key, f.itemId)}
              pageLabel={(p) => (
                <span className="t-footnote c3">
                  {fill.template.formNumber} · page {p} of {fill.template.pageCount}
                </span>
              )}
            />
          )}
        </section>

        <aside className="review-side stack-4" aria-label="Review panel">
          {view.missing.map((item) => (
            <section key={item.id} className="banner" role="alert" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 8 }}>
              <span className="t-callout">
                <Icon name="warning" size={16} /> <strong>{missingLabel(item)}</strong> is no longer in the library, so it can’t be shown or sent.
              </span>
              <Button variant="gray" size="sm" icon="trash" onClick={() => removeFromPacket(item.id)}>
                Remove it from the packet
              </Button>
            </section>
          ))}

          <Segmented
            label="Inspector"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'checks', label: sum?.blocking ? `Checks (${sum.blocking})` : 'Checks' },
              { value: 'fields', label: requiredNeeds.length ? `Fields (${requiredNeeds.length})` : 'Fields' },
            ]}
          />

          {tab === 'checks' && order && (
            <>
              <section className="card panel good-order" aria-labelledby="order-h">
                <div className="row" style={{ alignItems: 'baseline' }}>
                  <h2 id="order-h" className="grow">In good order</h2>
                  <b className="tabular">{order.percent}%</b>
                </div>
                <div className="meter good-order-meter" role="meter" aria-valuenow={order.percent} aria-valuemin={0} aria-valuemax={100} aria-label="In good order">
                  <i style={{ clipPath: `inset(0 ${100 - order.percent}% 0 0)` }} />
                </div>
                <p className="t-callout c2">
                  {order.blocking
                    ? `${order.blocking} ${order.blocking === 1 ? 'item' : 'items'} to fix. Signers can’t be added until ${order.blocking === 1 ? 'it’s' : 'they’re'} fixed.`
                    : order.warnings
                      ? `Ready for signers. ${order.warnings} ${order.warnings === 1 ? 'note' : 'notes'} to look over.`
                      : 'Every check passed. Ready for signers.'}
                </p>
              </section>

              <section className="card check-list" aria-label="Checks before send">
                {[...view.checks].sort((a, b) => rank(a) - rank(b)).map((c) => {
                  const resolved = c.level === 'pass' ? packet.resolved?.[c.id] : undefined;
                  const preview = c.id === 'current-revisions' && c.level === 'block' ? upgradePacketItems(packet.items, packet.values, templates).report : undefined;
                  const canJump = c.level !== 'pass' && !!(c.fieldKey || c.templateId);
                  return (
                    <div key={c.id} id={checkId(c.id)} className="check-item">
                      <i className={['dot', c.level === 'block' ? 'attention' : c.level === 'warn' ? 'info' : ''].filter(Boolean).join(' ')} aria-hidden="true" />
                      <div className="stack" style={{ minWidth: 0 }}>
                        <div>
                          <div className="t-callout" style={{ fontWeight: 700 }}>
                            <span className="sr-only">{c.level === 'pass' ? 'Passed: ' : c.level === 'warn' ? 'Note: ' : 'To fix: '}</span>
                            {c.title}
                          </div>
                          {c.detail && <div className="t-footnote c2">{c.detail}</div>}
                        </div>
                        {resolved && <span className="resolved">{resolved}</span>}
                        {(c.fix || preview || canJump) && (
                          <div className="row wrap" style={{ gap: 6 }}>
                            {c.fix && (
                              <Button variant="fix" size="sm" onClick={() => fix(c)}>
                                {c.fix.label}
                              </Button>
                            )}
                            {preview?.forms.some((f) => f.state === 'newer') && (
                              <Button variant="fix" size="sm" onClick={() => setUpgrade(preview)}>
                                Update to current
                              </Button>
                            )}
                            {canJump && (
                              <Button variant="plain" size="sm" onClick={() => focusKey(c.fieldKey, c.itemId ?? c.templateId)}>
                                Show
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </section>

              <button type="button" className="continue-btn" disabled={!order.ready} onClick={() => navigate('/send')}>
                {order.ready ? 'Continue to signers' : `Fix ${order.blocking} ${order.blocking === 1 ? 'item' : 'items'} to continue`}
              </button>
            </>
          )}

          {tab === 'fields' && (
          <>
          {selectedField && (
            <FieldEditor
              field={selectedField}
              value={packet.values[selectedField.key]}
              onChange={(v) => setValue(selectedField.key, v)}
              onClose={() => (setSelected(undefined), setEditorKey(undefined))}
              usedOn={view.fills.filter((f) => f.fields.some((x) => x.key === selectedField.key)).map(formLabel)}
              choices={choicesFor(selectedField.key)}
              onReport={() => setReporting({ itemId: selectedField.itemId, fieldKeys: [selectedField.mapping.pdfField] })}
            />
          )}

          {replaced.map((item) => {
            const f = view.fills.find((x) => x.itemId === item.id);
            if (!f) return null;
            const name = formLabel(f);
            return (
              <section key={item.id} className="banner" role="alert" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 8 }}>
                <span className="t-callout">
                  <Icon name="warning" size={16} /> <strong>{name}:</strong> the account this draft used is no longer active. Pick one.
                </span>
                <Select aria-label={`Account for ${name}`} value={item.accountId ?? ''} onChange={(e) => setPacketAccount(item.id, e.target.value)}>
                  <option value="" disabled>
                    Choose account…
                  </option>
                  {client.accounts.map((a) => (
                    <option key={a.accountid} value={a.accountid}>
                      {a.name} · {a.ev_accountno}
                    </option>
                  ))}
                </Select>
                {item.accountId && (
                  <Button variant="plain" size="sm" onClick={() => setPacketAccount(item.id, item.accountId!)}>
                    Keep {client.accounts.find((a) => a.accountid === item.accountId)?.name}
                  </Button>
                )}
              </section>
            );
          })}

          {changedSince.length > 0 && (
            <section className="card card-pad stack-3" aria-labelledby="changed-h">
              <h2 id="changed-h" className="t-headline">Changed in Dynamics since you saved</h2>
              <p className="t-footnote c3">The forms show today’s values. Keep the value from when you saved if that’s what the client gave you.</p>
              {changedSince.map((c) => (
                <div key={c.key} className="stack" style={{ gap: 4 }}>
                  <span className="t-callout" style={{ fontWeight: 600 }}>{c.label}</span>
                  <span className="t-footnote c2">
                    Saved: {c.saved || '(empty)'} · Now: {c.now || '(empty)'}
                  </span>
                  <div className="row" style={{ gap: 6 }}>
                    <Button variant="gray" size="sm" onClick={() => settleChange(c.key, c.saved)}>
                      Keep saved
                    </Button>
                    <Button variant="plain" size="sm" onClick={() => settleChange(c.key, undefined)}>
                      Use new
                    </Button>
                  </div>
                </div>
              ))}
            </section>
          )}

          {fill && personBlocks([fill]).length > 0 && (
            <section className="card card-pad stack-3" aria-labelledby="people-h">
              <h2 id="people-h" className="t-headline">People on this form</h2>
              <p className="t-footnote c3">Fill a whole block from anyone related to {client.contact.firstname}, or clear it for someone new.</p>
              {personBlocks([fill]).map((block) => {
                const pick = packet.personBlocks?.[blockKey(block, fill)];
                const people = relatedPeople(client);
                return (
                  <div key={block} className="field">
                    <label htmlFor={`pb-${cssKey(block)}`}>{block}</label>
                    <Select id={`pb-${cssKey(block)}`} value="" onChange={(e) => e.target.value && pickPerson(block, e.target.value)}>
                      <option value="">{pick ? `${pick.name}${pick.role ? ` · ${pick.role}` : ''}` : 'As on the form · Fill from…'}</option>
                      {people.map((p, i) => (
                        <option key={`${p.contactId}-${p.role}`} value={String(i)}>
                          {p.name} · {p.role}
                        </option>
                      ))}
                      <option value="new">Someone new (clear the block)</option>
                      {pick && <option value="crm">Undo: as the form maps it</option>}
                    </Select>
                  </div>
                );
              })}
            </section>
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
                  <Icon name={showOptional ? 'chevronDown' : 'chevronRight'} size={14} />
                  {optionalNeeds.length} optional {optionalNeeds.length === 1 ? 'field' : 'fields'}
                </button>
                {showOptional && optionalNeeds.map((n) => renderNeed(n.key, n.fields))}
              </>
            )}
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
          </>
          )}
        </aside>
      </div>
      {sharing && canShare && <ShareSheet onClose={() => setSharing(false)} />}
      {blocked && <BlockersSheet title={blocked.title} blockers={blocked.blockers} fills={view.fills} onJump={(c) => focusKey(c.fieldKey, c.itemId ?? c.templateId)} onClose={() => setBlocked(undefined)} />}
      {reporting &&
        (() => {
          const at = view.fills.find((f) => f.itemId === reporting.itemId);
          if (!at) return null;
          return (
            <ReportProblemSheet
              template={at.template}
              fieldKeys={reporting.fieldKeys}
              otherForms={view.fills.filter((f) => f.itemId !== at.itemId).map((f) => f.template.formNumber)}
              accountType={at.account?.ev_accounttype}
              onClose={() => setReporting(undefined)}
            />
          );
        })()}
      {upgrade && (
        <UpgradeSheet
          report={upgrade}
          onClose={() => setUpgrade(undefined)}
          onUpdate={() => {
            setUpgrade(undefined);
            const done = upgradePacket().forms.filter((f) => f.state === 'newer').length;
            const now = useApp.getState().packet;
            setPacket({ resolved: { ...now.resolved, 'current-revisions': 'Updated to the current version. Entered values carried over.' } });
            toast.ok(`Updated ${done} ${done === 1 ? 'form' : 'forms'} to the current version.${canSaveDrafts && packet.requestId ? ' Save draft to keep it.' : ''}`);
          }}
        />
      )}
      {naming && (
        <NameSheet
          title="Save draft"
          noun="draft"
          initial={packet.title || defaultDraftTitle(view.fills)}
          existing={requests.filter((r) => r.status === 'Drafted' && r.contactId === contactId).map((r) => ({ id: r.id, name: r.title }))}
          saveLabel="Save draft"
          onSave={(title) => writeDraft(title)}
          replace={{ label: 'Update that draft', allowed: () => true, run: (c) => writeDraft(c.name, requests.find((r) => r.id === c.id)) }}
          onClose={() => setNaming(false)}
        >
          <p className="t-footnote c3">Saved to {client.contact.firstname}’s SharePoint folder. You can rename it later from Drafts.</p>
        </NameSheet>
      )}
    </>
  );
}

/** A field key made safe for an element id. */
const cssKey = (k: string) => k.replace(/[^a-zA-Z0-9_-]/g, '_');
/** The element id of a check's row in "Checks before send". */
const checkId = (id: string) => `check-${cssKey(id)}`;

/** Open items first (blocking, then warnings), then what passed. */
const rank = (c: CheckResult) => (c.level === 'block' ? 0 : c.level === 'warn' ? 1 : 2);
