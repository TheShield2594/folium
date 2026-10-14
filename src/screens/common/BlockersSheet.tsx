import { formLabel, type CheckResult } from '../../domain/checks';
import type { FormFill } from '../../domain/prefill';
import { Button, Sheet } from '../../ui/controls';
import { Icon } from '../../ui/Icon';

/**
 * Why an output was refused: every blocking check at once, grouped by form, each one
 * a jump to its field. Laser App stops at the first missing field; this lists them all.
 */
export function BlockersSheet({ title, blockers, fills, onJump, onClose }: { title: string; blockers: CheckResult[]; fills: FormFill[]; onJump: (c: CheckResult) => void; onClose: () => void }) {
  const formOf = (b: CheckResult) => (b.id === 'current-revisions' ? undefined : fills.find((f) => (b.itemId ? f.itemId === b.itemId : f.template.id === b.templateId)));
  // Packet-wide checks (out-of-date revisions) first, then one group per form in packet order.
  const packetWide = blockers.filter((b) => !formOf(b));
  const groups = [
    ...(packetWide.length ? [{ key: 'packet', label: 'Packet', items: packetWide }] : []),
    ...fills.map((f) => ({ key: f.itemId, label: formLabel(f), items: blockers.filter((b) => formOf(b) === f) })).filter((g) => g.items.length),
  ];
  const jump = (c: CheckResult) => {
    onClose();
    onJump(c);
  };
  return (
    <Sheet
      title={title}
      onClose={onClose}
      icon={<Icon name="warning" size={20} className="c-warn" />}
      footer={
        <>
          <Button variant="gray" onClick={onClose}>
            Close
          </Button>
          <Button variant="filled" iconAfter="arrowRight" disabled={!blockers.length} onClick={() => blockers[0] && jump(blockers[0])}>
            Go to first
          </Button>
        </>
      }
    >
      <div className="stack-4">
        <p className="t-callout c2">
          Fix {blockers.length === 1 ? 'this' : `these ${blockers.length}`} first, so the client doesn’t sign a form that comes back not in good order. Saving a draft still works.
        </p>
        {groups.map((g) => (
          <section key={g.key} aria-label={g.label}>
            <h3 className="t-caption c3" style={{ margin: '0 0 4px 8px' }}>
              {g.label.toUpperCase()}
            </h3>
            {g.items.map((c) => (
              <button key={c.id} className="check-row" onClick={() => jump(c)}>
                <Icon name="warning" size={18} className="c-warn" />
                <span className="grow">
                  <span style={{ fontWeight: 600 }}>{c.title}</span>
                  {c.detail && <span className="t-footnote c3" style={{ display: 'block' }}>{c.detail}</span>}
                </span>
                <Icon name="chevronRight" size={14} className="c3" />
              </button>
            ))}
          </section>
        ))}
      </div>
    </Sheet>
  );
}
