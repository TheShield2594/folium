import { useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { ANNOUNCEMENT_MAX, announcementPhase, announcementProblems, canDismiss, SEVERITY_LABEL, type Announcement, type AnnouncementSeverity } from '../../domain/announcements';
import type { UserGroup } from '../../domain/types';
import { useServices } from '../../services';
import { AnnouncementText } from '../../shell/Announcements';
import { Toolbar } from '../../shell/Shell';
import { useApp } from '../../state/store';
import { Badge, Button, ConfirmSheet, Empty, Field, Segmented, Sheet, SwitchRow, TextArea, TextInput, toast } from '../../ui/controls';
import { Icon } from '../../ui/Icon';

const TONE: Record<AnnouncementSeverity, 'info' | 'warn' | 'danger'> = { info: 'info', warn: 'warn', critical: 'danger' };
const PHASES = [
  { key: 'live', title: 'Showing now' },
  { key: 'scheduled', title: 'Scheduled' },
  { key: 'past', title: 'Past' },
] as const;

/** An ISO time as a `datetime-local` value, in the viewer's time zone. */
function toLocalInput(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : '');

const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

function audience(a: Pick<Announcement, 'groupIds'>, groups: UserGroup[]): string {
  if (!a.groupIds?.length) return 'Everyone';
  const names = a.groupIds.map((id) => groups.find((g) => g.id === id)?.name ?? 'a removed group');
  return names.join(', ');
}

/** Administration › Announcements: messages shown across the top of Folium. */
export function AdminAnnouncements() {
  const me = useApp((s) => s.me);
  const list = useApp((s) => s.announcements);
  const groups = useApp((s) => s.groups);
  const refresh = useApp((s) => s.refreshAnnouncements);
  const services = useServices();
  const [editing, setEditing] = useState<Announcement>();
  const [removing, setRemoving] = useState<Announcement>();
  const now = new Date();
  const byPhase = useMemo(() => {
    const out = { live: [] as Announcement[], scheduled: [] as Announcement[], past: [] as Announcement[] };
    for (const a of list) out[announcementPhase(a, new Date())].push(a);
    out.scheduled.sort((a, b) => a.startsOn.localeCompare(b.startsOn));
    out.past.sort((a, b) => (b.endsOn ?? '').localeCompare(a.endsOn ?? ''));
    return out;
  }, [list]);
  if (me?.role !== 'Admin') return <Navigate to="/" replace />;

  const blank = (): Announcement => ({ id: `new-${Date.now()}`, message: '', severity: 'info', startsOn: new Date().toISOString(), dismissible: true, createdBy: me.fullname, createdOn: new Date().toISOString() });

  async function save(a: Announcement) {
    const isNew = !list.some((x) => x.id === a.id);
    await services.directory.saveAnnouncement(isNew ? a : { ...a, modifiedBy: me!.fullname, modifiedOn: new Date().toISOString() });
    await refresh(true);
    toast.ok(isNew ? (announcementPhase(a, new Date()) === 'scheduled' ? `Scheduled for ${fmt(a.startsOn)}` : 'Announcement published') : 'Announcement saved');
  }

  async function endNow(a: Announcement) {
    try {
      await save({ ...a, endsOn: new Date().toISOString() });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not end the announcement');
    }
  }

  return (
    <>
      <Toolbar title="Announcements">
        <Button variant="filled" icon="plus" onClick={() => setEditing(blank())}>
          New announcement
        </Button>
      </Toolbar>
      <div className="scroll">
        <div className="page page-narrow stack-5">
          <div>
            <h1 className="t-large">Announcements</h1>
            <p className="t-callout c2" style={{ marginTop: 4 }}>
              A message across the top of Folium for everyone, or for some groups: a form revision taking effect, a DocuSign outage, a change to OnBase filing. Up to two show at once, critical first. Past announcements stay here as a record of what people were told.
            </p>
          </div>
          {!list.length && (
            <Empty icon="bell" title="No announcements yet" action={<Button variant="tinted" onClick={() => setEditing(blank())}>New announcement</Button>}>
              Schedule one ahead of time and it shows, and removes itself, on its own.
            </Empty>
          )}
          {PHASES.map(({ key, title }) =>
            byPhase[key].length ? (
              <section key={key} className="stack-3" aria-labelledby={`ann-${key}`}>
                <h2 id={`ann-${key}`} className="t-title3">
                  {title} <span className="c3 tabular">{byPhase[key].length}</span>
                </h2>
                <div className="list">
                  {byPhase[key].map((a) => (
                    <div key={a.id} className="list-row" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
                      <div className="grow stack" style={{ gap: 4, minWidth: 220 }}>
                        <div className="row wrap" style={{ gap: 6 }}>
                          <Badge tone={TONE[a.severity]}>{SEVERITY_LABEL[a.severity]}</Badge>
                          <span className="t-footnote c3">
                            {audience(a, groups)} · {fmt(a.startsOn)}
                            {a.endsOn ? ` to ${fmt(a.endsOn)}` : ', until removed'}
                            {canDismiss(a) ? '' : ' · can’t be dismissed'}
                            {a.postToTeams ? ' · posted to Teams' : ''}
                          </span>
                        </div>
                        <p className="t-callout announcement-text" style={{ margin: 0 }}>
                          <AnnouncementText message={a.message} />
                        </p>
                        <span className="t-caption c3">
                          {a.modifiedBy ? `Changed by ${a.modifiedBy} ${fmt(a.modifiedOn)}` : `By ${a.createdBy} ${fmt(a.createdOn)}`}
                        </span>
                      </div>
                      <div className="row" style={{ gap: 6 }}>
                        {key === 'live' && (
                          <Button variant="gray" size="sm" onClick={() => endNow(a)}>
                            End now
                          </Button>
                        )}
                        <Button variant="gray" size="sm" onClick={() => setEditing(key === 'past' ? { ...blank(), message: a.message, severity: a.severity, groupIds: a.groupIds, dismissible: a.dismissible } : a)}>
                          {key === 'past' ? 'Use again' : 'Edit'}
                        </Button>
                        <Button variant="plain" size="sm" onClick={() => setRemoving(a)} aria-label={`Remove announcement: ${a.message.slice(0, 40)}`}>
                          Remove
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null,
          )}
          <p className="t-footnote c3">
            Times are in your time zone ({Intl.DateTimeFormat().resolvedOptions().timeZone}). People see a new announcement when they open Folium or come back to it, within 15 minutes. It’s {now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} now.
          </p>
        </div>
      </div>
      {editing && <AnnouncementSheet value={editing} groups={groups} onClose={() => setEditing(undefined)} onSave={save} />}
      {removing && (
        <ConfirmSheet
          title="Remove this announcement?"
          confirmLabel="Remove"
          onClose={() => setRemoving(undefined)}
          onConfirm={async () => {
            await services.directory.removeAnnouncement(removing.id);
            await refresh(true);
            toast.ok('Announcement removed');
          }}
        >
          It disappears for everyone and is deleted from Dataverse. To keep it on record, use End now instead.
        </ConfirmSheet>
      )}
    </>
  );
}

function AnnouncementSheet({ value, groups, onClose, onSave }: { value: Announcement; groups: UserGroup[]; onClose: () => void; onSave: (a: Announcement) => Promise<void> }) {
  const [a, setA] = useState(value);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const set = (patch: Partial<Announcement>) => setA((x) => ({ ...x, ...patch }));
  const problems = announcementProblems(a);
  const ok = !Object.keys(problems).length;
  const isNew = value.message === '' || value.id.startsWith('new-');
  const critical = a.severity === 'critical';

  async function save() {
    setTried(true);
    if (!ok) return;
    setBusy(true);
    try {
      await onSave(a);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the announcement');
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={isNew ? 'New announcement' : 'Edit announcement'}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="spacer" />
          <Button variant="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="filled" busy={busy} onClick={save}>
            {announcementPhase(a, new Date()) === 'scheduled' ? 'Schedule' : isNew ? 'Publish' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="stack-4">
        <Field label="Message" htmlFor="ann-msg" help={`${a.message.length.toLocaleString()} / ${ANNOUNCEMENT_MAX.toLocaleString()} · Plain text. Web addresses (https://…) become links.`} error={tried ? problems.message : undefined}>
          <TextArea id="ann-msg" rows={4} maxLength={ANNOUNCEMENT_MAX} value={a.message} onChange={(e) => set({ message: e.target.value })} />
        </Field>
        <Field label="Severity" help={critical ? 'Critical stays until it ends: people can’t dismiss it, and screen readers announce it straight away.' : a.severity === 'warn' ? 'For something people need to act on or work around.' : 'For news people can read and dismiss.'}>
          <Segmented
            label="Severity"
            value={a.severity}
            options={(Object.keys(SEVERITY_LABEL) as AnnouncementSeverity[]).map((k) => ({ value: k, label: SEVERITY_LABEL[k] }))}
            onChange={(severity) => set({ severity })}
          />
        </Field>
        <div className="grid-2">
          <Field label="Starts" htmlFor="ann-start" error={tried ? problems.startsOn : undefined}>
            <TextInput id="ann-start" type="datetime-local" value={toLocalInput(a.startsOn)} onChange={(e) => set({ startsOn: fromLocalInput(e.target.value) })} />
          </Field>
          <Field label="Ends" htmlFor="ann-end" optional help="Empty: until you end or remove it." error={tried ? problems.endsOn : undefined}>
            <TextInput id="ann-end" type="datetime-local" value={toLocalInput(a.endsOn)} onChange={(e) => set({ endsOn: fromLocalInput(e.target.value) || undefined })} />
          </Field>
        </div>
        <fieldset className="list" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label" style={{ padding: '0 0 6px 2px' }}>
            Who sees it <span className="t-footnote c3">{a.groupIds?.length ? '' : '· everyone'}</span>
          </legend>
          {groups.map((g) => (
            <label key={g.id} className="list-row" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                className="check"
                checked={!!a.groupIds?.includes(g.id)}
                onChange={(e) => set({ groupIds: e.target.checked ? [...(a.groupIds ?? []), g.id] : (a.groupIds ?? []).filter((x) => x !== g.id) })}
              />
              <span className="grow">{g.name}</span>
              <span className="t-footnote c3">{g.memberIds.length} {g.memberIds.length === 1 ? 'person' : 'people'}</span>
            </label>
          ))}
        </fieldset>
        <div className="list">
          <SwitchRow label="People can dismiss it" detail={critical ? 'A critical announcement can’t be dismissed.' : 'Hidden for that person on that device. It comes back if they clear their browser data.'} checked={canDismiss(a)} disabled={critical} onChange={(dismissible) => set({ dismissible })} />
          <SwitchRow label="Also post to Teams" detail="The optional Power Automate flow posts it to the firm’s Teams channel when it’s saved (DEPLOY.md). Without the flow, nothing is posted." checked={!!a.postToTeams} onChange={(v) => set({ postToTeams: v || undefined })} />
        </div>
        <div className="stack" style={{ gap: 6 }}>
          <span className="field-label">Preview</span>
          <div className={`banner ${a.severity === 'info' ? 'info' : a.severity === 'critical' ? 'critical' : ''}`}>
            <Icon name={a.severity === 'info' ? 'bell' : 'warning'} size={18} />
            <span className="grow t-callout announcement-text">{a.message.trim() ? <AnnouncementText message={a.message} /> : <span className="c3">Your message</span>}</span>
            {canDismiss(a) && <Icon name="x" size={16} className="c3" />}
          </div>
        </div>
      </div>
    </Sheet>
  );
}
