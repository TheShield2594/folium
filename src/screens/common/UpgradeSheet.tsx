import { describeFormUpgrade, type DraftFreshness, type UpgradeReport } from '../../domain/drafts';
import { Badge, Button, Sheet } from '../../ui/controls';
import { Icon } from '../../ui/Icon';

/** A draft's freshness as a badge: "Current", "1 of 3 forms updated" or "Out of date". */
export function FreshnessBadge({ f }: { f: DraftFreshness }) {
  if (f.state === 'current') return <Badge>Current</Badge>;
  if (f.state === 'partial') return <Badge tone="warn">{`${f.changed} of ${f.documents.length} forms updated`}</Badge>;
  return <Badge tone="warn" icon="warning">Out of date</Badge>;
}

/**
 * What updating to the current form revisions changes, per form, before anything does:
 * values carried, values no longer used (listed, since they'll be discarded), new
 * required fields, and forms that can only be removed.
 */
export function UpgradeSheet({ report, onUpdate, onOpenAsIs, onClose }: { report: UpgradeReport; onUpdate: () => void; onOpenAsIs?: () => void; onClose: () => void }) {
  const canUpdate = report.forms.some((f) => f.state === 'newer');
  return (
    <Sheet
      title="Forms have changed"
      icon={<Icon name="warning" size={20} />}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          {onOpenAsIs && (
            <Button variant="gray" onClick={onOpenAsIs}>
              Open as is
            </Button>
          )}
          {!onOpenAsIs && (
            <Button variant="gray" onClick={onClose}>
              Cancel
            </Button>
          )}
          {canUpdate && (
            <Button variant="filled" onClick={onUpdate}>
              Update to current forms
            </Button>
          )}
        </>
      }
    >
      <div className="stack-4">
        <p className="t-callout c2">
          Marketing published new versions since this was saved. Out-of-date forms can’t be sent.
          {canUpdate ? ' Updating moves what you entered to the new versions.' : ''}
        </p>
        <ul className="stack-3" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {report.forms.map((f, i) => (
            <li key={f.itemId ?? `${f.formNumber}-${i}`} className="stack" style={{ gap: 4 }}>
              <span className="t-headline">
                {f.name} <span className="t-footnote c3 mono">{f.formNumber}</span>
              </span>
              <span className={`t-footnote ${f.state === 'newer' ? 'c2' : 'c-danger'}`}>{describeFormUpgrade(f)}</span>
              {f.newRequired.length > 0 && <span className="t-footnote c3">New to fill: {f.newRequired.join(', ')}</span>}
              {f.dropped.length > 0 && (
                <span className="t-footnote c-warn">
                  No longer on the form, so not kept: {f.dropped.map((d) => `${d.label} (“${d.value}”)`).join(', ')}
                </span>
              )}
              {f.signersChanged && <span className="t-footnote c3">Who signs changed. Check the signers before sending.</span>}
            </li>
          ))}
        </ul>
      </div>
    </Sheet>
  );
}
