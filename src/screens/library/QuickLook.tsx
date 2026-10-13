import { roleLabel } from '../../domain/signers';
import type { FormTemplate } from '../../domain/types';
import { useServices } from '../../services';
import { Badge, Button, Sheet, downloadBytes, toast } from '../../ui/controls';
import { PdfView } from '../common/PdfView';

/** Quick Look: a fast preview of a blank form before adding it. */
export function QuickLook({ template, inPacket, onAdd, onClose, latest }: { template: FormTemplate; inPacket: boolean; onAdd: () => void; onClose: () => void; latest?: FormTemplate }) {
  const services = useServices();
  return (
    <Sheet
      wide
      title={template.name}
      onClose={onClose}
      footer={
        <>
          <Button variant="gray" icon="download" onClick={async () => {
              try {
                downloadBytes(await services.templates.getPdf(template), `${template.formNumber} ${template.name} (blank).pdf`);
              } catch (e) {
                toast.error(e instanceof Error ? e.message : 'Could not download the form');
              }
            }}>
            Blank PDF
          </Button>
          <span className="spacer" />
          <Button variant="filled" icon={inPacket ? 'check' : 'plus'} disabled={inPacket} onClick={() => (onAdd(), onClose())}>
            {inPacket ? 'In packet' : 'Add to packet'}
          </Button>
        </>
      }
    >
      <div className="quicklook">
        <div className="ql-preview">
          <PdfView template={template} width={420} maxPages={2} placements={template.mapping.placements} showValues={false} />
        </div>
        <div className="stack-4 ql-meta">
          <p className="t-callout c2">{template.description}</p>
          <dl className="facts">
            <dt>Form</dt>
            <dd className="mono">{template.formNumber}</dd>
            <dt>Revision</dt>
            <dd>
              {template.revision} {latest?.id === template.id && <Badge tone="accent">Current</Badge>}
            </dd>
            <dt>From</dt>
            <dd>{template.issuer ?? template.source}</dd>
            <dt>Category</dt>
            <dd>{template.category}</dd>
            <dt>Pages</dt>
            <dd>{template.pageCount}</dd>
            <dt>Signers</dt>
            <dd>{template.mapping.signers.map((s) => roleLabel(s.role) + (s.condition ? ' (when applicable)' : '')).join(', ')}</dd>
            <dt>Fields</dt>
            <dd>{template.mapping.fields.length} mapped</dd>
          </dl>
          <a className="t-footnote" href={template.sharePointUrl} target="_blank" rel="noreferrer">
            Open in SharePoint
          </a>
        </div>
      </div>
    </Sheet>
  );
}
