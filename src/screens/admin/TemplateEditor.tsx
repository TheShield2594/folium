import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { isOpen, type FormFeedback } from '../../domain/feedback';
import { prettifyFieldName } from '../../domain/format';
import { parseIdSource } from '../../domain/idDocuments';
import { mappingWarnings, prefillForm } from '../../domain/prefill';
import { carryForward, diffRevision, type FieldChange } from '../../domain/revisions';
import { roleLabel } from '../../domain/signers';
import type { Check, ClientRecord, Contact, DateLayout, FieldFormat, FieldLimits, FieldMapping, FormTemplate, Placement, PlacementType, TemplateMapping } from '../../domain/types';
import { fillPdf } from '../../pdf/fill';
import { useServices } from '../../services';
import { Toolbar } from '../../shell/Shell';
import { useActingFor, useApp } from '../../state/store';
import { Badge, Button, Empty, Field, IconButton, Segmented, Select, Sheet, TextInput, downloadBytes, toast } from '../../ui/controls';
import { Icon } from '../../ui/Icon';
import { PdfView, useInspection } from '../common/PdfView';
import { STATUS_TONE } from './AdminTemplates';
import { ConditionSheet, describeConditions } from './ConditionSheet';
import { KNOWN_SOURCES, SOURCE_GROUPS, choiceWords } from './sources';
import { describeStates, parseStatesFromTitle } from '../../domain/states';
import { StatesPicker } from '../common/StatesPicker';

