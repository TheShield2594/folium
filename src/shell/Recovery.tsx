import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useBlocker } from 'react-router-dom';
import { defaultDraftTitle } from '../domain/drafts';
import { draftsAllowed, retentionDays } from '../domain/requests';
import { usePacketView } from '../screens/common/usePacket';
import { useServices } from '../services';
import { connectionProblem, subscribeConnection } from '../services/errors';
import { autosaveEligible, autosaveNow } from '../state/autosave';
import { countdown, DEFAULT_IDLE_MINUTES, idleState, WARNING_MS } from '../state/idle';
import { ago } from '../state/journal';
import { saveDraft } from '../state/actions';
import { useActingFor, useApp, type LeaveChoice } from '../state/store';
import { noteRow } from '../state/versions';
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

/** Save the open packet as a draft (the same as Save draft in Review), from anywhere in the app. */
function useSaveOpenPacket() {
  const packet = useApp((s) => s.packet);
  const contactId = useApp((s) => s.contactId);
  const me = useApp((s) => s.me);
  const requests = useApp((s) => s.requests);
  const setPacket = useApp((s) => s.setPacket);
  const refreshRequests = useApp((s) => s.refreshRequests);
  const owner = useActingFor();
  const view = usePacketView();
  const services = useServices();
  const ready = !!(view && contactId && me && owner);

  async function save(auditNote?: string) {
    if (!view || !contactId || !me || !owner) throw new Error('Nothing to save');
    const existing = packet.requestId ? requests.find((r) => r.id === packet.requestId) : undefined;
    const title = packet.title || existing?.title || defaultDraftTitle(view.fills);
    const saved = await saveDraft({
      services,
      packet: { ...packet, title },
      fills: view.fills,
      contactId,
      me,
      owner,
      existing,
      writePdfs: true,
      trackUsage: true,
      auditNote,
      retentionDays: retentionDays(useApp.getState().policy),
      // Keep the row's identity even if the PDFs fail, so the next save updates it.
      onSaved: (row) => setPacket({ requestId: row.id, title: row.title, attachments: row.attachments, snapshot: row.prefillSnapshot, formsUpdated: undefined, dirty: false }),
    });
    setPacket({ requestId: saved.id, title: saved.title, attachments: saved.attachments, snapshot: saved.prefillSnapshot, formsUpdated: undefined, pdfsBehind: undefined, dirty: false });
    await refreshRequests().catch(() => undefined);
    return saved;
  }
  return { save, ready };
}

/**
 * Optional (firm setting): when unsaved work sits idle, count down for 2 minutes in a
 * banner and the tab title, then save it as a draft. Any activity cancels the countdown.
 * Unlike Laser App's idle logout, nothing is lost and the advisor stays signed in.
 */
export function IdleAutoSave() {
  const firm = useApp((s) => s.firm);
  // Autosave keeps the row current but not the PDFs: an idle packet it saved still gets them.
  const dirty = useApp((s) => (!!s.packet.dirty || !!s.packet.pdfsBehind) && s.packet.items.length > 0 && !s.packet.send);
  // No auto-save when the firm keeps no drafts (retention 0).
  const policy = useApp((s) => s.policy);
  const enabled = !!firm?.idleAutoSave && draftsAllowed(policy) && dirty;
  const idleMs = (firm?.idleAutoSaveMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000;
  const { save, ready } = useSaveOpenPacket();
  const saveRef = useRef(save);
  saveRef.current = save;
  const lastActivity = useRef(Date.now());
  const saving = useRef(false);
  const [remaining, setRemaining] = useState<number>();

  // Activity resets the clock (and hides the countdown).
  useEffect(() => {
    if (!enabled) return;
    lastActivity.current = Date.now();
    const onActivity = () => {
      lastActivity.current = Date.now();
      setRemaining((r) => (r === undefined ? r : undefined));
    };
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true, capture: true }));
    return () => events.forEach((e) => window.removeEventListener(e, onActivity, { capture: true }));
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !ready) {
      setRemaining(undefined);
      return;
    }
    const tick = () => {
      const st = idleState(lastActivity.current, Date.now(), idleMs, WARNING_MS);
      if (st.phase === 'active') return setRemaining(undefined);
      if (st.phase === 'warning') return setRemaining(st.remainingMs);
      if (saving.current) return;
      saving.current = true;
      setRemaining(undefined);
      saveRef
        .current(`saved automatically after ${Math.round(idleMs / 60_000)} minutes idle`)
        .then((r) => toast.ok(`Saved “${r.title}” to Drafts while you were away`))
        .catch((e) => toast.error(e instanceof Error ? `Couldn’t save your draft automatically: ${e.message}` : 'Couldn’t save your draft automatically'))
        .finally(() => {
          saving.current = false;
          // Don't try again until the advisor is back and leaves it idle again.
          lastActivity.current = Date.now();
        });
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [enabled, ready, idleMs]);

  // Countdown in the tab title, so it shows while the advisor is in another tab.
  useEffect(() => {
    if (remaining === undefined) return;
    const original = document.title;
    document.title = `(${countdown(remaining)}) Saving draft – ${original}`;
    return () => {
      document.title = original;
    };
  }, [remaining]);

  if (remaining === undefined) return null;
  return (
    <div className="banner app-banner" role="status" aria-live="polite">
      <Icon name="clock" size={18} />
      <span className="grow t-callout">
        You’ve been away a while. Folium will save this packet as a draft in <strong className="tabular">{countdown(remaining)}</strong>.
      </span>
      <Button variant="filled" size="sm" onClick={() => (lastActivity.current = Date.now(), setRemaining(undefined))}>
        I’m still here
      </Button>
    </div>
  );
}

