import { useRef } from 'react';
import { attachmentLimits, attachmentsMB, MB } from '../../domain/checks';
import { useServices } from '../../services';
import { useApp } from '../../state/store';
import { Button, IconButton, toast } from '../../ui/controls';
import { Icon } from '../../ui/Icon';

const MAX = 10 * 1024 * 1024;

/** Supporting documents that ride along in the envelope (ID copies, statements, trust pages). */
export function AttachmentsCard() {
  const packet = useApp((s) => s.packet);
  const setPacket = useApp((s) => s.setPacket);
  const limits = attachmentLimits(useApp((s) => s.firm)?.sending);
  const services = useServices();
  const input = useRef<HTMLInputElement>(null);
  const totalMB = attachmentsMB(packet.attachments);

  async function add(files: FileList | null) {
    if (!files) return;
    const added: typeof packet.attachments = [];
    // Counted against what's already attached, so the envelope stays within DocuSign's limits.
    const current = useApp.getState().packet.attachments;
    let count = current.length;
    let bytes = attachmentsMB(current) * MB;
    for (const f of Array.from(files)) {
      if (f.type !== 'application/pdf') {
        toast.error(`${f.name} isn’t a PDF.`);
        continue;
      }
      if (f.size > MAX) {
        toast.error(`${f.name} is over 10 MB.`);
        continue;
      }
      if (count >= limits.maxFiles) {
        toast.error(`${f.name} wasn’t added: an envelope can carry ${limits.maxFiles} supporting ${limits.maxFiles === 1 ? 'document' : 'documents'}.`);
        continue;
      }
      if (bytes + f.size > limits.maxMB * MB) {
        toast.error(`${f.name} wasn’t added: supporting documents can total ${limits.maxMB} MB, and ${((bytes + f.size) / MB).toFixed(1)} MB is over.`);
        continue;
      }
      count++;
      bytes += f.size;
      const id = crypto.randomUUID();
      const meta = { id, name: f.name, size: f.size, addedOn: new Date().toISOString() };
      services.attachments.set(id, { meta, bytes: new Uint8Array(await f.arrayBuffer()) });
      added.push(meta);
    }
    // Reading files is async; append to the latest list so a removal made meanwhile sticks.
    if (added.length) setPacket({ attachments: [...useApp.getState().packet.attachments, ...added] });
  }

  return (
    <section className="card card-pad stack-3" aria-labelledby="att-h">
      <div className="row">
        <h2 id="att-h" className="t-headline grow">Supporting documents</h2>
        {packet.attachments.length > 1 && (
          <Button variant="plain" size="sm" onClick={() => setPacket({ attachments: [] })}>
            Remove all
          </Button>
        )}
        <Button variant="plain" size="sm" icon="paperclip" disabled={packet.attachments.length >= limits.maxFiles} onClick={() => input.current?.click()}>
          Attach
        </Button>
        <input ref={input} type="file" accept="application/pdf" multiple hidden onChange={(e) => (add(e.target.files), (e.target.value = ''))} />
      </div>
      {packet.attachments.length === 0 ? (
        <p className="t-footnote c3">
          Add a statement, ID copy or trust page to send with the forms. PDF, up to 10 MB each, {limits.maxFiles} files and {limits.maxMB} MB in all.
        </p>
      ) : (
        <>
          <p className="t-footnote c3 tabular" aria-live="polite">
            {packet.attachments.length} of {limits.maxFiles} · {totalMB.toFixed(1)} of {limits.maxMB} MB
          </p>
          <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {packet.attachments.map((a) => (
              <li key={a.id} className="row t-callout">
                <Icon name="doc" size={16} className="c3" />
                <span className="grow ellipsis">{a.name}</span>
                <span className="t-footnote c3 tabular">{Math.max(1, Math.round(a.size / 1024))} KB</span>
                <IconButton icon="x" size={14} label={`Remove ${a.name}`} onClick={() => setPacket({ attachments: packet.attachments.filter((x) => x.id !== a.id) })} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
