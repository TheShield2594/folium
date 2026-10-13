import { useRef } from 'react';
import { useServices } from '../../services';
import { useApp } from '../../state/store';
import { Button, IconButton, toast } from '../../ui/controls';
import { Icon } from '../../ui/Icon';

const MAX = 10 * 1024 * 1024;

/** Supporting documents that ride along in the envelope (ID copies, statements, trust pages). */
export function AttachmentsCard() {
  const packet = useApp((s) => s.packet);
  const setPacket = useApp((s) => s.setPacket);
  const services = useServices();
  const input = useRef<HTMLInputElement>(null);

  async function add(files: FileList | null) {
    if (!files) return;
    const added: typeof packet.attachments = [];
    for (const f of Array.from(files)) {
      if (f.type !== 'application/pdf') {
        toast.error(`${f.name} isn’t a PDF.`);
        continue;
      }
      if (f.size > MAX) {
        toast.error(`${f.name} is over 10 MB.`);
        continue;
      }
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
        <Button variant="plain" size="sm" icon="paperclip" onClick={() => input.current?.click()}>
          Attach
        </Button>
        <input ref={input} type="file" accept="application/pdf" multiple hidden onChange={(e) => (add(e.target.files), (e.target.value = ''))} />
      </div>
      {packet.attachments.length === 0 ? (
        <p className="t-footnote c3">Add a statement, ID copy or trust page to send with the forms. PDF, up to 10 MB.</p>
      ) : (
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
      )}
    </section>
  );
}
