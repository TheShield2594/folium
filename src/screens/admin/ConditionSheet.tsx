import { useState } from 'react';
import { prettifyFieldName } from '../../domain/format';
import { buildCondition, ConditionError, explainCondition, parseCondition, type BuilderOp } from '../../domain/paths';
import { fieldKey, termLabels } from '../../domain/prefill';
import type { FieldMapping, TemplateMapping } from '../../domain/types';
import { Button, Field, IconButton, Select, Sheet, TextInput } from '../../ui/controls';
import { Icon } from '../../ui/Icon';

type Effect = 'requiredWhen' | 'lockWhen';

const EFFECTS: { key: Effect; title: string; detail: string }[] = [
  { key: 'requiredWhen', title: 'Required when', detail: 'The field must be filled in before the packet can go out.' },
  { key: 'lockWhen', title: 'Locked when', detail: 'The field is read-only, not required and prints blank. What the advisor typed comes back if the condition stops holding.' },
];

const OPS: Record<'checkbox' | 'text', [BuilderOp, string][]> = {
  checkbox: [
    ['checked', 'is checked'],
    ['unchecked', 'is not checked'],
  ],
  text: [
    ['equals', 'equals'],
    ['notEquals', 'does not equal'],
    ['contains', 'contains'],
    ['in', 'is one of'],
    ['filled', 'is filled in'],
    ['empty', 'is empty'],
  ],
};

/** The Fields table's summary of a field's conditions. */
export function describeConditions(m: FieldMapping, mapping: TemplateMapping): string[] {
  const labels = termLabels(mapping);
  return [m.requiredWhen?.trim() && `Required ${explainCondition(m.requiredWhen, labels)}`, m.lockWhen?.trim() && `Locked ${explainCondition(m.lockWhen, labels)}`].filter(Boolean) as string[];
}

/**
 * Set a field's "Required when" and "Locked when" conditions: pick a parent field, an
 * operator and a value, or write the expression by hand.
 */
export function ConditionSheet({ field, mapping, onChange, onClose }: { field: FieldMapping; mapping: TemplateMapping; onChange: (patch: Partial<FieldMapping>) => void; onClose: () => void }) {
  return (
    <Sheet
      title={`Conditions · ${field.label ?? prettifyFieldName(field.pdfField)}`}
      onClose={onClose}
      wide
      footer={
        <Button variant="filled" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="stack-5">
        {EFFECTS.map((e) => (
          <ConditionEditor key={e.key} effect={e} field={field} mapping={mapping} value={field[e.key] ?? ''} onChange={(v) => onChange({ [e.key]: v.trim() ? v : undefined })} />
        ))}
        <p className="t-footnote c3">
          Conditions can read any field on the packet or a Dynamics path such as <span className="mono">contact.familystatuscode</span>. Combine them with <span className="mono">&amp;&amp;</span>, <span className="mono">||</span> and parentheses.
        </p>
      </div>
    </Sheet>
  );
}

function ConditionEditor({ effect, field, mapping, value, onChange }: { effect: (typeof EFFECTS)[number]; field: FieldMapping; mapping: TemplateMapping; value: string; onChange: (v: string) => void }) {
  const parents = mapping.fields.filter((f) => f.pdfField !== field.pdfField && f.source !== 'signer');
  const [parent, setParent] = useState(parents[0]?.pdfField ?? '');
  const parentField = parents.find((p) => p.pdfField === parent);
  const kind = parentField?.format === 'checkbox' ? 'checkbox' : 'text';
  const [op, setOp] = useState<BuilderOp>(OPS[kind][0][0]);
  const [arg, setArg] = useState('');
  const ops = OPS[kind];
  const curOp = ops.some(([o]) => o === op) ? op : ops[0][0];
  const needsValue = curOp === 'equals' || curOp === 'notEquals' || curOp === 'contains' || curOp === 'in';

  let error: string | undefined;
  if (value.trim()) {
    try {
      parseCondition(value);
    } catch (e) {
      error = e instanceof ConditionError ? e.message : 'This can’t be read.';
    }
  }

  function add(join: '&&' | '||' | undefined) {
    if (!parentField) return;
    const expr = buildCondition(fieldKey(parentField, mapping), curOp, arg);
    onChange(join && value.trim() ? `(${value.trim()}) ${join} ${expr}` : expr);
    setArg('');
  }

  const id = `cond-${effect.key}`;
  return (
    <section className="stack-3" aria-labelledby={`${id}-h`}>
      <div className="row">
        <Icon name={effect.key === 'lockWhen' ? 'lock' : 'warning'} size={16} className="c3" />
        <h3 id={`${id}-h`} className="t-headline grow">
          {effect.title}
        </h3>
        {value && <IconButton icon="trash" size={15} label={`Clear ${effect.title.toLowerCase()}`} onClick={() => onChange('')} />}
      </div>
      <p className="t-footnote c3">{effect.detail}</p>
      <div className="row wrap" style={{ gap: 6 }}>
        <Select aria-label="Field" value={parent} onChange={(e) => setParent(e.target.value)} style={{ width: 220 }}>
          {parents.map((p) => (
            <option key={p.pdfField} value={p.pdfField}>
              {p.label ?? prettifyFieldName(p.pdfField)}
            </option>
          ))}
        </Select>
        <Select aria-label="Operator" value={curOp} onChange={(e) => setOp(e.target.value as BuilderOp)} style={{ width: 150 }}>
          {ops.map(([o, l]) => (
            <option key={o} value={o}>
              {l}
            </option>
          ))}
        </Select>
        {needsValue && <TextInput aria-label="Value" value={arg} placeholder={curOp === 'in' ? 'married, widowed' : 'Value'} onChange={(e) => setArg(e.target.value)} style={{ width: 160 }} />}
        {value.trim() ? (
          <>
            <Button variant="tinted" size="sm" disabled={!parentField || (needsValue && !arg.trim())} onClick={() => add('&&')}>
              And
            </Button>
            <Button variant="tinted" size="sm" disabled={!parentField || (needsValue && !arg.trim())} onClick={() => add('||')}>
              Or
            </Button>
            <Button variant="plain" size="sm" disabled={!parentField || (needsValue && !arg.trim())} onClick={() => add(undefined)}>
              Replace
            </Button>
          </>
        ) : (
          <Button variant="tinted" size="sm" icon="plus" disabled={!parentField || (needsValue && !arg.trim())} onClick={() => add(undefined)}>
            Set
          </Button>
        )}
      </div>
      <Field label="Expression" htmlFor={`${id}-expr`} error={error} help={value.trim() ? `${effect.title.split(' ')[0]} ${explainCondition(value, termLabels(mapping))}.` : 'Never, unless you set a condition.'}>
        <TextInput id={`${id}-expr`} className="mono" value={value} placeholder="e.g. contact.familystatuscode == married" onChange={(e) => onChange(e.target.value)} />
      </Field>
    </section>
  );
}
