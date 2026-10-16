import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { findNameClash, nextFreeName } from '../../domain/drafts';
import type { SavedPacket } from '../../domain/types';
import { useServices } from '../../services';
import { US_STATES, availableIn, normalizeState, pickVariant } from '../../domain/states';
import { PACKET_LIMIT, currentTemplates, packetState, useApp } from '../../state/store';
import { Button, Field, IconButton, Select, Sheet, SwitchRow, TextInput, toast } from '../../ui/controls';
import { Icon } from '../../ui/Icon';
import { addForm } from '../common/addForm';
import { usePacketView } from '../common/usePacket';

/** The packet being assembled — Apple-style inspector on the right of Find forms. */
export function PacketInspector() {
  const packet = useApp((s) => s.packet);
  const client = useApp((s) => s.client);
  const removeFromPacket = useApp((s) => s.removeFromPacket);
  const moveInPacket = useApp((s) => s.moveInPacket);
  const setPacketAccount = useApp((s) => s.setPacketAccount);
  const clearPacket = useApp((s) => s.clearPacket);
  const setPacket = useApp((s) => s.setPacket);
  const replaceInPacket = useApp((s) => s.replaceInPacket);
  const templates = useApp((s) => s.templates);
  const view = usePacketView();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);

  const blocking = view?.checks.filter((c) => c.level === 'block').length ?? 0;
  const full = packet.items.length >= PACKET_LIMIT;
  const state = packetState(packet, client);
  const homeState = normalizeState(client?.contact.address1_stateorprovince);

  return (
    <aside className="card sticky inspector" aria-label="This packet">
      <div className="card-head" style={{ paddingBottom: 4 }}>
        <h2>This packet</h2>
        {packet.items.length > 0 && (
          <button className="btn btn-plain btn-sm" onClick={clearPacket}>
            Clear
          </button>
        )}
      </div>
      <div style={{ padding: '0 var(--sp-5) var(--sp-5)' }} className="stack-4">
        {packet.items.length === 0 ? (
          <div className="packet-empty">
            <Icon name="tray" size={34} />
            <p className="t-callout c2">Add forms with <span className="kbd">+</span> and they’ll collect here. Fields shared across forms are entered once.</p>
          </div>
        ) : (
          <>
            <p className="t-footnote c3">
              {packet.items.length} {packet.items.length === 1 ? 'form' : 'forms'} · {view?.totals.pages ?? 0} pages
            </p>
            <label className="row t-callout" style={{ gap: 8 }}>
              <span className="grow">Approved in</span>
              <Select
                aria-label="State the forms must be approved in"
                value={packet.state ?? ''}
                onChange={(e) => setPacket({ state: e.target.value || undefined })}
                style={{ width: 'auto', minHeight: 32, fontSize: 13 }}
              >
                <option value="">{homeState ? `${homeState} (client’s address)` : 'Choose a state…'}</option>
                {US_STATES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </label>
            <ol className="packet-list">
              {packet.items.map((item, i) => {
                const t = view?.templates.find((x) => x.id === item.templateId);
                const fill = view?.fills.find((f) => f.itemId === item.id);
                if (!t) return null;
                const name = item.copy ? `${t.name} (copy ${item.copy})` : t.name;
                const needsAccount = (!!t.appliesTo?.length || !!item.copy) && (client?.accounts.length ?? 0) > 1;
                return (
                  <li key={item.id}>
                    <div className="row" style={{ alignItems: 'flex-start' }}>
                      <span className="num tabular">{i + 1}</span>
                      <div className="grow" style={{ minWidth: 0 }}>
                        <div className="t-headline ellipsis">{name}</div>
                        <div className="t-footnote c3">
                          <span className="mono">{t.formNumber}</span>
                          {fill && fill.missingCount > 0 ? <span className="c-warn"> · {fill.missingCount} to fill</span> : <span className="c-accent"> · ready</span>}
                        </div>
                      </div>
                      <div className="row" style={{ gap: 0 }}>
                        <IconButton icon="chevronUp" label={`Move ${name} up`} size={15} disabled={i === 0} onClick={() => moveInPacket(item.id, -1)} />
                        <IconButton icon="chevronDown" label={`Move ${name} down`} size={15} disabled={i === packet.items.length - 1} onClick={() => moveInPacket(item.id, 1)} />
                        <IconButton icon="x" label={`Remove ${name}`} size={15} onClick={() => removeFromPacket(item.id)} />
                      </div>
                    </div>
                    {!availableIn(t, state) && (
                      <div className="row t-footnote c-warn" style={{ marginTop: 6, gap: 6 }}>
                        <Icon name="warning" size={13} />
                        <span className="grow">Not approved in {state}</span>
                        {(() => {
                          const v = t.variantGroup ? pickVariant(currentTemplates(templates), t.variantGroup, state) : undefined;
                          return v && v.id !== t.id ? (
                            <button className="btn btn-plain btn-sm" onClick={() => replaceInPacket(item.id, v.id)}>
                              Use the {state} version
                            </button>
                          ) : null;
                        })()}
                      </div>
                    )}
                    {needsAccount && (
                      <Select aria-label={`Account for ${name}`} value={item.accountId ?? ''} onChange={(e) => setPacketAccount(item.id, e.target.value)} style={{ marginTop: 8, minHeight: 32, fontSize: 13 }}>
                        <option value="" disabled>
                          Choose account…
                        </option>
                        {client!.accounts.map((a) => (
                          <option key={a.accountid} value={a.accountid}>
                            {a.name} · {a.ev_accountno}
                          </option>
                        ))}
                      </Select>
                    )}
                    <button className="btn btn-plain btn-sm" style={{ marginTop: 4, paddingLeft: 0 }} disabled={full} title={full ? `A packet holds up to ${PACKET_LIMIT} forms` : undefined} onClick={() => addForm(t.id, undefined, { duplicate: true })}>
                      <Icon name="plus" size={13} /> Add another copy
                    </button>
                  </li>
                );
              })}
            </ol>
            {view && (
              <div className="stack" style={{ borderTop: '0.5px solid var(--separator)', paddingTop: 12 }}>
                <div className="row t-callout">
                  <span className="grow">Filled from CRM</span>
                  <strong className="tabular">
                    {view.totals.filled} of {view.totals.fields}
                  </strong>
                </div>
                <div className="row t-callout">
                  <span className="grow">Needs your input</span>
                  <strong className={['tabular', view.totals.missing ? 'c-warn' : 'c-accent'].join(' ')}>{view.totals.missing || 'None'}</strong>
                </div>
                <div className="row t-callout">
                  <span className="grow">Pre-send checks</span>
                  <strong className={blocking ? 'c-warn' : 'c-accent'}>{blocking ? `${blocking} to fix` : 'All clear'}</strong>
                </div>
              </div>
            )}
            <Button variant="filled" size="lg" block icon="wand" onClick={() => navigate('/review')}>
              Prefill & review
            </Button>
            <Button variant="bordered" block icon="tray" onClick={() => setSaving(true)}>
              Save as packet
            </Button>
            <p className="t-footnote c3">Drafts save to {client?.contact.firstname}’s SharePoint folder. Nothing goes to the client until you send.</p>
          </>
        )}
      </div>
      {saving && <SavePacketSheet onClose={() => setSaving(false)} />}
    </aside>
  );
}

