import { useEffect, useState } from 'react';
import { DEFAULT_ATTACHMENT_LIMITS } from '../../domain/checks';
import { RETENTION_OPTIONS, retentionDays } from '../../domain/requests';
import type { FirmPolicy, PdfDownloadPolicy, RepDataVisibility, SharingPolicy } from '../../domain/types';
import { useServices } from '../../services';
import { Toolbar } from '../../shell/Shell';
import { useApp } from '../../state/store';
import { Button, Field, Select, SwitchRow, TextInput, toast } from '../../ui/controls';

const SHARING: Record<SharingPolicy, { label: string; effect: string }> = {
  off: { label: 'Off', effect: 'Nobody can share a draft. Drafts already shared stay with those people until they’re sent, deleted or expire.' },
  groups: { label: 'Within groups', effect: 'Advisors and assistants can share a draft with people in a group they’re in.' },
  anyone: { label: 'Anyone with Folium', effect: 'A draft can be shared with anyone who uses Folium, in any group.' },
};

const REP_DATA: Record<RepDataVisibility, { label: string; effect: string }> = {
  assistants: { label: 'Assistants only', effect: 'Assistants work as the advisors in their groups. Advisors always fill forms with their own rep code and details.' },
  groupMembers: { label: 'Advisors and assistants within groups', effect: 'Advisors can also work as another advisor in their groups: forms fill with that advisor’s rep data, and the work is in their book.' },
};

const DOWNLOAD: Record<PdfDownloadPolicy, { label: string; effect: string }> = {
  all: { label: 'Allowed', effect: 'Advisors can download fillable and flattened PDFs, print, sign in person, and download signed envelopes.' },
  signedOnly: { label: 'Signed envelopes only', effect: 'Forms leave Folium only through DocuSign. The completed, signed envelope can still be downloaded for OnBase.' },
  none: { label: 'Off', effect: 'No PDF downloads or printing at all: DocuSign is the only way out, and signed envelopes are filed from DocuSign.' },
};

/** A typed limit as a whole number from 1 to `max`; empty or below 1 goes back to the default. */
const clampLimit = (raw: string, max: number) => {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : undefined;
};

/** Firm-wide rules, saved in their own settings row ("Policy"), shared by every firm profile. */
export function AdminSettings() {
  const policy = useApp((s) => s.policy);
  const reloadDirectory = useApp((s) => s.reloadDirectory);
  const services = useServices();
  const [p, setP] = useState<FirmPolicy>(policy);
  const [busy, setBusy] = useState(false);
  useEffect(() => setP(policy), [policy]);
  const dirty = JSON.stringify(p) !== JSON.stringify(policy);
  const set = (patch: Partial<FirmPolicy>) => setP({ ...p, ...patch });
  const keep = retentionDays(p);

  async function save() {
    setBusy(true);
    try {
      await services.directory.savePolicy(p);
      await reloadDirectory();
      toast.ok('Settings saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the settings');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Toolbar title="Settings">
        <Button variant="filled" disabled={!dirty} busy={busy} onClick={save}>
          Save
        </Button>
      </Toolbar>
      <div className="scroll">
        <div className="page page-narrow stack-5">
          <div>
            <h1 className="t-large">Firm settings</h1>
            <p className="t-callout c2" style={{ marginTop: 4 }}>
              Rules for everyone at the firm. They apply the next time each person opens Folium. Changes are recorded by Dataverse auditing.
            </p>
          </div>

          <section className="card card-pad stack-4" aria-labelledby="pol-h">
            <h2 id="pol-h" className="t-title3">Sharing and access</h2>
            <Field label="Sharing drafts between people" htmlFor="p-share" help={SHARING[p.sharing].effect}>
              <Select id="p-share" value={p.sharing} onChange={(e) => set({ sharing: e.target.value as SharingPolicy })}>
                {(Object.keys(SHARING) as SharingPolicy[]).map((k) => (
                  <option key={k} value={k}>
                    {SHARING[k].label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Working as another advisor (rep data)" htmlFor="p-rep" help={REP_DATA[p.repDataVisibility].effect}>
              <Select id="p-rep" value={p.repDataVisibility} onChange={(e) => set({ repDataVisibility: e.target.value as RepDataVisibility })}>
                {(Object.keys(REP_DATA) as RepDataVisibility[]).map((k) => (
                  <option key={k} value={k}>
                    {REP_DATA[k].label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="PDF downloads" htmlFor="p-dl" help={DOWNLOAD[p.pdfDownload].effect}>
              <Select id="p-dl" value={p.pdfDownload} onChange={(e) => set({ pdfDownload: e.target.value as PdfDownloadPolicy })}>
                {(Object.keys(DOWNLOAD) as PdfDownloadPolicy[]).map((k) => (
                  <option key={k} value={k}>
                    {DOWNLOAD[k].label}
                  </option>
                ))}
              </Select>
            </Field>
          </section>

          <section className="card card-pad stack-3" aria-labelledby="ret-h">
            <h2 id="ret-h" className="t-title3">Draft retention</h2>
            <p className="t-footnote c3">
              Drafts hold client SSNs and account numbers. Folium deletes an unsent draft, and its PDFs in SharePoint, this long after it was last saved. Opening and saving a draft starts the clock again. Packets printed to sign in person and sent requests aren’t affected.
            </p>
            <Field label="Keep unsent drafts for" htmlFor="p-ret" help={keep === 0 ? 'Save draft and Share are hidden. Send and “sign in person” still work.' : 'Shortening it applies from each draft’s next save.'}>
              <Select id="p-ret" value={String(keep)} onChange={(e) => set({ draftRetentionDays: Number(e.target.value) })}>
                {RETENTION_OPTIONS.map((d) => (
                  <option key={d} value={d}>
                    {d === 0 ? 'Don’t keep drafts' : `${d} days${d === 90 ? ' (default)' : ''}`}
                  </option>
                ))}
              </Select>
            </Field>
          </section>

          <section className="card card-pad stack-4" aria-labelledby="env-h">
            <h2 id="env-h" className="t-title3">Envelopes</h2>
            <div className="grid-2">
              <Field label="Most supporting documents" htmlFor="p-maxn">
                <TextInput id="p-maxn" type="number" min={1} max={50} value={p.maxAttachments ?? ''} placeholder={String(DEFAULT_ATTACHMENT_LIMITS.maxFiles)} onChange={(e) => set({ maxAttachments: clampLimit(e.target.value, 50) })} />
              </Field>
              <Field label="Most MB of supporting documents" htmlFor="p-maxmb" help="Check DocuSign’s and the connector’s request limits before raising it.">
                <TextInput id="p-maxmb" type="number" min={1} max={100} value={p.maxAttachmentsMB ?? ''} placeholder={String(DEFAULT_ATTACHMENT_LIMITS.maxMB)} onChange={(e) => set({ maxAttachmentsMB: clampLimit(e.target.value, 100) })} />
              </Field>
            </div>
          </section>
          <div className="list">
            <SwitchRow
              label="Lock the email note"
              detail="Users and Assistants send the note from the firm profile as written. Admins can still edit it, and the disclosure is still added."
              checked={!!p.lockMessage}
              onChange={(v) => set({ lockMessage: v || undefined })}
            />
          </div>

          <p className="t-footnote c3">Folium never collects device location: nothing in the forms workflow needs it.</p>
        </div>
      </div>
    </>
  );
}
