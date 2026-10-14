import type { ReactNode } from 'react';
import { canEditRepField, DIRECTORY_FIELDS, fieldOrigin, REP_FIELDS, showRepValue, type DirectoryField } from '../../domain/advisor';
import type { Advisor, FirmPolicy, OfficeAddress, UserProfile } from '../../domain/types';
import { Field, TextInput } from '../../ui/controls';

const isDirectoryField = (f: keyof Advisor): f is DirectoryField => (DIRECTORY_FIELDS as readonly string[]).includes(f);

/**
 * The advisor details forms print (`rep.*`), as one person sees them: what they may
 * change, and where each value came from (the Microsoft directory, or set in Folium,
 * with a way back to the directory value).
 */
export function RepDetails({ value, onChange, editor, policy, idPrefix }: { value: UserProfile; onChange: (patch: Partial<UserProfile>) => void; editor: UserProfile; policy?: FirmPolicy; idPrefix: string }) {
  const can = (f: keyof Advisor) => canEditRepField(editor, value, f, policy);
  const self = editor.systemuserid === value.systemuserid;

  /** Where the value came from, with Reset when Folium overrides the directory. */
  const origin = (f: keyof Advisor, extra?: string): ReactNode => {
    const o = isDirectoryField(f) ? fieldOrigin(value, f) : undefined;
    const reset =
      o === 'override' && can(f) ? (
        <>
          {' · '}
          <button type="button" className="link" onClick={() => onChange({ [f]: value.directory?.[f as DirectoryField] })}>
            Use “{showRepValue(value.directory?.[f as DirectoryField])}”
          </button>
        </>
      ) : null;
    const where = o === 'directory' ? (self ? 'From your Microsoft profile' : 'From the Microsoft directory') : o === 'override' ? 'Set in Folium' : undefined;
    const parts = [where, extra].filter(Boolean).join(' · ');
    return parts || reset ? (
      <>
        {parts}
        {reset}
      </>
    ) : undefined;
  };

  const text = (f: keyof Advisor, label: string, opts: { type?: string; mono?: boolean; help?: string; placeholder?: string } = {}) => (
    <Field key={f} label={label} htmlFor={`${idPrefix}-${f}`} help={origin(f, opts.help)}>
      <TextInput
        id={`${idPrefix}-${f}`}
        type={opts.type}
        className={opts.mono ? 'mono' : undefined}
        value={String(value[f] ?? '')}
        placeholder={opts.placeholder}
        disabled={!can(f)}
        onChange={(e) => onChange({ [f]: e.target.value })}
      />
    </Field>
  );

  const office: OfficeAddress = value.office ?? { line1: '', city: '', state: '', zip: '' };
  const setOffice = (p: Partial<OfficeAddress>) => onChange({ office: { ...office, ...p } });
  const officeOk = can('office');
  const locked = REP_FIELDS.filter((f) => !can(f.field));

  return (
    <div className="stack-4">
      {locked.length > 0 && (
        <p className="t-footnote c3" role="note">
          {locked.every((f) => ['repCode', 'osjNumber', 'riaNumber'].includes(f.field as string))
            ? 'Rep, OSJ and RIA numbers are set by an administrator.'
            : 'Ask an administrator to change your rep details.'}
        </p>
      )}
      <div className="grid-2">
        <Field label="Name" htmlFor={`${idPrefix}-name`} help="Managed in Microsoft Entra ID">
          <TextInput id={`${idPrefix}-name`} value={value.fullname} disabled />
        </Field>
        {text('middleName', 'Middle name')}
        {text('title', 'Title')}
        {text('branch', 'Branch')}
        {text('email', 'Email', { type: 'email' })}
        {text('formEmail', 'Email on forms', { type: 'email', help: 'Only if forms should show a different address', placeholder: value.email })}
        {text('phone', 'Phone', { type: 'tel' })}
        {text('phoneExt', 'Extension', { mono: true })}
        {text('mobile', 'Mobile', { type: 'tel' })}
        {text('fax', 'Fax', { type: 'tel' })}
      </div>
      <fieldset className="stack-3" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field-label" style={{ padding: '0 0 6px 2px' }}>
          Office address
        </legend>
        <div className="grid-2">
          <Field label="Street" htmlFor={`${idPrefix}-office1`} help={origin('office')}>
            <TextInput id={`${idPrefix}-office1`} value={office.line1} disabled={!officeOk} onChange={(e) => setOffice({ line1: e.target.value })} />
          </Field>
          <Field label="Suite" htmlFor={`${idPrefix}-office2`} optional>
            <TextInput id={`${idPrefix}-office2`} value={office.suite ?? ''} disabled={!officeOk} onChange={(e) => setOffice({ suite: e.target.value || undefined })} />
          </Field>
          <Field label="City" htmlFor={`${idPrefix}-officeCity`}>
            <TextInput id={`${idPrefix}-officeCity`} value={office.city} disabled={!officeOk} onChange={(e) => setOffice({ city: e.target.value })} />
          </Field>
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <Field label="State" htmlFor={`${idPrefix}-officeState`}>
              <TextInput id={`${idPrefix}-officeState`} maxLength={2} style={{ width: 64 }} value={office.state} disabled={!officeOk} onChange={(e) => setOffice({ state: e.target.value.toUpperCase() })} />
            </Field>
            <Field label="ZIP" htmlFor={`${idPrefix}-officeZip`}>
              <TextInput id={`${idPrefix}-officeZip`} value={office.zip} disabled={!officeOk} onChange={(e) => setOffice({ zip: e.target.value })} />
            </Field>
          </div>
        </div>
      </fieldset>
      <div className="grid-2">
        {text('repCode', 'Rep code', { mono: true })}
        {text('osjNumber', 'OSJ number', { mono: true })}
        {text('riaNumber', 'RIA number', { mono: true })}
      </div>
    </div>
  );
}

/** The audit list: who changed which rep field, newest first. */
export function RepAudit({ user }: { user: UserProfile }) {
  const entries = [...(user.repDataAudit ?? [])].reverse();
  if (!entries.length) return null;
  const label = (f: string) => (f === 'canEditRepData' ? 'May edit own rep data' : (REP_FIELDS.find((x) => x.field === f)?.label ?? f));
  return (
    <details className="stack-2">
      <summary className="t-footnote" style={{ cursor: 'pointer' }}>
        Rep data history ({entries.length})
      </summary>
      <ul className="list t-footnote" style={{ margin: 0, padding: 0 }}>
        {entries.slice(0, 30).map((e, i) => (
          <li key={i} className="list-row" style={{ display: 'block' }}>
            <span style={{ fontWeight: 600 }}>{label(e.field)}</span>: {e.from ? `“${e.from}”` : 'blank'} → {e.to ? `“${e.to}”` : 'blank'}
            <span className="c3">
              {' '}
              · {e.by}, {new Date(e.at).toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