/** "7:24 PM" */
const timeOf = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '');

/** Autosave's state for the toolbar: "Saving…", "Saved", a failed save to retry, or someone else's save to settle. */
export function AutosaveStatus() {
  const status = useApp((s) => s.autosave);
  const pending = useApp((s) => autosaveEligible(s));
  const saved = useApp((s) => !s.packet.dirty && !!s.packet.requestId && s.packet.items.length > 0);
  const [settling, setSettling] = useState(false);

  let body: ReactNode = null;
  if (status.phase === 'conflict') {
    body = (
      <Button variant="plain" size="sm" icon="warning" onClick={() => setSettling(true)}>
        {status.conflict?.reason === 'gone' ? 'Draft deleted' : 'Changed elsewhere'}
      </Button>
    );
  } else if (status.phase === 'error' && pending) {
    body = (
      <Button variant="plain" size="sm" icon="refresh" title={status.error} onClick={() => void autosaveNow()}>
        Not saved, retry
      </Button>
    );
  } else if (status.phase === 'saving' || pending) {
    body = <span className="t-footnote c3">Saving…</span>;
  } else if (saved) {
    body = (
      <span className="t-footnote c3" title={status.at ? `Saved at ${timeOf(status.at)}` : undefined}>
        <Icon name="check" size={13} /> Saved
      </span>
    );
  }
  return (
    <>
      <span role="status" aria-live="polite" className="hide-narrow" style={{ whiteSpace: 'nowrap' }}>
        {body}
      </span>
      {settling && status.conflict && <ConflictSheet conflict={status.conflict} onClose={() => setSettling(false)} />}
    </>
  );
}

/** Keep what's on screen as a new draft, when the one it came from was deleted or sent. */
function saveAsNew() {
  useApp.getState().setPacket({ requestId: undefined, autoNamed: undefined, pdfsBehind: undefined, sharedWith: [], snapshot: undefined, dirty: true });
  void autosaveNow();
}

/** Someone saved the open draft since this tab did, sent it, or deleted it: the advisor picks which work stands. */
function ConflictSheet({ conflict, onClose }: { conflict: NonNullable<ReturnType<typeof useApp.getState>['autosave']['conflict']>; onClose: () => void }) {
  const row = conflict.reason === 'changed' ? conflict.row : undefined;
  const last = row?.audit.at(-1);
  const who = last?.actor ?? 'Someone';
  const at = last ? ` at ${timeOf(last.at)}` : '';
  // Gone, or no longer a draft: what's on screen can only become a new draft.
  const closed = !row || row.status !== 'Drafted';
  const title = !row ? 'This draft was deleted' : closed ? 'This draft was sent' : 'Saved somewhere else';
  const body = !row
    ? 'Someone deleted this draft while you were working on it. What’s on screen hasn’t been saved since.'
    : closed
      ? `${who} ${row.status === 'Voided' ? 'voided' : 'sent'} this packet${at}, so your changes can’t be saved to it.`
      : `${who} saved this draft${at}, after you opened it. Autosave has stopped so neither of you loses work.`;
  const footer = closed ? (
    <>
      <Button variant="gray" onClick={onClose}>
        Not now
      </Button>
      <Button variant="filled" onClick={() => (onClose(), saveAsNew())}>
        Save as a new draft
      </Button>
    </>
  ) : (
    <>
      <Button variant="gray" onClick={onClose}>
        Not now
      </Button>
      <Button
        variant="bordered"
        onClick={() => {
          onClose();
          // Write what's on screen over theirs: take their row as the one this tab knows.
          noteRow(row);
          void autosaveNow();
        }}
      >
        Keep mine
      </Button>
      <Button
        variant="filled"
        onClick={() => {
          onClose();
          useApp.getState().loadRequest(row);
          useApp.setState({ autosave: { phase: 'saved', at: last?.at } });
        }}
      >
        Open their version
      </Button>
    </>
  );
  return (
    <Sheet title={title} onClose={onClose} footer={footer}>
      <p className="t-callout">{body}</p>
      {!closed && <p className="t-footnote c3">Open their version to carry on from what they saved, or keep yours to save over it.</p>}
    </Sheet>
  );
}

function LeavePacketSheet({ reason, onChoice }: { reason: 'switch' | 'open-draft' | 'navigate'; onChoice: (c: LeaveChoice) => void }) {
  const client = useApp((s) => s.client);
  const canSave = draftsAllowed(useApp((s) => s.policy));
  const { save: saveOpen, ready } = useSaveOpenPacket();
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!ready) return;
    setBusy(true);
    try {
      const saved = await saveOpen();
      toast.ok(`Saved “${saved.title}” to Drafts`);
      onChoice('save');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the draft');
      setBusy(false);
    }
  }

  const who = client?.contact.firstname ? `${client.contact.firstname}’s` : 'this';
  const body = !canSave
    ? `You have unsaved changes to ${who} packet. Your firm doesn’t keep drafts, so they’ll be lost if you ${reason === 'navigate' ? 'close Folium' : 'go on'}.`
    : reason === 'navigate'
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
          {canSave && (
            <Button variant="filled" busy={busy} disabled={!ready} onClick={save}>
              Save draft
            </Button>
          )}
        </>
      }
    >
      <p className="t-callout">{body}</p>
    </Sheet>
  );
}