type Tab = 'fields' | 'signers' | 'checks' | 'details' | 'test';
const fieldRowId = (pdfField: string) => `map-${pdfField.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
const FORMATS: [FieldFormat | '', string][] = [
  ['', 'Text'],
  ['date', 'Date'],
  ['ssn', 'SSN'],
  ['ssnLast4', 'SSN last 4'],
  ['ein', 'EIN'],
  ['ssnOrTin', 'SSN or EIN'],
  ['phone', 'Phone'],
  ['zip', 'ZIP'],
  ['email', 'Email'],
  ['currency', 'Currency'],
  ['percent', 'Percent'],
  ['integer', 'Whole number'],
  ['decimal', 'Decimal'],
  ['checkbox', 'Checkbox'],
];
const CHANGE_TONE: Record<FieldChange, 'accent' | 'warn' | 'info' | 'danger' | undefined> = { unchanged: undefined, new: 'warn', renamed: 'info', removed: 'danger' };

export function TemplateEditor() {
  const { id } = useParams();
  const templates = useApp((s) => s.templates);
  const refreshTemplates = useApp((s) => s.refreshTemplates);
  const services = useServices();
  const navigate = useNavigate();
  const template = templates.find((t) => t.id === id);
  const previous = template?.supersedesId ? templates.find((t) => t.id === template.supersedesId) : undefined;
  const info = useInspection(template);

  const [mapping, setMapping] = useState<TemplateMapping>();
  const [tab, setTab] = useState<Tab>('fields');
  const [sel, setSel] = useState<string>();
  const [selPlacement, setSelPlacement] = useState<number>();
  const [placing, setPlacing] = useState<{ role: string; type: PlacementType } | 'overlay'>();
  const [busy, setBusy] = useState<string>();
  const [publishing, setPublishing] = useState(false);
  const [filter, setFilter] = useState<'all' | 'attention'>('all');
  const [limitsFor, setLimitsFor] = useState<string>();
  const [conditionsFor, setConditionsFor] = useState<string>();
  const [optionsFor, setOptionsFor] = useState<string>();
  /** `?field=` (from Form feedback): open with that field selected. */
  const [params] = useSearchParams();
  const focusField = params.get('field') ?? undefined;
  /** Open problem reports on this revision. */
  const [problems, setProblems] = useState<FormFeedback[]>([]);
  useEffect(() => {
    if (!id) return;
    let live = true;
    services.feedback
      .list()
      .then((all) => live && setProblems(all.filter((f) => f.kind === 'problem' && f.templateId === id && isOpen(f))))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [id, services]);

  // Load the mapping when the editor opens a template, not on every refresh of the
  // template list, so a refresh from elsewhere never throws away unsaved edits.
  const templateId = template?.id;
  useEffect(() => {
    const t = useApp.getState().templates.find((x) => x.id === templateId);
    if (t) setMapping(structuredClone(t.mapping));
  }, [templateId]);

  // Land on the reported field: Fields tab, every field shown, the row selected and in view.
  const mappingReady = !!mapping;
  useEffect(() => {
    if (!focusField || !mappingReady) return;
    setTab('fields');
    setFilter('all');
    setSel(focusField);
    requestAnimationFrame(() => document.getElementById(fieldRowId(focusField))?.scrollIntoView({ block: 'center' }));
  }, [focusField, mappingReady]);

  // Diff the PDF's actual fields against the previous revision's mapping.
  const diff = useMemo(() => {
    if (!info || !template) return undefined;
    const names = template.pdfKind === 'fillable' ? info.fields.map((f) => f.name) : (mapping?.fields ?? []).map((f) => f.pdfField);
    return diffRevision(previous?.mapping ?? (template.mapping.fields.length ? template.mapping : undefined), names);
  }, [info, template, previous, mapping?.fields]);

  if (!template || !mapping) {
    return (
      <>
        <Toolbar title="Template" back={{ label: 'Library', to: '/admin/templates' }} />
        <div className="scroll">
          <Empty icon="folder" title="Template not found" />
        </div>
      </>
    );
  }

  const dirty = JSON.stringify(mapping) !== JSON.stringify(template.mapping);
  const pdfNames = new Set(info?.fields.map((f) => f.name) ?? []);
  const unmappedInPdf = template.pdfKind === 'fillable' ? (info?.fields ?? []).filter((f) => !mapping.fields.some((m) => m.pdfField === f.name)) : [];
  const stale = template.pdfKind === 'fillable' && info ? mapping.fields.filter((m) => !pdfNames.has(m.pdfField)) : [];
  const keyWarnings = mappingWarnings(mapping);
  const changeOf = (name: string) => diff?.find((d) => d.pdfField === name);
  const needsAttention = (m: FieldMapping) => (changeOf(m.pdfField)?.change ?? 'unchanged') !== 'unchanged' || !m.source;

  const pdfTypeOf = (name: string) => info?.fields.find((f) => f.name === name)?.type;

  function patchField(name: string, patch: Partial<FieldMapping>) {
    setMapping((m) => m && { ...m, fields: m.fields.map((f) => (f.pdfField === name ? { ...f, ...patch } : f)) });
  }

  function carryOver() {
    if (!diff) return;
    const next = carryForward(previous?.mapping, diff, template!.revision, template!.formNumber);
    setMapping({ ...next, placements: mapping!.placements.length ? mapping!.placements : next.placements });
    const n = diff.filter((d) => d.change === 'unchanged' || d.change === 'renamed').length;
    toast.ok(`Carried over ${n} mappings. ${diff.filter((d) => d.change === 'new').length} new fields need a source.`);
  }

  function addUnmapped() {
    setMapping((m) => m && { ...m, fields: [...m.fields, ...unmappedInPdf.map((f): FieldMapping => ({ pdfField: f.name, source: 'advisor', required: false, label: prettifyFieldName(f.name), format: f.type === 'checkbox' ? 'checkbox' : undefined, limits: f.maxLength ? { maxLength: f.maxLength } : undefined }))] });
  }

  async function save(status?: FormTemplate['status'], effectiveDate?: string) {
    setBusy('save');
    try {
      await services.templates.saveMapping(template!.id, { ...mapping!, revision: template!.revision, formNumber: template!.formNumber });
      if (status) await services.templates.setStatus(template!.id, status, effectiveDate);
      await refreshTemplates();
      toast.ok(status === 'Live' ? (effectiveDate && effectiveDate > new Date().toISOString().slice(0, 10) ? `Scheduled for ${new Date(effectiveDate + 'T00:00').toLocaleDateString()}` : 'Published. Advisors see it now.') : 'Mapping saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(undefined);
    }
  }

  function onPageClick(page: number, x: number, y: number) {
    if (!placing) return;
    if (placing === 'overlay') {
      const n = mapping!.fields.filter((f) => f.pdfField.startsWith('Overlay_')).length + 1;
      const name = `Overlay_${n}`;
      setMapping({ ...mapping!, fields: [...mapping!.fields, { pdfField: name, source: 'advisor', required: false, label: `Overlay field ${n}`, rect: { page, x: Math.round(x), y: Math.round(y - 8), width: 160, height: 16 } }] });
      setSel(name);
    } else {
      const p: Placement = { role: placing.role, type: placing.type, page, x: Math.round(x), y: Math.round(y - 12) };
      setMapping({ ...mapping!, placements: [...mapping!.placements, p] });
      setSelPlacement(mapping!.placements.length);
    }
    setPlacing(undefined);
  }

  const fieldsForPreview = mapping.fields.map((m) => ({
    templateId: template.id,
    itemId: template.id,
    mapping: m,
    key: m.pdfField,
    label: m.label ?? m.pdfField,
    value: '',
    display: m.source === 'signer' ? '' : m.label ?? m.pdfField,
    origin: (m.source === 'signer' ? 'signer' : needsAttention(m) ? 'missing' : 'crm') as 'signer' | 'missing' | 'crm',
    sourceLabel: m.source,
    required: m.required,
    missing: needsAttention(m),
    locked: false,
  }));
  const shownFields = mapping.fields.filter((m) => filter === 'all' || needsAttention(m));

  return (
    <>
      <Toolbar title={`${template.formNumber} · Rev ${template.revision}`} subtitle={template.name} back={{ label: 'Library', to: '/admin/templates' }}>
        <Badge tone={STATUS_TONE[template.status]}>{template.status}</Badge>
        {problems.length > 0 && (
          <Button variant="tinted" size="sm" icon="flag" onClick={() => navigate(`/admin/feedback?form=${encodeURIComponent(template.formNumber)}`)}>
            {problems.length} open {problems.length === 1 ? 'problem' : 'problems'}
          </Button>
        )}
        <Button variant="gray" disabled={!dirty} busy={busy === 'save'} onClick={() => save()}>
          Save
        </Button>
        <Button variant="filled" icon="checkCircle" disabled={!mapping.fields.length} onClick={() => setPublishing(true)}>
          Publish…
        </Button>
      </Toolbar>
      <div className="scroll">
        <div className="page stack-5" style={{ maxWidth: 1480 }}>
          {template.pdfKind !== 'fillable' && (
            <div className="banner">
              <Icon name="warning" size={18} />
              <span className="grow">
                <strong>{template.pdfKind === 'xfa' ? 'XFA form.' : 'Scanned PDF.'}</strong> It has no fillable fields, so Folium draws values on top. Add overlay fields where values go.
              </span>
              <Button variant="tinted" size="sm" icon="plus" onClick={() => (setTab('fields'), setPlacing('overlay'))}>
                Add overlay field
              </Button>
            </div>
          )}
          {previous && diff && template.mapping.fields.length === 0 && mapping.fields.length === 0 && (
            <div className="banner info">
              <Icon name="sparkle" size={18} />
              <span className="grow">
                Compared with Rev {previous.revision}: <strong>{diff.filter((d) => d.change === 'unchanged').length} unchanged</strong>, {diff.filter((d) => d.change === 'renamed').length} renamed, {diff.filter((d) => d.change === 'new').length} new,{' '}
                {diff.filter((d) => d.change === 'removed').length} removed.
              </span>
              <Button variant="filled" size="sm" onClick={carryOver}>
                Carry over mappings
              </Button>
            </div>
          )}
          {template.pdfKind === 'fillable' && mapping.fields.length === 0 && !previous && info && (
            <div className="banner info">
              <Icon name="info" size={18} />
              <span className="grow">This PDF has {info.fields.length} fillable fields and none are mapped yet.</span>
              <Button variant="filled" size="sm" onClick={addUnmapped}>
                Add all fields
              </Button>
            </div>
          )}

          <div className="row wrap" style={{ justifyContent: 'space-between' }}>
            <Segmented
              label="Section"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'fields', label: `Fields (${mapping.fields.length})` },
                { value: 'signers', label: `Signers & tabs (${mapping.placements.length})` },
                { value: 'checks', label: `Checks (${mapping.checks.length})` },
                { value: 'details', label: template.states?.length ? `States (${template.states.length})` : 'States' },
                { value: 'test', label: 'Test with a contact' },
              ]}
            />
            {placing && (
              <div className="banner info" style={{ padding: '6px 12px' }}>
                <Icon name="target" size={16} />
                Click the page where the {placing === 'overlay' ? 'field' : placing.type === 'signature' ? 'signature' : placing.type} goes.
                <Button variant="plain" size="sm" onClick={() => setPlacing(undefined)}>
                  Cancel
                </Button>
              </div>
            )}
          </div>

          <div className="editor">
            <div className="stack-4" style={{ minWidth: 0 }}>
              {tab === 'fields' && (
                <section className="card" aria-label="Field mapping">
                  <div className="row wrap" style={{ padding: '14px 16px', gap: 10 }}>
                    <Segmented
                      label="Show"
                      value={filter}
                      onChange={setFilter}
                      options={[
                        { value: 'all', label: 'All' },
                        { value: 'attention', label: `Needs attention (${mapping.fields.filter(needsAttention).length})` },
                      ]}
                    />
                    <span className="spacer" />
                    {unmappedInPdf.length > 0 && (
                      <Button variant="tinted" size="sm" icon="plus" onClick={addUnmapped}>
                        Add {unmappedInPdf.length} unmapped PDF {unmappedInPdf.length === 1 ? 'field' : 'fields'}
                      </Button>
                    )}
                  </div>
                  {stale.length > 0 && (
                    <div className="banner" style={{ margin: '0 16px 12px' }}>
                      <Icon name="warning" size={16} />
                      <span className="t-footnote">
                        {stale.length} mapped {stale.length === 1 ? 'field isn’t' : 'fields aren’t'} in this PDF: {stale.map((s) => s.pdfField).join(', ')}
                      </span>
                      <Button variant="plain" size="sm" onClick={() => setMapping({ ...mapping, fields: mapping.fields.filter((f) => !stale.includes(f)) })}>
                        Remove
                      </Button>
                    </div>
                  )}
                  {keyWarnings.map((w) => (
                    <div key={w} className="banner" style={{ margin: '0 16px 12px' }}>
                      <Icon name="warning" size={16} />
                      <span className="t-footnote">{w}</span>
                    </div>
                  ))}
                  <div style={{ overflowX: 'auto' }}>
                    <table className="table mapping" style={{ minWidth: 900 }}>
                      <thead>
                        <tr>
                          <th>PDF field</th>
                          <th>Label in Folium</th>
                          <th>Fill from</th>
                          <th>Format</th>
                          <th>Required</th>
                          <th>Conditions</th>
                          <th aria-label="Remove" />
                        </tr>
                      </thead>
                      <tbody>
                        {shownFields.map((m) => {
                          const ch = changeOf(m.pdfField);
                          const custom = !KNOWN_SOURCES.has(m.source);
                          return (
                            <tr key={m.pdfField} id={fieldRowId(m.pdfField)} className={sel === m.pdfField ? 'sel' : undefined} onClick={() => setSel(m.pdfField)}>
                              <td>
                                <div className="mono t-footnote">{m.pdfField}</div>
                                {ch && ch.change !== 'unchanged' && (
                                  <Badge tone={CHANGE_TONE[ch.change]}>{ch.change === 'renamed' ? `renamed from ${ch.previousName}` : ch.change}</Badge>
                                )}
                                {problems.some((p) => p.fieldKeys?.includes(m.pdfField)) && <Badge tone="danger">reported</Badge>}
                              </td>
                              <td>
                                <TextInput aria-label={`Label for ${m.pdfField}`} value={m.label ?? ''} placeholder={prettifyFieldName(m.pdfField)} onChange={(e) => patchField(m.pdfField, { label: e.target.value || undefined })} />
                              </td>
                              <td style={{ minWidth: 220 }}>
                                <Select aria-label={`Source for ${m.pdfField}`} value={custom ? '__custom' : m.source} onChange={(e) => {
                                    const source = e.target.value === '__custom' ? 'contact.' : e.target.value;
                                    // ID dates come with their format, unless one is already set.
                                    const idFormat = parseIdSource(source)?.field.format;
                                    patchField(m.pdfField, { source, ...(idFormat && !m.format ? { format: idFormat } : {}) });
                                  }}>
                                  {SOURCE_GROUPS.map((g) => (
                                    <optgroup key={g.label} label={g.label}>
                                      {g.options.map(([v, l]) => (
                                        <option key={v} value={v}>
                                          {l}
                                        </option>
                                      ))}
                                    </optgroup>
                                  ))}
                                  <option value="__custom">Custom Dataverse path…</option>
                                </Select>
                                {custom && <TextInput aria-label="Custom path" className="mono" style={{ marginTop: 4 }} value={m.source} onChange={(e) => patchField(m.pdfField, { source: e.target.value })} />}
                              </td>
                              <td>
                                <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                                  <Select aria-label={`Format for ${m.pdfField}`} value={m.format ?? ''} onChange={(e) => patchField(m.pdfField, { format: (e.target.value || undefined) as FieldFormat | undefined })}>
                                    {FORMATS.map(([f, label]) => (
                                      <option key={f} value={f}>
                                        {label}
                                      </option>
                                    ))}
                                  </Select>
                                  {m.format !== 'checkbox' && (
                                    <IconButton
                                      icon="sliders"
                                      size={15}
                                      label={`Limits for ${m.pdfField}${describeLimits(m.limits) ? `: ${describeLimits(m.limits)}` : ''}`}
                                      pressed={!!describeLimits(m.limits)}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setLimitsFor(m.pdfField);
                                      }}
                                    />
                                  )}
                                </div>
                                {describeLimits(m.limits) && <div className="t-footnote c3" style={{ marginTop: 2 }}>{describeLimits(m.limits)}</div>}
                                {(m.format === 'checkbox' || pdfTypeOf(m.pdfField) === 'checkbox') && m.source !== 'signer' && (
                                  <>
                                    <TextInput
                                      aria-label={`${m.pdfField} checked when`}
                                      list={`cw-${m.pdfField}`}
                                      style={{ marginTop: 4 }}
                                      value={m.checkedWhen ?? ''}
                                      placeholder="Checked when… (Yes)"
                                      onChange={(e) => patchField(m.pdfField, { checkedWhen: e.target.value.trim() || undefined })}
                                    />
                                    <datalist id={`cw-${m.pdfField}`}>
                                      {choiceWords(m.source).map((w) => (
                                        <option key={w} value={w} />
                                      ))}
                                    </datalist>
                                  </>
                                )}
                                {pdfTypeOf(m.pdfField) === 'radio' && (
                                  <Button
                                    variant="plain"
                                    size="sm"
                                    icon={m.options ? 'pencil' : 'plus'}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setOptionsFor(m.pdfField);
                                    }}
                                  >
                                    {m.options ? `${Object.keys(m.options).length} options` : 'Option for each value'}
                                  </Button>
                                )}
                              </td>
                              <td>
                                {m.requiredWhen?.trim() ? (
                                  <span className="t-footnote c3">When…</span>
                                ) : (
                                  <input type="checkbox" className="check" aria-label={`${m.pdfField} required`} checked={m.required} onChange={(e) => patchField(m.pdfField, { required: e.target.checked })} />
                                )}
                              </td>
                              <td style={{ minWidth: 180 }}>
                                {describeConditions(m, mapping).map((c) => (
                                  <div key={c} className="t-footnote c2" style={{ marginBottom: 2 }}>
                                    {c}
                                  </div>
                                ))}
                                <Button
                                  variant="plain"
                                  size="sm"
                                  icon={m.requiredWhen || m.lockWhen ? 'pencil' : 'plus'}
                                  aria-label={`Conditions for ${m.pdfField}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setConditionsFor(m.pdfField);
                                  }}
                                >
                                  {m.requiredWhen || m.lockWhen ? 'Edit' : 'Add'}
                                </Button>
                              </td>
                              <td>
                                <IconButton icon="trash" size={15} label={`Remove ${m.pdfField}`} onClick={() => setMapping({ ...mapping, fields: mapping.fields.filter((f) => f.pdfField !== m.pdfField) })} />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p className="t-footnote c3" style={{ padding: '10px 16px 16px' }}>
                    Fields with the same Dataverse source share one value across a packet. Advisor fields with matching labels on different forms can share a value through the field key.
                  </p>
                </section>
              )}

              {tab === 'signers' && <SignersTab mapping={mapping} setMapping={setMapping} sel={selPlacement} setSel={setSelPlacement} onPlace={setPlacing} />}
              {tab === 'checks' && <ChecksTab mapping={mapping} setMapping={setMapping} />}
              {tab === 'details' && <DetailsTab template={template} templates={templates} onSaved={refreshTemplates} />}
              {tab === 'test' && <TestTab template={{ ...template, mapping }} />}
            </div>

            {tab !== 'test' && tab !== 'details' && (
              <div className="card sticky" style={{ padding: 12, background: 'var(--surface-sunken)', maxHeight: 'calc(100vh - 140px)', overflow: 'auto' }}>
                <PdfView
                  template={template}
                  width={420}
                  fields={tab === 'fields' ? fieldsForPreview : []}
                  placements={tab === 'signers' ? mapping.placements : []}
                  activeKey={sel}
                  maskSensitive={false}
                  onFieldClick={(f) => setSel(f.mapping.pdfField)}
                  onPageClick={placing ? onPageClick : undefined}
                  onPlacementClick={setSelPlacement}
                  selectedPlacement={selPlacement}
                />
              </div>
            )}
          </div>
        </div>
      </div>
      {limitsFor && mapping.fields.some((f) => f.pdfField === limitsFor) && (
        <LimitsSheet
          field={mapping.fields.find((f) => f.pdfField === limitsFor)!}
          pdfMaxLength={info?.fields.find((f) => f.name === limitsFor)?.maxLength}
          onChange={(limits) => patchField(limitsFor, { limits })}
          onClose={() => setLimitsFor(undefined)}
        />
      )}
      {conditionsFor && mapping.fields.some((f) => f.pdfField === conditionsFor) && (
        <ConditionSheet field={mapping.fields.find((f) => f.pdfField === conditionsFor)!} mapping={mapping} onChange={(patch) => patchField(conditionsFor, patch)} onClose={() => setConditionsFor(undefined)} />
      )}
      {optionsFor && mapping.fields.some((f) => f.pdfField === optionsFor) && (
        <OptionsSheet
          field={mapping.fields.find((f) => f.pdfField === optionsFor)!}
          pdfOptions={info?.fields.find((f) => f.name === optionsFor)?.options ?? []}
          onChange={(options) => patchField(optionsFor, { options })}
          onClose={() => setOptionsFor(undefined)}
        />
      )}
      {publishing && (
        <PublishSheet
          template={{ ...template, mapping }}
          onClose={() => setPublishing(false)}
          onPublish={async (date) => {
            await save('Live', date);
            setPublishing(false);
            navigate('/admin/templates');
          }}
        />
      )}
    </>
  );
}

