import { useState } from 'react';
import { FEEDBACK_CATEGORIES, problemReport, type FeedbackCategory } from '../../domain/feedback';
import type { FormTemplate } from '../../domain/types';
import { useServices } from '../../services';
import { useApp } from '../../state/store';
import { Button, Field, IconButton, Select, Sheet, TextArea, toast } from '../../ui/controls';
import { Icon } from '../../ui/Icon';

/**
 * "Report a problem" with a form in the library: which fields, what kind of problem and
 * a note, for Marketing. Only the form and field names go with it, never what's typed.
 */
export function ReportProblemSheet({
  template,
  fieldKeys: initial = [],
  otherForms,
  accountType,
  onClose,
}: {
  template: FormTemplate;
  /** PDF field names to start with picked (the field the advisor was on). */
  fieldKeys?: string[];
  /** Form numbers of the packet's other forms, to help Marketing reproduce it. */
  otherForms?: string[];
  accountType?: string;
  onClose: () => void;
}) {
  const services = useServices();
  const me = useApp((s) => s.me);
  const [fields, setFields] = useState<string[]>(initial);
  const [category, setCategory] = useState<FeedbackCategory | ''>(initial.length ? 'wrongValue' : '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const label = (pdfField: string) => template.mapping.fields.find((f) => f.pdfField === pdfField)?.label ?? pdfField;
  const addable = template.mapping.fields.filter((f) => !fields.includes(f.pdfField));

  async function send() {
    if (!category || !me) return;
    setBusy(true);
    try {
      await services.feedback.submit(problemReport(template, { category, fieldKeys: fields, note, detail: { otherForms, accountType, pdfKind: template.pdfKind } }, me));
      toast.ok('Sent to Marketing. You’ll see here when it’s fixed.');
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send the report');
      setBusy(false);
    }
  }

  return (
    <Sheet
      title="Report a problem with this form"
      onClose={onClose}
      footer={
        <>
          <Button variant="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="filled" icon="send" disabled={!category} busy={busy} onClick={send}>
            Send to Marketing
          </Button>
        </>
      }
    >
      <div className="stack-4">
        <div className="card card-pad stack" style={{ gap: 2 }}>
          <span className="t-headline">{template.name}</span>
          <span className="t-footnote c3">
            <span className="mono">{template.formNumber}</span> · Rev {template.revision} · {template.issuer ?? template.source}
          </span>
        </div>
        <Field label="What’s wrong" htmlFor="pr-cat">
          <Select id="pr-cat" value={category} onChange={(e) => setCategory(e.target.value as FeedbackCategory)}>
            <option value="" disabled>
              Choose…
            </option>
            {FEEDBACK_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="field">
          <label htmlFor="pr-field">Fields</label>
          {fields.length > 0 && (
            <ul className="row wrap" style={{ gap: 6, listStyle: 'none', margin: 0, padding: 0 }} aria-label="Fields picked">
              {fields.map((k) => (
                <li key={k} className="chip" style={{ gap: 2 }}>
                  {label(k)}
                  <IconButton icon="x" size={12} label={`Remove ${label(k)}`} onClick={() => setFields(fields.filter((x) => x !== k))} />
                </li>
              ))}
            </ul>
          )}
          {addable.length > 0 && (
            <Select id="pr-field" value="" onChange={(e) => e.target.value && setFields([...fields, e.target.value])}>
              <option value="">{fields.length ? 'Add another field…' : 'Pick a field (optional)…'}</option>
              {addable.map((f) => (
                <option key={f.pdfField} value={f.pdfField}>
                  {f.label ?? f.pdfField}
                </option>
              ))}
            </Select>
          )}
        </div>
        <Field label="What did you see?" htmlFor="pr-note" optional help="Describe the problem, not the client: don’t include names, numbers or other client details.">
          <TextArea id="pr-note" rows={4} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} placeholder="e.g. The ZIP prints in the phone box" />
        </Field>
        <div className="banner info">
          <Icon name="info" size={18} />
          <span className="t-footnote">Marketing sees the form, revision and fields you picked, and your note. Nothing you typed into the form is sent.</span>
        </div>
      </div>
    </Sheet>
  );
}
