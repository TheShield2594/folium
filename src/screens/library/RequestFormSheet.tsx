import { useState } from 'react';
import type { Services } from '../../services/types';
import { useApp } from '../../state/store';
import { Button, Field, Sheet, TextArea, TextInput, toast } from '../../ui/controls';

export function RequestFormSheet({ initial, onClose, services }: { initial?: string; onClose: () => void; services: Services }) {
  const me = useApp((s) => s.me);
  const [name, setName] = useState(initial ?? '');
  const [issuer, setIssuer] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    try {
      await services.templates.requestForm({ name: name.trim(), issuer: issuer.trim() || undefined, note: note.trim() || undefined, requestedBy: me?.fullname ?? '' });
      toast.ok('Sent to Marketing. You’ll see it in the library once it’s mapped.');
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send request');
      setBusy(false);
    }
  }

  return (
    <Sheet
      title="Ask Marketing for a form"
      onClose={onClose}
      footer={
        <>
          <Button variant="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="filled" icon="send" disabled={!name.trim()} busy={busy} onClick={send}>
            Send request
          </Button>
        </>
      }
    >
      <div className="stack-4">
        <Field label="Form name or number" htmlFor="rq-name">
          <TextInput id="rq-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Company" htmlFor="rq-issuer" optional>
          <TextInput id="rq-issuer" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="Carrier or fund family" />
        </Field>
        <Field label="Anything that helps" htmlFor="rq-note" optional>
          <TextArea id="rq-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="A link to the PDF, or what you use it for" />
        </Field>
      </div>
    </Sheet>
  );
}
