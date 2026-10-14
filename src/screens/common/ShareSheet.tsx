import { useState } from 'react';
import { useServices } from '../../services';
import { canShareWith } from '../../domain/policy';
import { retentionDays } from '../../domain/requests';
import { saveDraft, type SendSetup } from '../../state/actions';
import { useActingFor, useApp } from '../../state/store';
import { Avatar, Button, SearchField, Sheet, toast } from '../../ui/controls';
import { usePacketView } from './usePacket';

/**
 * Share the packet in progress with colleagues: it's saved as a draft they can open from
 * "Drafts & shared", with every value entered so far. Who can be added follows the firm's
 * sharing policy (`canShareWith`): people in your groups, or anyone with Folium. People in
 * your groups are listed first.
 */
export function ShareSheet({ onClose, sendSetup }: { onClose: () => void; sendSetup?: SendSetup }) {
  const users = useApp((s) => s.users);
  const groups = useApp((s) => s.groups);
  const me = useApp((s) => s.me);
  const packet = useApp((s) => s.packet);
  const setPacket = useApp((s) => s.setPacket);
  const contactId = useApp((s) => s.contactId);
  const requests = useApp((s) => s.requests);
  const refreshRequests = useApp((s) => s.refreshRequests);
  const owner = useActingFor();
  const view = usePacketView();
  const services = useServices();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>(packet.sharedWith);
  const [busy, setBusy] = useState(false);

  const myGroupIds = new Set(groups.filter((g) => g.memberIds.includes(me?.systemuserid ?? '')).map((g) => g.id));
  const policy = useApp((s) => s.policy);
  // Who the firm's sharing policy allows, plus anyone already on the draft so they can be taken off.
  const people = users
    .filter((u) => !!me && (canShareWith(me, u, groups, policy) || (packet.sharedWith.includes(u.systemuserid) && u.systemuserid !== me.systemuserid)))
    .filter((u) => !q || u.fullname.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => Number(b.groupIds.some((g) => myGroupIds.has(g))) - Number(a.groupIds.some((g) => myGroupIds.has(g))) || a.fullname.localeCompare(b.fullname));

  async function share() {
    if (!view || !contactId || !me || !owner) return;
    setBusy(true);
    try {
      const next = { ...packet, sharedWith: picked };
      const existing = packet.requestId ? requests.find((r) => r.id === packet.requestId) : undefined;
      const saved = await saveDraft({ services, packet: next, fills: view.fills, contactId, me, owner, existing, sendSetup, retentionDays: retentionDays(useApp.getState().policy) });
      setPacket({ sharedWith: picked, requestId: saved.id, attachments: saved.attachments, snapshot: saved.prefillSnapshot, formsUpdated: undefined, dirty: false });
      await refreshRequests();
      const names = users.filter((u) => picked.includes(u.systemuserid)).map((u) => u.fullname.split(' ')[0]);
      toast.ok(picked.length ? `Shared with ${names.join(', ')}` : 'Sharing turned off');
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not share');
      setBusy(false);
    }
  }

  return (
    <Sheet
      title="Share this packet"
      onClose={onClose}
      footer={
        <>
          <Button variant="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="filled" icon="share" busy={busy} onClick={share}>
            {picked.length ? `Share with ${picked.length}` : 'Save'}
          </Button>
        </>
      }
    >
      <div className="stack-4">
        <p className="t-callout c2">
          They’ll find it in Drafts & shared with everything filled in so far, and can review, change or send it.
          {policy.sharing === 'groups' ? ' You can share with people in your groups.' : ''}
        </p>
        <SearchField value={q} onChange={setQ} placeholder="Search people" label="Search people" />
        <div className="list">
          {people.map((u) => (
            <label key={u.systemuserid} className="list-row" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                className="check"
                checked={picked.includes(u.systemuserid)}
                onChange={(e) => setPicked(e.target.checked ? [...picked, u.systemuserid] : picked.filter((x) => x !== u.systemuserid))}
              />
              <Avatar name={u.fullname} size={28} alt={u.role !== 'User'} />
              <span className="grow">
                <span style={{ display: 'block', fontWeight: 600 }}>{u.fullname}</span>
                <span className="t-footnote c3">
                  {u.role} · {u.branch}
                </span>
              </span>
            </label>
          ))}
          {people.length === 0 && <div className="list-row t-callout c3">{q ? 'Nobody matches.' : 'Nobody in your groups uses Folium yet.'}</div>}
        </div>
      </div>
    </Sheet>
  );
}