function SavePacketSheet({ onClose }: { onClose: () => void }) {
  const packet = useApp((s) => s.packet);
  const me = useApp((s) => s.me);
  const groups = useApp((s) => s.groups);
  const packets = useApp((s) => s.packets);
  const refreshPackets = useApp((s) => s.refreshPackets);
  const services = useServices();
  const [name, setName] = useState(packet.title || '');
  const [desc, setDesc] = useState('');
  const [shared, setShared] = useState(false);
  const [groupIds, setGroupIds] = useState<string[]>(me?.groupIds ?? []);
  const [busy, setBusy] = useState<string>();
  const [clash, setClash] = useState<SavedPacket>();
  const myGroups = groups.filter((g) => g.memberIds.includes(me?.systemuserid ?? ''));
  // Your own packets and the shared ones you can see: the names you'd confuse.
  const mine = new Set(myGroups.map((g) => g.id));
  const visible = packets.filter((p) => p.owner === me?.fullname || (p.shared && (!p.groupIds?.length || p.groupIds.some((g) => mine.has(g)))));
  const canReplace = (p: SavedPacket) => p.owner === me?.fullname || me?.role === 'Admin';
  const alt = nextFreeName(name, visible.map((p) => p.name));

  async function save(finalName: string, replacing?: SavedPacket) {
    if (busy) return; // one save at a time
    setBusy(replacing ? 'replace' : 'save');
    const p: SavedPacket = {
      ...replacing,
      id: replacing?.id ?? `new-${Date.now()}`,
      name: finalName,
      description: desc.trim() || undefined,
      templateIds: packet.items.map((i) => i.templateId),
      shared,
      groupIds: shared ? groupIds : [],
      owner: replacing?.owner ?? me?.fullname ?? '',
      createdOn: replacing?.createdOn ?? new Date().toISOString(),
      usedCount: replacing?.usedCount ?? 0,
    };
    try {
      await services.packets.save(p);
      await refreshPackets();
      toast.ok(replacing ? `Replaced “${p.name}”` : `Saved “${p.name}”`);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the packet');
    } finally {
      setBusy(undefined);
    }
  }

  function submit() {
    const c = findNameClash(name, visible);
    if (c) setClash(c);
    else void save(name.trim().replace(/\s+/g, ' '));
  }

  return (
    <Sheet
      title="Save as packet"
      onClose={onClose}
      footer={
        clash ? (
          <>
            <Button variant="gray" disabled={!!busy} onClick={() => setClash(undefined)}>
              Change name
            </Button>
            {canReplace(clash) && (
              <Button variant="bordered" disabled={!!busy} busy={busy === 'replace'} onClick={() => save(clash.name, clash)}>
                Replace it
              </Button>
            )}
            <Button variant="filled" disabled={!!busy} busy={busy === 'save'} onClick={() => save(alt)}>
              Save as “{alt}”
            </Button>
          </>
        ) : (
          <>
            <Button variant="gray" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="filled" onClick={submit} disabled={!name.trim()} busy={busy === 'save'}>
              Save packet
            </Button>
          </>
        )
      }
    >
      <div className="stack-4">
        <p className="t-callout c2">A packet is a reusable list of forms. It always opens with the current revision of each form.</p>
        <Field label="Name" htmlFor="pk-name">
          <TextInput id="pk-name" value={name} onChange={(e) => (setName(e.target.value), setClash(undefined))} placeholder="e.g. Retirement income set-up" />
        </Field>
        {clash && (
          <div className="banner" role="alert">
            <Icon name="warning" size={16} />
            <span className="t-callout">
              {canReplace(clash) ? `You already have a packet called “${clash.name}”. Replace it with these forms?` : `${clash.owner} has a shared packet called “${clash.name}”.`}
            </span>
          </div>
        )}
        <Field label="Description" htmlFor="pk-desc" optional>
          <TextInput id="pk-desc" value={desc} onChange={(e) => setDesc(e.target.value)} />
        </Field>
        <div className="list">
          <SwitchRow label="Share with my groups" detail="Others in the group can start from this packet." checked={shared} onChange={setShared} />
          {shared &&
            myGroups.map((g) => (
              <label key={g.id} className="list-row" style={{ cursor: 'pointer' }}>
                <input type="checkbox" className="check" checked={groupIds.includes(g.id)} onChange={(e) => setGroupIds(e.target.checked ? [...groupIds, g.id] : groupIds.filter((x) => x !== g.id))} />
                <span className="grow">{g.name}</span>
                <span className="t-footnote c3">{g.memberIds.length} people</span>
              </label>
            ))}
        </div>
      </div>
    </Sheet>
  );
}
