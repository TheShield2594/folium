import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SavedPacket } from '../../domain/types';
import { useServices } from '../../services';
import { Toolbar } from '../../shell/Shell';
import { useApp } from '../../state/store';
import { Badge, Button, Empty, IconButton, Menu, SearchField, Segmented, toast } from '../../ui/controls';
import { Icon } from '../../ui/Icon';

type Tab = 'all' | 'mine' | 'shared';

/** Saved packets ("Saved forms"): reusable sets of forms, personal or shared with groups. */
export function PacketsScreen() {
  const packets = useApp((s) => s.packets);
  const templates = useApp((s) => s.templates);
  const me = useApp((s) => s.me);
  const groups = useApp((s) => s.groups);
  const client = useApp((s) => s.client);
  const loadPacket = useApp((s) => s.loadPacket);
  const refreshPackets = useApp((s) => s.refreshPackets);
  const services = useServices();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<Tab>('all');

  const myGroups = useMemo(() => new Set(groups.filter((g) => g.memberIds.includes(me?.systemuserid ?? '')).map((g) => g.id)), [groups, me]);
  const visible = packets.filter((p) => p.owner === me?.fullname || (p.shared && (!p.groupIds?.length || p.groupIds.some((g) => myGroups.has(g)))));
  const list = visible
    .filter((p) => (tab === 'mine' ? p.owner === me?.fullname : tab === 'shared' ? p.owner !== me?.fullname : true))
    .filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()) || p.templateIds.some((id) => templates.find((t) => t.id === id)?.name.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => b.usedCount - a.usedCount);

  async function start(p: SavedPacket, go: 'review' | 'library') {
    if (!client) return toast.error('Choose a client first.');
    loadPacket(p);
    await services.packets.save({ ...p, usedCount: p.usedCount + 1 });
    refreshPackets();
    navigate(go === 'review' ? '/review' : '/');
  }

  async function remove(p: SavedPacket) {
    await services.packets.remove(p.id);
    await refreshPackets();
    toast.ok(`Deleted “${p.name}”`, { label: 'Undo', onClick: async () => (await services.packets.save(p), refreshPackets()) });
  }

  return (
    <>
      <Toolbar title="Saved packets">
        <Segmented
          label="Show"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'all', label: 'All' },
            { value: 'mine', label: 'Mine' },
            { value: 'shared', label: 'Shared' },
          ]}
        />
      </Toolbar>
      <div className="scroll">
        <div className="page page-narrow stack-5">
          <div className="page-head" style={{ marginBottom: 0 }}>
            <div>
              <h1 className="t-large">Saved packets</h1>
              <p className="sub">Forms you send together, ready to prefill for any client. Always opens the current revision.</p>
            </div>
          </div>
          <SearchField value={q} onChange={setQ} placeholder="Search packets or the forms in them" label="Search packets" />
          {list.length === 0 ? (
            <Empty icon="tray" title="No saved packets" action={<Button variant="tinted" onClick={() => navigate('/')}>Find forms</Button>}>
              Pick forms for a client, then choose Save as packet.
            </Empty>
          ) : (
            <div className="stack-3">
              {list.map((p) => {
                const forms = p.templateIds.map((id) => templates.find((t) => t.id === id)).filter(Boolean);
                const isMine = p.owner === me?.fullname;
                return (
                  <article key={p.id} className="card card-pad stack-3">
                    <div className="row" style={{ alignItems: 'flex-start' }}>
                      <span className="avatar" style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--accent-tint-2)', color: 'var(--accent-text)' }}>
                        <Icon name="tray" size={20} />
                      </span>
                      <div className="grow" style={{ minWidth: 0 }}>
                        <h2 className="t-title3">{p.name}</h2>
                        <p className="t-footnote c3">
                          {forms.length} forms · {isMine ? 'yours' : `from ${p.owner}`} · used {p.usedCount} {p.usedCount === 1 ? 'time' : 'times'}
                        </p>
                      </div>
                      {p.shared && (
                        <Badge tone="info" icon="people">
                          {p.groupIds?.length ? groups.filter((g) => p.groupIds!.includes(g.id)).map((g) => g.name).join(', ') : 'Everyone'}
                        </Badge>
                      )}
                      <Menu
                        trigger={(t) => <IconButton icon="ellipsis" label={`More for ${p.name}`} {...t} />}
                        items={[
                          { label: 'Add to current packet', icon: 'plus', onSelect: () => start(p, 'library') },
                          ...(isMine || me?.role === 'Admin'
                            ? [
                                { label: p.shared ? 'Stop sharing' : 'Share with my groups', icon: 'people' as const, onSelect: async () => (await services.packets.save({ ...p, shared: !p.shared, groupIds: p.shared ? [] : [...myGroups] }), refreshPackets()) },
                                { separator: true, label: '' },
                                { label: 'Delete', icon: 'trash' as const, danger: true, onSelect: () => remove(p) },
                              ]
                            : []),
                        ]}
                      />
                    </div>
                    {p.description && <p className="t-callout c2">{p.description}</p>}
                    <ol className="row wrap" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 6 }}>
                      {forms.map((t) => (
                        <li key={t!.id} className="badge">
                          <span className="mono">{t!.formNumber}</span> {t!.name}
                        </li>
                      ))}
                    </ol>
                    <div className="row">
                      <span className="spacer" />
                      <Button variant="filled" icon="wand" disabled={!client} onClick={() => start(p, 'review')}>
                        {client ? `Prefill for ${client.contact.firstname}` : 'Choose a client first'}
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
