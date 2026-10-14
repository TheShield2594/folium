import { useEffect, useState, useSyncExternalStore } from 'react';
import { useBlocker } from 'react-router-dom';
import { defaultDraftTitle } from '../domain/drafts';
import { usePacketView } from '../screens/common/usePacket';
import { useServices } from '../services';
import { connectionProblem, subscribeConnection } from '../services/errors';
import { ago } from '../state/journal';
import { saveDraft } from '../state/actions';
import { useActingFor, useApp, type LeaveChoice } from '../state/store';
import { Button, Sheet, toast } from '../ui/controls';
import { Icon } from '../ui/Icon';

/** One app-level banner for sign-in and connection trouble, instead of a stream of toasts. */
export function ConnectionBanner() {
  const problem = useSyncExternalStore(subscribeConnection, connectionProblem);
  if (problem === 'auth') {
    return (
      <div className="banner app-banner" role="alert">
        <Icon name="warning" size={18} />
        <span className="grow t-callout">Your sign-in expired. Your work is saved on this device. Reload to sign in again.</span>
        <Button variant="filled" size="sm" icon="refresh" onClick={() => location.reload()}>
          Reload
        </Button>
      </div>
    );
  }
  if (problem === 'offline') {
    return (
      <div className="banner app-banner" role="status">
        <Icon name="warning" size={18} />
        <span className="grow t-callout">No connection. Retrying…</span>
      </div>
    );
  }
  return null;
}

/** Offer back the packet the session journal kept from before a reload. */
export function RestoreBanner() {
  const pending = useApp((s) => s.pendingRestore);
  const restore = useApp((s) => s.restoreJournal);
  const discard = useApp((s) => s.discardJournal);
  const [busy, setBusy] = useState(false);
  if (!pending) return null;
  const forms = pending.packet.items.length;
  return (
    <div className="banner info app-banner" role="status">
      <Icon name="refresh" size={18} />
      <span className="grow t-callout">
        Restore unsaved packet{pending.contactName ? ` for ${pending.contactName}` : ''} ({forms} {forms === 1 ? 'form' : 'forms'}, {ago(pending.savedAt)})?
        {pending.packet.send && ' A DocuSign send was in progress.'}
      </span>
      <Button variant="gray" size="sm" disabled={busy} onClick={discard}>
        Discard
      </Button>
      <Button
        variant="filled"
        size="sm"
        busy={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await restore();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Could not restore the packet');
          } finally {
            setBusy(false);
          }
        }}
      >
        Restore
      </Button>
    </div>
  );
}

const ROUTE_GUARDED = /^\/(review|send)(\/|$)/;
const ROUTE_LEAVING = /^\/(admin|settings)(\/|$)/;

/**
 * Ask before unsaved work is lost: closing or reloading the tab, leaving Review or
 * Send for Admin and Settings, switching clients, or opening another draft.
 */
export function UnsavedGuards() {
  const dirty = useApp((s) => !!s.packet.dirty && s.packet.items.length > 0);
  const prompt = useApp((s) => s.leavePrompt);

  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && ROUTE_GUARDED.test(currentLocation.pathname) && ROUTE_LEAVING.test(nextLocation.pathname));

  if (prompt) return <LeavePacketSheet reason={prompt.reason} onChoice={prompt.resolve} />;
  if (blocker.state === 'blocked') {
    return <LeavePacketSheet reason="navigate" onChoice={(c) => (c === 'cancel' ? blocker.reset() : blocker.proceed())} />;
  }
  return null;
}

function LeavePacketSheet({ reason, onChoice }: { reason: 'switch' | 'open-draft' | 'navigate'; onChoice: (c: LeaveChoice) => void }) {
  const packet = useApp((s) => s.packet);
  const contactId = useApp((s) => s.contactId);
  const client = useApp((s) => s.client);
  const me = useApp((s) => s.me);
  const requests = useApp((s) => s.requests);
  const setPacket = useApp((s) => s.setPacket);
  const refreshRequests = useApp((s) => s.refreshRequests);
  const owner = useActingFor();
  const view = usePacketView();
  const services = useServices();
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!view || !contactId || !me || !owner) return;
    setBusy(true);
    try {
      const existing = packet.requestId ? requests.find((r) => r.id === packet.requestId) : undefined;
      const title = packet.title || existing?.title || defaultDraftTitle(view.fills);
      const saved = await saveDraft({ services, packet: { ...packet, title }, fills: view.fills, contactId, me, owner, existing, writePdfs: true });
      setPacket({ requestId: saved.id, title: saved.title, attachments: saved.attachments, snapshot: saved.prefillSnapshot, dirty: false });
      await refreshRequests().catch(() => undefined);
      toast.ok(`Saved “${saved.title}” to Drafts`);
      onChoice('save');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the draft');
      setBusy(false);
    }
  }

  const who = client?.contact.firstname ? `${client.contact.firstname}’s` : 'this';
  const body =
    reason === 'navigate'
      ? `You have unsaved changes to ${who} packet. It stays open while you’re away, but save a draft if you might close Folium.`
      : reason === 'switch'
        ? `Opening another client closes ${who} packet. Save it as a draft first?`
        : `This replaces ${who} packet on screen. Save it as a draft first?`;

  return (
    <Sheet
      title="Save your changes?"
      onClose={() => !busy && onChoice('cancel')}
      footer={
        <>
          <Button variant="gray" disabled={busy} onClick={() => onChoice('cancel')}>
            Cancel
          </Button>
          <Button variant="bordered" disabled={busy} onClick={() => onChoice('discard')}>
            {reason === 'navigate' ? 'Leave without saving' : 'Discard'}
          </Button>
          <Button variant="filled" busy={busy} onClick={save}>
            Save draft
          </Button>
        </>
      }
    >
      <p className="t-callout">{body}</p>
    </Sheet>
  );
}
