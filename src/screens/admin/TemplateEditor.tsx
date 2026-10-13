import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { prettifyFieldName } from '../../domain/format';
import { prefillForm } from '../../domain/prefill';
import { carryForward, diffRevision, type FieldChange } from '../../domain/revisions';
import { roleLabel } from '../../domain/signers';
import type { Check, ClientRecord, Contact, FieldFormat, FieldMapping, FormTemplate, Placement, PlacementType, TemplateMapping } from '../../domain/types';
import { fillPdf } from '../../pdf/fill';
import { useServices } from '../../services';
import { Toolbar } from '../../shell/Shell';
import { useActingFor, useApp } from '../../state/store';
import { Badge, Button, Empty, Field, IconButton, Segmented, Select, Sheet, TextInput, downloadBytes, toast } from '../../ui/controls';
import { Icon } from '../../ui/Icon';
import { PdfView, useInspection } from '../common/PdfView';
import { STATUS_TONE } from './AdminTemplates';
import { KNOWN_SOURCES, SOURCE_GROUPS } from './sources';

type Tab = 'fields' | 'signers' | 'checks' | 'test';
const FORMATS: (FieldFormat | '')[] = ['', 'date', 'ssn', 'ssnLast4', 'phone', 'zip', 'email', 'currency', 'percent', 'checkbox'];
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

  useEffect(() => {
    if (template) setMapping(structuredClone(template.mapping));
  }, [template]);

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
  const changeOf = (name: string) => diff?.find((d) => d.pdfField === name);
  const needsAttention = (m: FieldMapping) => (changeOf(m.pdfField)?.change ?? 'unchanged') !== 'unchanged' || !m.source;

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
    setMapping((m) => m && { ...m, fields: [...m.fields, ...unmappedInPdf.map((f): FieldMapping => ({ pdfField: f.name, source: 'advisor', required: false, label: prettifyFieldName(f.name), format: f.type === 'checkbox' ? 'checkbox' : undefined }))] });
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
    mapping: m,
    key: m.pdfField,
    label: m.label ?? m.pdfField,
    value: '',
    display: m.source === 'signer' ? '' : m.label ?? m.pdfField,
    origin: (m.source === 'signer' ? 'signer' : needsAttention(m) ? 'missing' : 'crm') as 'signer' | 'missing' | 'crm',
    sourceLabel: m.source,
    required: m.required,
    missing: needsAttention(m),
  }));
  const shownFields = mapping.fields.filter((m) => filter === 'all' || needsAttention(m));

  return (
    <>
      <Toolbar title={`${template.formNumber} · Rev ${template.revision}`} subtitle={template.name} back={{ label: 'Library', to: '/admin/templates' }}>
        <Badge tone={STATUS_TONE[template.status]}>{template.status}</Badge>
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
                  <div style={{ overflowX: 'auto' }}>
                    <table className="table mapping" style={{ minWidth: 760 }}>
                      <thead>
                        <tr>
                          <th>PDF field</th>
                          <th>Label in Folium</th>
                          <th>Fill from</th>
                          <th>Format</th>
                          <th>Required</th>
                          <th aria-label="Remove" />
                        </tr>
                      </thead>
                      <tbody>
                        {shownFields.map((m) => {
                          const ch = changeOf(m.pdfField);
                          const custom = !KNOWN_SOURCES.has(m.source);
                          return (
                            <tr key={m.pdfField} className={sel === m.pdfField ? 'sel' : undefined} onClick={() => setSel(m.pdfField)}>
                              <td>
                                <div className="mono t-footnote">{m.pdfField}</div>
                                {ch && ch.change !== 'unchanged' && (
                                  <Badge tone={CHANGE_TONE[ch.change]}>{ch.change === 'renamed' ? `renamed from ${ch.previousName}` : ch.change}</Badge>
                                )}
                              </td>
                              <td>
                                <TextInput aria-label={`Label for ${m.pdfField}`} value={m.label ?? ''} placeholder={prettifyFieldName(m.pdfField)} onChange={(e) => patchField(m.pdfField, { label: e.target.value || undefined })} />
                              </td>
                              <td style={{ minWidth: 220 }}>
                                <Select aria-label={`Source for ${m.pdfField}`} value={custom ? '__custom' : m.source} onChange={(e) => patchField(m.pdfField, { source: e.target.value === '__custom' ? 'contact.' : e.target.value })}>
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
                                <Select aria-label={`Format for ${m.pdfField}`} value={m.format ?? ''} onChange={(e) => patchField(m.pdfField, { format: (e.target.value || undefined) as FieldFormat | undefined })}>
                                  {FORMATS.map((f) => (
                                    <option key={f} value={f}>
                                      {f || 'Text'}
                                    </option>
                                  ))}
                                </Select>
                              </td>
                              <td>
                                <input type="checkbox" className="check" aria-label={`${m.pdfField} required`} checked={m.required} onChange={(e) => patchField(m.pdfField, { required: e.target.checked })} />
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
              {tab === 'test' && <TestTab template={{ ...template, mapping }} />}
            </div>

            {tab !== 'test' && (
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
      {publishing && (
        <PublishSheet
          template={template}
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
          </div>
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
