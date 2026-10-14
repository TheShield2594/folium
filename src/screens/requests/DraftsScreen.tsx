import { useEffect, useState } from 'react';
import { draftFreshness } from '../../domain/drafts';
import { draftExpiryInfo, retentionDays } from '../../domain/requests';
import type { SignatureRequest } from '../../domain/types';
import { useServices } from '../../services';
import { Toolbar } from '../../shell/Shell';
import { useApp } from '../../state/store';
import { Avatar, Badge, Button, Empty, IconButton, Menu, Segmented, Spinner, toast } from '../../ui/controls';
import { FreshnessBadge } from '../common/UpgradeSheet';
import { useDraftActions } from '../common/useDraftActions';
import { useOpenDraft } from '../common/useOpenDraft';
import { fmtDay } from './RequestCard';

type Tab = 'mine' | 'shared';

/** Drafts in progress, and packets colleagues have shared with you. */
export function DraftsScreen() {
  const services = useServices();
  const me = useApp((s) => s.me);
  const users = useApp((s) => s.users);
  const actingForId = useApp((s) => s.actingForId);
  const requests = useApp((s) => s.requests);
  const templates = useApp((s) => s.templates);
  const keepDays = retentionDays(useApp((s) => s.policy));
  const [tab, setTab] = useState<Tab>('mine');
  const [list, setList] = useState<SignatureRequest[]>();
  const [names, setNames] = useState<Record<string, string>>({});
  const [reload, setReload] = useState(0);
  const drafts = useDraftActions(() => setReload((n) => n + 1));
  const opener = useOpenDraft();

  useEffect(() => {
    let live = true;
    services.requests.listMine().then(async (all) => {
      const drafts = all.filter((r) => r.status === 'Drafted');
      const n: Record<string, string> = {};
      await Promise.all([...new Set(drafts.map((d) => d.contactId))].map(async (id) => (n[id] = (await services.crm.getClient(id).catch(() => undefined))?.contact.fullname ?? 'Client')));
      if (live) {
        setNames(n);
        setList(drafts);
      }
    }).catch((e) => {
      if (!live) return;
      setList([]);
      toast.error(e instanceof Error ? e.message : 'Could not load drafts');
    });
    return () => {
      live = false;
    };
  }, [services, requests, reload]);

  const meId = me?.systemuserid ?? '';
  const mine = (list ?? []).filter((r) => r.preparedById === meId || r.ownerId === actingForId || r.ownerId === meId);
  const shared = (list ?? []).filter((r) => r.sharedWith?.includes(meId) && !mine.includes(r));
  const shown = tab === 'mine' ? mine : shared;

  return (
    <>
      <Toolbar title="Drafts & shared">
        <Segmented
          label="Show"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'mine', label: `Mine${mine.length ? ` (${mine.length})` : ''}` },
            { value: 'shared', label: `Shared with me${shared.length ? ` (${shared.length})` : ''}` },
          ]}
        />
      </Toolbar>
      <div className="scroll">
        <div className="page page-narrow stack-5">
          <div>
            <h1 className="t-large">{tab === 'mine' ? 'Drafts' : 'Shared with you'}</h1>
            <p className="t-callout c2" style={{ marginTop: 4 }}>
              {tab === 'mine'
                ? `Packets saved before sending. Everything you entered is kept${keepDays ? ` for ${keepDays} days after the last save, then the draft and its PDFs are deleted` : ''}.`
                : 'Packets colleagues handed to you to review, finish or send.'}
            </p>
          </div>
          {!list ? (
            <div className="row" style={{ justifyContent: 'center', padding: 40 }}>
              <Spinner />
            </div>
          ) : shown.length === 0 ? (
            <Empty icon={tab === 'mine' ? 'pencil' : 'share'} title={tab === 'mine' ? 'No drafts' : 'Nothing shared with you'}>
              {tab === 'mine' ? 'Use Save draft on the review screen to come back to a packet later.' : 'When someone shares a packet with you, it shows up here.'}
            </Empty>
          ) : (
            <div className="list">
              {shown.map((r) => {
                const by = users.find((u) => u.systemuserid === r.preparedById);
                const expiry = draftExpiryInfo(r);
                const owner = users.find((u) => u.systemuserid === r.ownerId);
                return (
                  <div key={r.id} className="list-row" style={{ padding: '14px 16px' }}>
                    <Avatar name={names[r.contactId] ?? '?'} size={36} alt />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="t-headline">
                        {names[r.contactId]} · {r.title}
                      </div>
                      <div className="t-footnote c3">
                        {r.documents.map((d) => d.formNumber).join(', ')} · {Object.keys(r.values).length} values entered · saved {fmtDay(r.audit.at(-1)?.at ?? r.createdOn)} by {by?.fullname ?? r.preparedBy}
                        {owner && owner.systemuserid !== by?.systemuserid ? ` for ${owner.fullname}` : ''}
                      </div>
                    </div>
                    {r.inPerson && <Badge>Printed</Badge>}
                    <FreshnessBadge f={draftFreshness(r, templates)} />
                    {expiry && <Badge tone={expiry.soon ? 'warn' : undefined}>{expiry.daysLeft <= 0 ? 'Expiring today' : `Expires ${fmtDay(expiry.expiresOn)}`}</Badge>}
                    {r.sharedWith?.length ? <Badge tone="info" icon="share">{r.sharedWith.length}</Badge> : null}
                    <Button variant="tinted" onClick={() => opener.open(r)}>
                      Open
                    </Button>
                    <Menu
                      trigger={(p) => <IconButton icon="ellipsis" label={`More for ${r.title}`} {...p} />}
                      items={[
                        { label: 'Rename…', icon: 'pencil', onSelect: () => drafts.askRename(r, list ?? []) },
                        ...(drafts.canDelete(r)
                          ? [{ separator: true, label: '' }, { label: 'Delete draft…', icon: 'trash' as const, danger: true, onSelect: () => drafts.askDelete(r, names[r.contactId]) }]
                          : drafts.isSharedWithMe(r)
                            ? [{ label: 'Remove from my list', icon: 'x' as const, onSelect: () => drafts.removeFromMyList(r) }]
                            : []),
                      ]}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {drafts.sheet}
      {opener.sheet}
    </>
  );
}
