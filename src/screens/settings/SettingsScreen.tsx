import { useEffect, useState } from 'react';
import { FoliumAppIcon } from '../../brand/FoliumMark';
import type { UserProfile, VerificationMethod } from '../../domain/types';
import { useServices } from '../../services';
import { resetDemo, setDemoUser } from '../../services/demo';
import { Toolbar } from '../../shell/Shell';
import { useApp, type Theme } from '../../state/store';
import { Avatar, Badge, Button, Field, Segmented, Select, TextArea, TextInput, toast } from '../../ui/controls';

/** Your own Folium profile (User Data), preferences and appearance. */
export function SettingsScreen() {
  const me = useApp((s) => s.me);
  const users = useApp((s) => s.users);
  const groups = useApp((s) => s.groups);
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const reloadDirectory = useApp((s) => s.reloadDirectory);
  const services = useServices();
  const [p, setP] = useState<UserProfile | undefined>(me);
  const [busy, setBusy] = useState(false);

  useEffect(() => setP(me), [me]);
  if (!me || !p) return null;

  const dirty = JSON.stringify(p) !== JSON.stringify(me);
  const set = (patch: Partial<UserProfile>) => setP({ ...p, ...patch });

  async function save() {
    setBusy(true);
    try {
      await services.directory.saveUser(p!);
      await reloadDirectory();
      toast.ok('Profile saved. New forms use it right away.');
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
          <div className="row-3">
            <Avatar name={me.fullname} size={64} />
            <div className="grow">
              <h1 className="t-large">{me.fullname}</h1>
              <p className="t-callout c2">
                {me.title} · {me.role}
                {me.region ? ` · ${me.region}` : ''}
              </p>
            </div>
          </div>

          <section className="card card-pad stack-4" aria-labelledby="prof-h">
            <div>
              <h2 id="prof-h" className="t-title3">Your advisor details</h2>
              <p className="t-footnote c3">Forms fill rep fields (name, rep code, phone) from here. Your name comes from your Microsoft account.</p>
            </div>
            <div className="grid-2">
              <Field label="Name" htmlFor="u-name" help="Managed in Microsoft Entra ID">
                <TextInput id="u-name" value={p.fullname} disabled />
              </Field>
              <Field label="Title" htmlFor="u-title">
                <TextInput id="u-title" value={p.title} onChange={(e) => set({ title: e.target.value })} />
              </Field>
              <Field label="Email" htmlFor="u-email">
                <TextInput id="u-email" type="email" value={p.email} onChange={(e) => set({ email: e.target.value })} />
              </Field>
              <Field label="Phone" htmlFor="u-phone">
                <TextInput id="u-phone" type="tel" value={p.phone} onChange={(e) => set({ phone: e.target.value })} />
              </Field>
              <Field label="Rep code" htmlFor="u-rep">
                <TextInput id="u-rep" className="mono" value={p.repCode} onChange={(e) => set({ repCode: e.target.value })} />
              </Field>
              <Field label="Branch" htmlFor="u-branch">
                <TextInput id="u-branch" value={p.branch} onChange={(e) => set({ branch: e.target.value })} />
              </Field>
            </div>
          </section>

          <section className="card card-pad stack-4" aria-labelledby="def-h">
            <h2 id="def-h" className="t-title3">Sending defaults</h2>
            <div className="grid-2">
              <Field label="Verify the owner with" htmlFor="u-auth">
                <Select id="u-auth" value={p.defaultAuth ?? 'sms'} onChange={(e) => set({ defaultAuth: e.target.value as VerificationMethod })}>
                  <option value="sms">SMS code</option>
                  <option value="email">Email only</option>
                  <option value="kba">ID questions (KBA)</option>
                </Select>
              </Field>
              <Field label="Remind unsigned envelopes after" htmlFor="u-rem">
                <Select id="u-rem" value={String(p.defaultReminderDays ?? 3)} onChange={(e) => set({ defaultReminderDays: Number(e.target.value) })}>
                  {[2, 3, 5, 7].map((d) => (
                    <option key={d} value={d}>
                      {d} days
                    </option>
                  ))}
                  <option value={0}>Never</option>
                </Select>
              </Field>
              <div className="span-2">
                <Field label="Email sign-off" htmlFor="u-sig" help="Added to the note clients see in DocuSign.">
                  <TextArea id="u-sig" rows={3} value={p.emailSignature ?? `${p.fullname}\n${p.title}, ${p.branch}\n${p.phone}`} onChange={(e) => set({ emailSignature: e.target.value })} />
                </Field>
              </div>
            </div>
          </section>

          <section className="card card-pad stack-4">
            <h2 className="t-title3">Appearance</h2>
            <Segmented<Theme>
              label="Appearance"
              value={theme}
              onChange={setTheme}
              options={[
                { value: 'system', label: 'Automatic' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
            />
          </section>

          <section className="stack">
            <h2 className="section-title">Your groups</h2>
            <div className="list">
              {groups
                .filter((g) => g.memberIds.includes(me.systemuserid))
                .map((g) => (
                  <div key={g.id} className="list-row">
                    <span className="grow">
                      <span style={{ display: 'block', fontWeight: 600 }}>{g.name}</span>
                      <span className="t-footnote c3">{g.description}</span>
                    </span>
                    {g.region && <Badge>{g.region}</Badge>}
                  </div>
                ))}
            </div>
            <p className="t-footnote c3">Groups decide which forms you see, who can share with you, and which advisors an assistant can work for. An administrator manages them.</p>
          </section>

          <section className="stack">
            <h2 className="section-title">Keyboard</h2>
            <div className="list">
              {[
                ['⌘ K', 'Search forms, packets and places'],
                ['/', 'Focus form search'],
                ['Esc', 'Close a sheet or clear search'],
              ].map(([k, d]) => (
                <div key={k} className="list-row">
                  <span className="grow">{d}</span>
                  <span className="kbd">{k}</span>
                </div>
              ))}
            </div>
          </section>

          {services.mode === 'demo' && (
            <section className="card card-pad stack-4" aria-labelledby="demo-h">
              <div className="row-3">
                <FoliumAppIcon size={40} />
                <div className="grow">
                  <h2 id="demo-h" className="t-title3">Demo mode</h2>
                  <p className="t-footnote c3">Sample clients, forms and a simulated DocuSign. Nothing leaves this browser.</p>
                </div>
              </div>
              <Field label="Try Folium as" htmlFor="demo-user">
                <Select
                  id="demo-user"
                  value={me.systemuserid}
                  onChange={(e) => {
                    setDemoUser(e.target.value);
                    location.reload();
                  }}
                >
                  {users.map((u) => (
                    <option key={u.systemuserid} value={u.systemuserid}>
                      {u.fullname} — {u.role}
                    </option>
                  ))}
                </Select>
              </Field>
              <div>
                <Button
                  variant="danger"
                  onClick={() => {
                    resetDemo();
                    try {
                      Object.keys(localStorage).filter((k) => k.startsWith('folium.')).forEach((k) => localStorage.removeItem(k));
                    } catch {
                      /* ignore */
                    }
                    location.reload();
                  }}
                >
                  Reset demo data
                </Button>
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