function SignersTab({ mapping, setMapping, sel, setSel, onPlace }: { mapping: TemplateMapping; setMapping: (m: TemplateMapping) => void; sel?: number; setSel: (i?: number) => void; onPlace: (p: { role: string; type: PlacementType }) => void }) {
  const [role, setRole] = useState(mapping.signers[0]?.role ?? 'Owner');
  const [type, setType] = useState<PlacementType>('signature');
  const roles = [...new Set(['Owner', 'JointOwner', 'SpouseConsent', 'Insured', 'Advisor', ...mapping.signers.map((s) => s.role)])];
  return (
    <>
      <section className="card card-pad stack-3" aria-labelledby="sr-h">
        <h2 id="sr-h" className="t-title3">Who signs</h2>
        {mapping.signers.map((s, i) => (
          <div key={i} className="row wrap">
            <Select aria-label="Role" value={s.role} onChange={(e) => setMapping({ ...mapping, signers: mapping.signers.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)) })} style={{ width: 180 }}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </Select>
            <TextInput aria-label="Only when" className="mono grow" placeholder="Always (or a condition, e.g. contact.familystatuscode == married)" value={s.condition ?? ''} onChange={(e) => setMapping({ ...mapping, signers: mapping.signers.map((x, j) => (j === i ? { ...x, condition: e.target.value || undefined } : x)) })} />
            <IconButton icon="trash" size={15} label="Remove signer" onClick={() => setMapping({ ...mapping, signers: mapping.signers.filter((_, j) => j !== i) })} />
          </div>
        ))}
        <div>
          <Button variant="plain" size="sm" icon="plus" onClick={() => setMapping({ ...mapping, signers: [...mapping.signers, { role: 'JointOwner' }] })}>
            Add signer
          </Button>
        </div>
      </section>
      <section className="card card-pad stack-3" aria-labelledby="pl-h">
        <h2 id="pl-h" className="t-title3">Signature tabs</h2>
        <p className="t-footnote c3">Placed by page and position, never DocuSign anchor text, so switching e-signature vendors doesn’t mean remapping.</p>
        <div className="row wrap">
          <Select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)} style={{ width: 170 }}>
            {mapping.signers.map((s) => (
              <option key={s.role} value={s.role}>
                {roleLabel(s.role)}
              </option>
            ))}
          </Select>
          <Select aria-label="Tab type" value={type} onChange={(e) => setType(e.target.value as PlacementType)} style={{ width: 150 }}>
            <option value="signature">Signature</option>
            <option value="initials">Initials</option>
            <option value="dateSigned">Date signed</option>
            <option value="text">Text</option>
            <option value="checkbox">Checkbox</option>
          </Select>
          <Button variant="tinted" icon="target" onClick={() => onPlace({ role, type })}>
            Place on page
          </Button>
        </div>
        <div className="list">
          {mapping.placements.map((p, i) => (
            <div key={i} className="list-row" aria-selected={sel === i} onClick={() => setSel(i)} style={{ cursor: 'pointer' }}>
              <Icon name={p.type === 'signature' ? 'signature' : p.type === 'dateSigned' ? 'calendar' : 'pencil'} size={16} className="c3" />
              <span className="grow">
                {roleLabel(p.role)} · {p.type === 'dateSigned' ? 'date signed' : p.type}
              </span>
              <span className="t-footnote c3 mono">
                p{p.page} · {p.x},{p.y}
              </span>
              <label className="row t-footnote" style={{ gap: 4 }}>
                <input type="checkbox" className="check" style={{ width: 16, height: 16 }} checked={!!p.optional} onChange={(e) => setMapping({ ...mapping, placements: mapping.placements.map((x, j) => (j === i ? { ...x, optional: e.target.checked } : x)) })} />
                Optional
              </label>
              <IconButton icon="trash" size={15} label="Remove tab" onClick={() => setMapping({ ...mapping, placements: mapping.placements.filter((_, j) => j !== i) })} />
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function ChecksTab({ mapping, setMapping }: { mapping: TemplateMapping; setMapping: (m: TemplateMapping) => void }) {
  const [type, setType] = useState<Check['type']>('sumEquals');
  const [picked, setPicked] = useState<string[]>([]);
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('100');
  const [when, setWhen] = useState('');
  const fields = mapping.fields.map((f) => f.pdfField);

  function add() {
    let c: Check;
    if (type === 'sumEquals') c = { type, fields: picked, value: Number(value), label: label || undefined };
    else if (type === 'oneOf') c = { type, fields: picked, label: label || undefined };
    else if (type === 'requiredIf') c = { type, field: picked[0], when, label: label || undefined };
    else c = { type, field: picked[0], pattern: value, label: label || undefined };
    setMapping({ ...mapping, checks: [...mapping.checks, c] });
    setPicked([]);
    setLabel('');
  }

  const describe = (c: Check) =>
    c.type === 'sumEquals' ? `${c.fields.join(' + ')} = ${c.value}` : c.type === 'oneOf' ? `exactly one of ${c.fields.join(', ')}` : c.type === 'requiredIf' ? `${c.field} required when ${c.when}` : `${c.field} matches /${c.pattern}/`;

  return (
    <>
      <section className="card card-pad stack-3">
        <h2 className="t-title3">Pre-send checks</h2>
        <p className="t-footnote c3">Rules that catch “not in good order” forms before they go out. Required fields and formats are checked automatically.</p>
        {mapping.checks.length === 0 ? (
          <p className="t-callout c3">No form-specific checks.</p>
        ) : (
          <div className="list">
            {mapping.checks.map((c, i) => (
              <div key={i} className="list-row">
                <Icon name="checkCircle" size={16} className="c-accent" />
                <span className="grow">
                  <span style={{ display: 'block', fontWeight: 600 }}>{c.label ?? c.type}</span>
                  <span className="t-footnote c3 mono">{describe(c)}</span>
                </span>
                <IconButton icon="trash" size={15} label="Remove check" onClick={() => setMapping({ ...mapping, checks: mapping.checks.filter((_, j) => j !== i) })} />
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="card card-pad stack-3">
        <h2 className="t-headline">Add a check</h2>
        <div className="grid-2">
          <Field label="Rule" htmlFor="ck-type">
            <Select id="ck-type" value={type} onChange={(e) => setType(e.target.value as Check['type'])}>
              <option value="sumEquals">Fields add up to</option>
              <option value="oneOf">Exactly one is checked</option>
              <option value="requiredIf">Required when</option>
              <option value="pattern">Matches a pattern</option>
            </Select>
          </Field>
          <Field label="Message advisors see" htmlFor="ck-label">
            <TextInput id="ck-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Shares must total 100%" />
          </Field>
          <div className="span-2">
            <Field label={type === 'sumEquals' || type === 'oneOf' ? 'Fields' : 'Field'} htmlFor="ck-fields">
              <select id="ck-fields" className="select" multiple={type === 'sumEquals' || type === 'oneOf'} size={type === 'sumEquals' || type === 'oneOf' ? 6 : undefined} value={type === 'sumEquals' || type === 'oneOf' ? picked : picked[0] ?? ''} onChange={(e) => setPicked([...e.target.selectedOptions].map((o) => o.value))} style={{ backgroundImage: type === 'sumEquals' || type === 'oneOf' ? 'none' : undefined }}>
                {!(type === 'sumEquals' || type === 'oneOf') && <option value="">Choose…</option>}
                {fields.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {(type === 'sumEquals' || type === 'pattern') && (
            <Field label={type === 'sumEquals' ? 'Total' : 'Regular expression'} htmlFor="ck-val">
              <TextInput id="ck-val" className="mono" value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
          )}
          {type === 'requiredIf' && (
            <Field label="When" htmlFor="ck-when">
              <TextInput id="ck-when" className="mono" value={when} onChange={(e) => setWhen(e.target.value)} placeholder="contact.familystatuscode == married" />
            </Field>
          )}
        </div>
        <div>
          <Button variant="tinted" icon="plus" disabled={!picked.length || (type === 'requiredIf' && !when)} onClick={add}>
            Add check
          </Button>
        </div>
      </section>
    </>
  );
}

function TestTab({ template }: { template: FormTemplate }) {
  const services = useServices();
  const advisor = useActingFor();
  const firm = useApp((s) => s.firm);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [cid, setCid] = useState('');
  const [client, setClient] = useState<ClientRecord>();

  useEffect(() => {
    services.crm.recentContacts().then((l) => {
      setContacts(l);
      setCid(l[0]?.contactid ?? '');
    });
  }, [services]);
  useEffect(() => {
    if (cid) services.crm.getClient(cid).then(setClient);
  }, [cid, services]);

  const fill = useMemo(() => {
    if (!client || !advisor) return undefined;
    const account = client.accounts.find((a) => template.appliesTo?.includes(a.ev_accounttype)) ?? client.accounts[0];
    return prefillForm(template, { client, advisor, firm, account }, {});
  }, [client, advisor, firm, template]);
  const conditional = fill?.fields.filter((f) => f.mapping.requiredWhen?.trim() || f.mapping.lockWhen?.trim()) ?? [];

  return (
    <section className="card card-pad stack-4" style={{ gridColumn: '1 / -1' }}>
      <div className="row wrap">
        <h2 className="t-title3 grow">Test with a contact</h2>
        <Select aria-label="Contact" value={cid} onChange={(e) => setCid(e.target.value)} style={{ width: 260 }}>
          {contacts.map((c) => (
            <option key={c.contactid} value={c.contactid}>
              {c.fullname} · {c.ev_clientid}
            </option>
          ))}
        </Select>
        <Button
          variant="gray"
          icon="download"
          disabled={!fill}
          onClick={async () => {
            const { pdf, unknownFields } = await fillPdf(await services.templates.getPdf(template), fill!.fields, { kind: template.pdfKind });
            downloadBytes(pdf, `${template.formNumber} test fill.pdf`);
            if (unknownFields.length) toast.error(`${unknownFields.length} mapped fields aren’t in the PDF: ${unknownFields.join(', ')}`);
          }}
        >
          Download test fill
        </Button>
      </div>
      {fill && (
        <>
          <div className="stat-tiles">
            <div className="stat">
              <b>{fill.filledCount}</b>
              <span>filled from CRM</span>
            </div>
            <div className="stat">
              <b className={fill.missingCount ? 'c-warn' : undefined}>{fill.missingCount}</b>
              <span>required and missing</span>
            </div>
            <div className="stat">
              <b>{fill.fields.filter((f) => f.origin === 'signer').length}</b>
              <span>left for the signer</span>
            </div>
            <div className="stat">
              <b>{fill.fields.filter((f) => f.locked).length}</b>
              <span>locked for this contact</span>
            </div>
          </div>
          {conditional.length > 0 && (
            <div className="list" aria-label="Conditional fields for this contact">
              {conditional.map((f) => (
                <div key={f.mapping.pdfField} className="list-row">
                  <Icon name={f.locked ? 'lock' : f.required ? 'warning' : 'checkCircle'} size={16} className={f.locked ? 'c3' : f.required ? 'c-warn' : 'c-accent'} />
                  <span className="grow">
                    <span style={{ display: 'block', fontWeight: 600 }}>{f.label}</span>
                    <span className="t-footnote c3">{describeConditions(f.mapping, template.mapping).join(' · ')}</span>
                  </span>
                  <Badge tone={f.locked ? undefined : f.required ? 'warn' : 'accent'}>{f.locked ? 'Locked' : f.required ? 'Required' : 'Open'}</Badge>
                </div>
              ))}
            </div>
          )}
          <div style={{ background: 'var(--surface-sunken)', borderRadius: 12, padding: 16 }}>
            <PdfView template={template} fields={fill.fields} placements={template.mapping.placements} width={720} />
          </div>
        </>
      )}
    </section>
  );
}

function PublishSheet({ template, onClose, onPublish }: { template: FormTemplate; onClose: () => void; onPublish: (date: string) => Promise<void> }) {
  const today = new Date().toISOString().slice(0, 10);
  const [when, setWhen] = useState<'now' | 'date'>(template.effectiveDate > today ? 'date' : 'now');
  const [date, setDate] = useState(template.effectiveDate > today ? template.effectiveDate : today);
  const [busy, setBusy] = useState(false);
  const missingSigners = template.mapping.placements.length === 0;
  return (
    <Sheet
      title={`Publish ${template.formNumber} Rev ${template.revision}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="filled" busy={busy} onClick={async () => (setBusy(true), await onPublish(when === 'now' ? today : date))}>
            {when === 'now' ? 'Publish now' : 'Schedule'}
          </Button>
        </>
      }
    >
      <div className="stack-4">
        <div className="list">
          <label className="list-row" style={{ cursor: 'pointer' }}>
            <input type="radio" name="when" checked={when === 'now'} onChange={() => setWhen('now')} className="check" />
            <span className="grow">
              <span style={{ display: 'block', fontWeight: 600 }}>Now</span>
              <span className="t-footnote c3">Advisors get this revision right away. Earlier revisions retire.</span>
            </span>
          </label>
          <label className="list-row" style={{ cursor: 'pointer' }}>
            <input type="radio" name="when" checked={when === 'date'} onChange={() => setWhen('date')} className="check" />
            <span className="grow">
              <span style={{ display: 'block', fontWeight: 600 }}>On its effective date</span>
              <span className="t-footnote c3">The current revision stays in use until then; advisors see “new revision” on it.</span>
            </span>
            <TextInput type="date" aria-label="Effective date" value={date} min={today} onChange={(e) => (setDate(e.target.value), setWhen('date'))} style={{ width: 170 }} />
          </label>
        </div>
        {missingSigners && (
          <div className="banner">
            <Icon name="warning" size={18} />
            No signature tabs are placed. Signers won’t have anywhere to sign in DocuSign.
          </div>
        )}
      </div>
    </Sheet>
  );
}

const NUMERIC: (FieldFormat | undefined)[] = ['integer', 'decimal', 'currency', 'percent'];

/** One line summing up a field's limits, for the Fields table. */
function describeLimits(l: FieldLimits | undefined): string {
  if (!l) return '';
  const parts: string[] = [];
  if (l.min !== undefined || l.max !== undefined) parts.push(`${l.min ?? '…'}–${l.max ?? '…'}`);
  if (l.minLength || l.maxLength) parts.push(l.minLength ? `${l.minLength}–${l.maxLength ?? '…'} chars` : `≤ ${l.maxLength} chars`);
  if (l.dateMin || l.dateMax) parts.push(`${l.dateMin ?? '…'} to ${l.dateMax ?? '…'}`);
  if (l.dateLayout) parts.push(l.dateLayout);
  return parts.join(' · ');
}

/** Drop empty entries so a template with no limits saves without a `limits` key. */
function cleanLimits(l: FieldLimits): FieldLimits | undefined {
  const out = Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined && v !== '' && !Number.isNaN(v))) as FieldLimits;
  return Object.keys(out).length ? out : undefined;
}

/**
 * A number box for a limit. What the admin types stays on screen (including a lone "-"
 * on the way to a negative); only a finite number, or an empty box, is saved.
 */
function LimitNumber({ id, value, mode, onCommit }: { id: string; value: number | undefined; mode: 'decimal' | 'count'; onCommit: (v: number | undefined) => void }) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  // Follow outside changes (Clear limits, "Use the PDF's limit") without fighting the typing.
  useEffect(() => {
    setText((t) => (parseLimit(t, mode) === value ? t : value === undefined ? '' : String(value)));
  }, [value, mode]);
  const parsed = parseLimit(text, mode);
  const invalid = text.trim() !== '' && parsed === undefined;
  return (
    <>
      <TextInput
        id={id}
        inputMode={mode === 'count' ? 'numeric' : 'decimal'}
        value={text}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          setText(e.target.value);
          const v = parseLimit(e.target.value, mode);
          if (e.target.value.trim() === '' || v !== undefined) onCommit(v);
        }}
      />
      {invalid && <span className="err">{mode === 'count' ? 'Enter a whole number of characters.' : 'Enter a number.'}</span>}
    </>
  );
}

function parseLimit(text: string, mode: 'decimal' | 'count'): number | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n)) return undefined;
  return mode === 'count' && (!Number.isInteger(n) || n < 0) ? undefined : n;
}

function LimitsSheet({ field, pdfMaxLength, onChange, onClose }: { field: FieldMapping; pdfMaxLength?: number; onChange: (l: FieldLimits | undefined) => void; onClose: () => void }) {
  const l = field.limits ?? {};
  const set = (patch: Partial<FieldLimits>) => onChange(cleanLimits({ ...l, ...patch }));
  const numeric = NUMERIC.includes(field.format);
  return (
    <Sheet
      title={`Limits · ${field.label ?? prettifyFieldName(field.pdfField)}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="gray" onClick={() => onChange(undefined)}>
            Clear limits
          </Button>
          <Button variant="filled" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className="stack-4">
        {numeric && (
          <div className="grid-2">
            <Field label="Lowest" htmlFor="lim-min" help={field.format === 'percent' ? 'Default 0' : undefined}>
              <LimitNumber id="lim-min" mode="decimal" value={l.min} onCommit={(min) => set({ min })} />
            </Field>
            <Field label="Highest" htmlFor="lim-max" help={field.format === 'percent' ? 'Default 100' : undefined}>
              <LimitNumber id="lim-max" mode="decimal" value={l.max} onCommit={(max) => set({ max })} />
            </Field>
          </div>
        )}
        {field.format === 'date' && (
          <>
            <div className="grid-2">
              <Field label="Earliest" htmlFor="lim-dmin" help="A date, today, or -120y / +30d / -6m">
                <TextInput id="lim-dmin" className="mono" value={l.dateMin ?? ''} placeholder="-120y" onChange={(e) => set({ dateMin: e.target.value.trim() || undefined })} />
              </Field>
              <Field label="Latest" htmlFor="lim-dmax" help="e.g. today for a date of birth">
                <TextInput id="lim-dmax" className="mono" value={l.dateMax ?? ''} placeholder="today" onChange={(e) => set({ dateMax: e.target.value.trim() || undefined })} />
              </Field>
            </div>
            <Field label="Prints as" htmlFor="lim-layout">
              <Select id="lim-layout" value={l.dateLayout ?? ''} onChange={(e) => set({ dateLayout: (e.target.value || undefined) as DateLayout | undefined })}>
                <option value="">MM/DD/YYYY (default)</option>
                <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                <option value="MMDDYYYY">MMDDYYYY</option>
                <option value="DD/MM/YYYY">DD/MM/YYYY</option>
              </Select>
            </Field>
          </>
        )}
        <div className="grid-2">
          <Field label="Fewest characters" htmlFor="lim-minlen" optional>
            <LimitNumber id="lim-minlen" mode="count" value={l.minLength} onCommit={(minLength) => set({ minLength })} />
          </Field>
          <Field label="Most characters" htmlFor="lim-maxlen" optional help={pdfMaxLength ? `The PDF box allows ${pdfMaxLength}.` : 'Measured on the printed value.'}>
            <LimitNumber id="lim-maxlen" mode="count" value={l.maxLength} onCommit={(maxLength) => set({ maxLength })} />
          </Field>
        </div>
        {pdfMaxLength && l.maxLength !== pdfMaxLength && (
          <Button variant="tinted" size="sm" onClick={() => set({ maxLength: pdfMaxLength })}>
            Use the PDF’s limit ({pdfMaxLength})
          </Button>
        )}
      </div>
    </Sheet>
  );
}

/** Where the form may be used, and which other templates are its versions for other states. */
function DetailsTab({ template, templates, onSaved }: { template: FormTemplate; templates: FormTemplate[]; onSaved: () => Promise<void> }) {
  const services = useServices();
  const [states, setStates] = useState<string[]>(template.states ?? []);
  const [group, setGroup] = useState(template.variantGroup ?? '');
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(states) !== JSON.stringify(template.states ?? []) || group.trim() !== (template.variantGroup ?? '');
  const fromTitle = parseStatesFromTitle(template.name);
  const groupsInUse = [...new Set(templates.map((t) => t.variantGroup).filter((g): g is string => !!g))].sort();
  const others = group.trim() ? templates.filter((t) => t.variantGroup === group.trim() && t.formNumber !== template.formNumber && t.status !== 'Retired') : [];

  async function save() {
    setBusy(true);
    try {
      await services.templates.saveDetails(template.id, { states, variantGroup: group.trim() || undefined });
      await onSaved();
      toast.ok('Saved. Advisors see the change now.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card card-pad stack-4" aria-label="Where it may be used">
      <div className="stack">
        <h2 className="t-headline">Approved in</h2>
        <p className="t-footnote c3">Advisors can still find a form that isn’t approved in their client’s state, but it’s marked, and a packet with it can’t be sent.</p>
        <StatesPicker label="Approved in" value={states} onChange={setStates} />
        {fromTitle.length > 0 && JSON.stringify(fromTitle) !== JSON.stringify(states) && (
          <div className="row t-footnote c2" style={{ gap: 6 }}>
            <Icon name="info" size={14} />
            <span className="grow">The title lists {describeStates(fromTitle)}.</span>
            <Button variant="plain" size="sm" onClick={() => setStates(fromTitle)}>
              Use those
            </Button>
          </div>
        )}
      </div>
      <div className="stack">
        <h2 className="t-headline">State versions</h2>
        <p className="t-footnote c3">Give every version of this form for different states the same group. Advisors then get the version for their client’s state automatically.</p>
        <Field label="Variant group" htmlFor="d-var" optional>
          <TextInput id="d-var" list="d-var-list" value={group} onChange={(e) => setGroup(e.target.value)} placeholder="e.g. adv-select-app" />
          <datalist id="d-var-list">
            {groupsInUse.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </Field>
        {others.length > 0 && (
          <ul className="list" aria-label="Other versions">
            {others.map((t) => (
              <li key={t.id} className="list-row">
                <span className="mono t-footnote">{t.formNumber}</span>
                <span className="grow ellipsis">{t.name}</span>
                <span className="t-footnote c3">{describeStates(t.states)}</span>
              </li>
            ))}
          </ul>
        )}
        {group.trim() && !others.length && <p className="t-footnote c3">No other form is in this group yet.</p>}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="filled" disabled={!dirty} busy={busy} onClick={save}>
          Save
        </Button>
      </div>
    </section>
  );
}

/** Which PDF option a radio group selects for each value of its source. */
function OptionsSheet({ field, pdfOptions, onChange, onClose }: { field: FieldMapping; pdfOptions: string[]; onChange: (o: Record<string, string> | undefined) => void; onClose: () => void }) {
  const current = field.options ?? {};
  // The source's choice words, plus any value already mapped (a custom column's words).
  // Values the admin added here stay listed until they pick an option for them.
  const [added, setAdded] = useState<string[]>([]);
  const words = [...new Set([...choiceWords(field.source), ...Object.keys(current), ...added])];
  const [extra, setExtra] = useState('');
  const set = (word: string, opt: string) => {
    const next = { ...current };
    if (opt) next[word] = opt;
    else delete next[word];
    onChange(Object.keys(next).length ? next : undefined);
  };
  return (
    <Sheet
      title={`Options · ${field.label ?? prettifyFieldName(field.pdfField)}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="gray" onClick={() => onChange(undefined)}>
            Clear
          </Button>
          <Button variant="filled" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className="stack-4">
        <p className="t-callout c2">
          Pick the PDF option for each value of <span className="mono">{field.source}</span>. Values with no option leave the group blank.
        </p>
        {!pdfOptions.length && <p className="t-footnote c-warn">This PDF field has no options Folium could read.</p>}
        {words.map((w) => (
          <Field key={w} label={w} htmlFor={`opt-${w}`}>
            <Select id={`opt-${w}`} value={current[w] ?? ''} onChange={(e) => set(w, e.target.value)}>
              <option value="">Leave blank</option>
              {pdfOptions.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </Select>
          </Field>
        ))}
        <div className="row" style={{ gap: 6 }}>
          <TextInput aria-label="Another value" placeholder="Another value…" value={extra} onChange={(e) => setExtra(e.target.value)} />
          <Button variant="gray" disabled={!extra.trim() || !pdfOptions.length} onClick={() => (setAdded((a) => [...a, extra.trim()]), setExtra(''))}>
            Add
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
