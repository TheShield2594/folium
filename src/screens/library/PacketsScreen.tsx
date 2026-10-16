import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SavedPacket } from '../../domain/types';
import { useServices } from '../../services';
import { Toolbar } from '../../shell/Shell';
import { PACKET_LIMIT, latestLive, useApp } from '../../state/store';
import { Badge, Button, ConfirmSheet, Empty, IconButton, Menu, SearchField, Segmented, toast } from '../../ui/controls';
import { NameSheet } from '../common/NameSheet';
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
  const addToPacket = useApp((s) => s.addToPacket);
  const refreshPackets = useApp((s) => s.refreshPackets);
  const services = useServices();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<Tab>('all');
  const [deleting, setDeleting] = useState<SavedPacket>();
  const [renaming, setRenaming] = useState<SavedPacket>();

  const myGroups = useMemo(() => new Set(groups.filter((g) => g.memberIds.includes(me?.systemuserid ?? '')).map((g) => g.id)), [groups, me]);
  const visible = packets.filter((p) => p.owner === me?.fullname || (p.shared && (!p.groupIds?.length || p.groupIds.some((g) => myGroups.has(g)))));
  const list = visible
    .filter((p) => (tab === 'mine' ? p.owner === me?.fullname : tab === 'shared' ? p.owner !== me?.fullname : true))
    .filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()) || p.templateIds.some((id) => templates.find((t) => t.id === id)?.name.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => b.usedCount - a.usedCount);

  function countUse(p: SavedPacket) {
    services.packets
      .save({ ...p, usedCount: p.usedCount + 1 })
      .then(() => refreshPackets())
      .catch(() => undefined); // a missed usage count isn't worth interrupting the advisor
  }

  /** Start a fresh packet from a saved one and go straight to review. */
  async function start(p: SavedPacket) {
    if (!client) return toast.error('Choose a client first.');
    if (!(await useApp.getState().confirmReplacePacket('open-draft'))) return;
    loadPacket(p);
    countUse(p);
    navigate('/review');
  }

  /** Add a saved packet's forms to the packet in progress, keeping what's already there. */
  function addToCurrent(p: SavedPacket) {
    if (!client) return toast.error('Choose a client first.');
    let added = 0;
    let present = 0;
    let missing = 0;
    let full = false;
    const seen = new Set<string>();
    for (const id of p.templateIds) {
      const t = templates.find((x) => x.id === id);
      if (!t) {
        missing++;
        continue;
      }
      const live = (latestLive(templates, t.formNumber) ?? t).id;
      // A form listed twice in the saved packet is added as a copy.
      const r = addToPacket(live, undefined, { duplicate: seen.has(live) });
      seen.add(live);
      if (r === 'full') {
        full = true;
        break;
      }
      if (r === 'added') added++;
      else present++;
    }
    countUse(p);
    if (full) toast.error(`A packet holds up to ${PACKET_LIMIT} forms, so only ${added} of ${p.templateIds.length} from “${p.name}” were added.`);
    else {
      const notes = [present && `${present} already in the packet`, missing && `${missing} no longer in the library`].filter(Boolean).join(', ');
      toast.ok(`Added ${added} ${added === 1 ? 'form' : 'forms'} from “${p.name}”${notes ? ` (${notes})` : ''}`);
    }
    navigate('/');
  }

  /** Soft delete, so Undo brings back the same packet (and ID). */
  async function remove(p: SavedPacket) {
    await services.packets.remove(p.id);
    await refreshPackets();
    toast.ok(`Deleted “${p.name}”`, {
      label: 'Undo',
      onClick: () =>
        services.packets
          .restore(p.id)
          .then(refreshPackets)
          .catch((e) => toast.error(e instanceof Error ? e.message : 'Could not restore the packet')),
    });
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
                      <span className="avatar" style={{ width: 40, height: 40, borderRadius: 'var(--r-card)', background: 'var(--accent-tint-2)', color: 'var(--accent-text)' }}>
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
                          { label: 'Add to current packet', icon: 'plus', onSelect: () => addToCurrent(p) },
                          ...(isMine || me?.role === 'Admin'
                            ? [
                                { label: p.shared ? 'Stop sharing' : 'Share with my groups', icon: 'people' as const, onSelect: async () => (await services.packets.save({ ...p, shared: !p.shared, groupIds: p.shared ? [] : [...myGroups] }), refreshPackets()) },
                                { label: 'Rename…', icon: 'pencil' as const, onSelect: () => setRenaming(p) },
                                { separator: true, label: '' },
                                { label: 'Delete…', icon: 'trash' as const, danger: true, onSelect: () => setDeleting(p) },
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
                      <Button variant="filled" icon="wand" disabled={!client} onClick={() => start(p)}>
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
      {deleting && (
        <ConfirmSheet title="Delete packet?" confirmLabel="Delete packet" onConfirm={() => remove(deleting)} onClose={() => setDeleting(undefined)}>
          Delete “{deleting.name}”{deleting.shared ? '? People you shared it with will lose it too.' : '?'} The forms themselves stay in the library.
        </ConfirmSheet>
      )}
      {renaming && (
        <NameSheet
          title="Rename packet"
          noun="packet"
          initial={renaming.name}
          existing={visible}
          exceptId={renaming.id}
          saveLabel="Rename"
          onSave={async (name) => (await services.packets.save({ ...renaming, name }), await refreshPackets(), toast.ok(`Renamed to “${name}”`))}
          onClose={() => setRenaming(undefined)}
        />
      )}
    </>
  );
}
