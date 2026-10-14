import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { isTruthy, maskValue } from '../../domain/format';
import { sourceKind } from '../../domain/paths';
import type { FieldState } from '../../domain/prefill';
import type { FieldFormat } from '../../domain/types';
import { Badge, Button, IconButton, TextInput } from '../../ui/controls';
import { Icon } from '../../ui/Icon';

function toInputDate(v: string) {
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  return us ? `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}` : v;
}

const PLACEHOLDER: Partial<Record<FieldFormat, string>> = { currency: '$0.00', percent: '0%', phone: '(555) 555-5555', ssn: '000-00-0000', ein: '00-0000000', ssnOrTin: '000-00-0000 or 00-0000000', zip: '00000' };

/** One input, shaped by the field's format. */
export function FieldInput({ field, value, onChange, hideLabel }: { field: FieldState; value: string; onChange: (v: string) => void; hideLabel?: boolean }) {
  const id = useId();
  const f = field.mapping.format;
  const [reveal, setReveal] = useState(false);
  const need = field.missing || !!field.formatError;

  if (field.locked) {
    return (
      <div className="field">
        {!hideLabel && (
          <span className="row" style={{ gap: 6 }}>
            <Icon name="lock" size={13} className="c3" />
            {field.label}
          </span>
        )}
        <TextInput id={id} aria-label={hideLabel ? field.label : undefined} value="" placeholder="Left blank" disabled aria-describedby={`${id}-why`} />
        <span id={`${id}-why`} className="help">
          Locked {field.lockReason ?? ''}. It prints blank{value ? '; what you entered comes back if that changes' : ''}.
        </span>
      </div>
    );
  }

  if (f === 'checkbox') {
    return (
      <label className="row" style={{ minHeight: 32, cursor: 'pointer' }}>
        <input type="checkbox" className="check" checked={isTruthy(value)} onChange={(e) => onChange(e.target.checked ? 'Yes' : '')} />
        <span className="t-callout" style={{ fontWeight: 600 }}>{field.label}</span>
        {field.required && <span className="c-warn t-footnote">required</span>}
      </label>
    );
  }

  const sensitive = f === 'ssn' || f === 'ssnOrTin';
  return (
    <div className="field">
      {!hideLabel && (
        <label htmlFor={id} className="row" style={{ gap: 6 }}>
          {field.label}
          {field.required && <span className="c-warn" aria-label="required">•</span>}
        </label>
      )}
      <div className="row" style={{ gap: 6 }}>
        <TextInput
          id={id}
          need={need}
          aria-invalid={field.formatError && value ? true : undefined}
          type={f === 'date' ? 'date' : f === 'email' ? 'email' : sensitive && !reveal ? 'password' : 'text'}
          inputMode={f === 'integer' || f === 'ssn' || f === 'ssnLast4' || f === 'ein' || f === 'ssnOrTin' || f === 'zip' ? 'numeric' : f === 'currency' || f === 'percent' || f === 'decimal' ? 'decimal' : f === 'phone' ? 'tel' : undefined}
          value={f === 'date' ? toInputDate(value) : value}
          placeholder={PLACEHOLDER[f ?? 'text']}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={f ? false : true}
          autoComplete="off"
        />
        {sensitive && <IconButton icon={reveal ? 'eyeSlash' : 'eye'} label={reveal ? 'Hide' : 'Show'} onClick={() => setReveal(!reveal)} />}
      </div>
      {field.formatError && value ? <span className="err">{field.formatError}</span> : field.mapping.help ? <span className="help">{field.mapping.help}</span> : null}
    </div>
  );
}

/** The selected field: edit it, see where it came from, put the CRM value back. */
export function FieldEditor({ field, value, onChange, onClose, usedOn }: { field: FieldState; value: string | undefined; onChange: (v: string | undefined) => void; onClose: () => void; usedOn: string[] }) {
  const navigate = useNavigate();
  const kind = sourceKind(field.mapping.source);
  const fromCrm = kind === 'crm';
  return (
    <section className="card card-pad stack-3" aria-label={`Edit ${field.label}`} style={{ boxShadow: '0 0 0 2px var(--ev-royal), var(--shadow-2)' }}>
      <div className="row">
        <span className="grow t-caption c3">SELECTED FIELD</span>
        <IconButton icon="x" label="Done" size={15} onClick={onClose} />
      </div>
      <FieldInput field={field} value={value ?? field.value} onChange={(v) => onChange(v)} />
      <div className="row wrap" style={{ gap: 6 }}>
        <Badge tone={field.origin === 'edited' || field.origin === 'advisor' ? 'info' : field.missing ? 'warn' : 'accent'}>
          {field.origin === 'edited' ? 'Changed on this form' : field.sourceLabel}
        </Badge>
        <span className="t-footnote c3 mono">{field.mapping.pdfField}</span>
      </div>
      {field.origin === 'edited' && field.crmValue !== undefined && (
        <div className="row t-footnote c2">
          <Icon name="info" size={14} />
          <span className="grow">
            CRM has “{maskValue(field.crmValue, field.mapping.format)}”.
          </span>
          <Button variant="plain" size="sm" icon="refresh" onClick={() => onChange(undefined)}>
            Use CRM value
          </Button>
        </div>
      )}
      {usedOn.length > 1 && <p className="t-footnote c3">Shared by {usedOn.length} forms: {usedOn.join(', ')}.</p>}
      {fromCrm && (
        <Button variant="tinted" size="sm" icon="pencil" onClick={() => navigate('/client')}>
          Fix it in Dynamics 365 instead
        </Button>
      )}
    </section>
  );
}
