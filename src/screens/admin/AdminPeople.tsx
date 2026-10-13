import { useState } from 'react';
import type { FormCategory, FormSource, UserGroup, UserProfile, UserRole } from '../../domain/types';
import { useServices } from '../../services';
import { Toolbar } from '../../shell/Shell';
import { actableUsers, useApp } from '../../state/store';
import { Avatar, Badge, Button, Field, IconButton, SearchField, Segmented, Select, Sheet, TextArea, TextInput, toast } from '../../ui/controls';
import { Icon } from '../../ui/Icon';

const ROLES: { value: UserRole; label: string; detail: string }[] = [
  { value: 'User', label: 'User', detail: 'Advisor. Prepares and sends forms for their own clients.' },
  { value: 'Assistant', label: 'Assistant', detail: 'Fills out and sends forms on behalf of the Users in their groups.' },
  { value: 'Admin', label: 'Administrator', detail: 'Manages templates, groups, users and firm data.' },
];
const SOURCES: FormSource[] = ['Everence', 'Praxis', 'Carrier'];
const CATEGORIES: FormCategory[] = ['Account maintenance', 'Beneficiary', 'Distributions', 'Transfers', 'New accounts', 'Insurance service', 'Banking'];

/** User groups by role and region, and each person's Folium role. */
export function AdminPeople() {
  const users = useApp((s) => s.users);
  const groups = useApp((s) => s.groups);
  const reloadDirectory = useApp((s) => s.reloadDirectory);
  const services = useServices();
  const [tab, setTab] = useState<'groups' | 'users'>('groups');
  const [q, setQ] = useState('');
  const [editUser, setEditUser] = useState<UserProfile | 'new'>();
  const [editGroup, setEditGroup] = useState<UserGroup | 'new'>();

  const byId = (id: string) => users.find((u) => u.systemuserid === id);
  const filteredUsers = users.filter((u) => !q || `${u.fullname} ${u.email} ${u.branch} ${u.region}`.toLowerCase().includes(q.toLowerCase()));
  const filteredGroups = groups.filter((g) => !q || `${g.name} ${g.region} ${g.description}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <Toolbar title="Users & groups">
        <Segmented
          label="Show"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'groups', label: `Groups (${groups.length})` },
            { value: 'users', label: `Users (${users.length})` },
          ]}
        />
        <Button variant="filled" icon="plus" onClick={() => (tab === 'groups' ? setEditGroup('new') : setEditUser('new'))}>
          {tab === 'groups' ? 'New group' : 'Add user'}
        </Button>
      </Toolbar>
      <div className="scroll">
        <div className="page page-narrow stack-5">
          <div>
            <h1 className="t-large">Users & groups</h1>
            <p className="t-callout c2" style={{ marginTop: 4 }}>
              Groups gather people by office, region or team. They decide which forms people see, who can share packets, and which advisors an assistant works for.
            </p>
          </div>
          <SearchField value={q} onChange={setQ} placeholder={tab === 'groups' ? 'Search groups' : 'Search people'} label="Search" />

          {tab === 'groups' ? (
            <div className="stack-3">
              {filteredGroups.map((g) => {
                const members = g.memberIds.map(byId).filter((u): u is UserProfile => !!u);
                return (
                  <article key={g.id} className="card card-pad stack-3">
                    <div className="row" style={{ alignItems: 'flex-start' }}>
                      <span className="avatar" style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--info-tint)', color: 'var(--info)' }}>
                        <Icon name={g.region ? 'map' : 'people'} size={20} />
                      </span>
                      <div className="grow">
                        <h2 className="t-title3">{g.name}</h2>
                        <p className="t-footnote c3">
                          {g.region ? `${g.region} · ` : ''}
                          {members.length} {members.length === 1 ? 'person' : 'people'}
                          {g.sources?.length || g.categories?.length ? ` · sees ${[...(g.sources ?? []), ...(g.categories ?? [])].join(', ')} forms only` : ' · sees every form'}
                        </p>
                      </div>
                      <Button variant="gray" size="sm" onClick={() => setEditGroup(g)}>
                        Edit
                      </Button>
                    </div>
                    {g.description && <p className="t-callout c2">{g.description}</p>}
                    <div className="row wrap" style={{ gap: 6 }}>
                      {members.map((m) => (
                        <span key={m.systemuserid} className="badge" style={{ height: 28, paddingLeft: 3 }}>
                          <Avatar name={m.fullname} size={22} alt={m.role !== 'User'} />
                          {m.fullname}
                          <span className="c3">· {m.role}</span>
                        </span>
                      ))}
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="list">
              {filteredUsers.map((u) => {
                const forWhom = u.role === 'Assistant' ? actableUsers(u, users, groups) : [];
                return (
                  <button key={u.systemuserid} className="list-row" onClick={() => setEditUser(u)} style={{ padding: '12px 16px' }}>
                    <Avatar name={u.fullname} size={34} alt={u.role !== 'User'} />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="t-headline">{u.fullname}</div>
                      <div className="t-footnote c3 ellipsis">
                        {u.title} · {u.branch}
                        {u.repCode ? ` · ${u.repCode}` : ''}
                        {forWhom.length ? ` · works for ${forWhom.map((x) => x.fullname).join(', ')}` : ''}
                      </div>
                    </div>
                    <Badge tone={u.role === 'Admin' ? 'info' : u.role === 'Assistant' ? 'warn' : 'accent'}>{u.role}</Badge>
                    <Icon name="chevronRight" size={14} className="c3" />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {editUser && (
        <UserSheet
          user={editUser === 'new' ? undefined : editUser}
          groups={groups}
          onClose={() => setEditUser(undefined)}
          onSave={async (u, groupIds) => {
            await services.directory.saveUser({ ...u, groupIds });
            for (const g of groups) {
              const has = g.memberIds.includes(u.systemuserid);
              const want = groupIds.includes(g.id);
              if (has !== want) await services.directory.saveGroup({ ...g, memberIds: want ? [...g.memberIds, u.systemuserid] : g.memberIds.filter((x) => x !== u.systemuserid) });
            }
            await reloadDirectory();
            setEditUser(undefined);
            toast.ok(`Saved ${u.fullname}`);
          }}
        />
      )}
      {editGroup && (
        <GroupSheet
          group={editGroup === 'new' ? undefined : editGroup}
          users={users}
          onClose={() => setEditGroup(undefined)}
          onDelete={
            editGroup !== 'new'
              ? async () => {
                  await services.directory.removeGroup(editGroup.id);
                  await reloadDirectory();
                  setEditGroup(undefined);
                  toast.ok('Group deleted');
                }
              : undefined
          }
          onSave={async (g) => {
            await services.directory.saveGroup(g);
            await reloadDirectory();
            setEditGroup(undefined);
            toast.ok(`Saved ${g.name}`);
          }}
        />
      )}
    </>
  );
}

function UserSheet({ user, groups, onClose, onSave }: { user?: UserProfile; groups: UserGroup[]; onClose: () => void; onSave: (u: UserProfile, groupIds: string[]) => Promise<void> }) {
  const [u, setU] = useState<UserProfile>(
    user ?? { systemuserid: `usr-${Date.now()}`, fullname: '', email: '', phone: '', repCode: '', branch: '', title: '', role: 'User', groupIds: [] },
  );
  const [groupIds, setGroupIds] = useState<string[]>(groups.filter((g) => g.memberIds.includes(u.systemuserid)).map((g) => g.id));
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<UserProfile>) => setU({ ...u, ...p });
  return (
    <Sheet
      title={user ? user.fullname : 'Add user'}
      onClose={onClose}
      footer={
        <>
          <Button variant="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="filled" busy={busy} disabled={!u.fullname || !u.email} onClick={async () => (setBusy(true), await onSave(u, groupIds))}>
            Save
          </Button>
        </>
      }
    >
      <div className="stack-4">
        {!user && <p className="t-footnote c3">People sign in with their Microsoft account. Add them here to give them a Folium role and groups.</p>}
        <div className="grid-2">
          <Field label="Name" htmlFor="eu-name">
            <TextInput id="eu-name" value={u.fullname} disabled={!!user} onChange={(e) => set({ fullname: e.target.value })} />
          </Field>
          <Field label="Email" htmlFor="eu-email">
            <TextInput id="eu-email" type="email" value={u.email} onChange={(e) => set({ email: e.target.value })} />
          </Field>
          <Field label="Title" htmlFor="eu-title">
            <TextInput id="eu-title" value={u.title} onChange={(e) => set({ title: e.target.value })} />
          </Field>
          <Field label="Branch" htmlFor="eu-branch">
            <TextInput id="eu-branch" value={u.branch} onChange={(e) => set({ branch: e.target.value })} />
          </Field>
          <Field label="Region" htmlFor="eu-region">
            <TextInput id="eu-region" value={u.region ?? ''} onChange={(e) => set({ region: e.target.value })} />
          </Field>
          <Field label="Rep code" htmlFor="eu-rep" optional>
            <TextInput id="eu-rep" className="mono" value={u.repCode} onChange={(e) => set({ repCode: e.target.value })} />
          </Field>
        </div>
        <fieldset className="list" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label" style={{ padding: '0 0 6px 2px' }}>Role</legend>
          {ROLES.map((r) => (
            <label key={r.value} className="list-row" style={{ cursor: 'pointer' }}>
              <input type="radio" name="role" className="check" checked={u.role === r.value} onChange={() => set({ role: r.value })} />
              <span className="grow">
                <span style={{ display: 'block', fontWeight: 600 }}>{r.label}</span>
                <span className="t-footnote c3">{r.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset className="list" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label" style={{ padding: '0 0 6px 2px' }}>Groups</legend>
          {groups.map((g) => (
            <label key={g.id} className="list-row" style={{ cursor: 'pointer' }}>
              <input type="checkbox" className="check" checked={groupIds.includes(g.id)} onChange={(e) => setGroupIds(e.target.checked ? [...groupIds, g.id] : groupIds.filter((x) => x !== g.id))} />
              <span className="grow">{g.name}</span>
              {g.region && <span className="t-footnote c3">{g.region}</span>}
            </label>
          ))}
        </fieldset>
      </div>
    </Sheet>
  );
}

function GroupSheet({ group, users, onClose, onSave, onDelete }: { group?: UserGroup; users: UserProfile[]; onClose: () => void; onSave: (g: UserGroup) => Promise<void>; onDelete?: () => Promise<void> }) {
  const [g, setG] = useState<UserGroup>(group ?? { id: `new-${Date.now()}`, name: '', memberIds: [] });
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<UserGroup>) => setG({ ...g, ...p });
  const toggle = <T,>(list: T[] | undefined, v: T, on: boolean) => (on ? [...(list ?? []), v] : (list ?? []).filter((x) => x !== v));

  return (
    <Sheet
      wide
      title={group ? `Edit ${group.name}` : 'New group'}
      onClose={onClose}
      footer={
        <>
          {onDelete && (
            <Button variant="danger" icon="trash" onClick={onDelete}>
              Delete group
            </Button>
          )}
          <span className="spacer" />
          <Button variant="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="filled" busy={busy} disabled={!g.name.trim()} onClick={async () => (setBusy(true), await onSave(g))}>
            Save
          </Button>
        </>
      }
    >
      <div className="stack-4">
        <div className="grid-2">
          <Field label="Name" htmlFor="g-name">
            <TextInput id="g-name" value={g.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Lancaster advisors" />
          </Field>
          <Field label="Region or location" htmlFor="g-region" optional>
            <TextInput id="g-region" value={g.region ?? ''} onChange={(e) => set({ region: e.target.value || undefined })} />
          </Field>
          <div className="span-2">
            <Field label="Description" htmlFor="g-desc" optional>
              <TextArea id="g-desc" rows={2} value={g.description ?? ''} onChange={(e) => set({ description: e.target.value || undefined })} />
            </Field>
          </div>
        </div>
        <div className="grid-2" style={{ alignItems: 'start' }}>
          <fieldset className="list" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label" style={{ padding: '0 0 6px 2px' }}>Members</legend>
            {users.map((u) => (
              <label key={u.systemuserid} className="list-row" style={{ cursor: 'pointer' }}>
                <input type="checkbox" className="check" checked={g.memberIds.includes(u.systemuserid)} onChange={(e) => set({ memberIds: toggle(g.memberIds, u.systemuserid, e.target.checked) })} />
                <Avatar name={u.fullname} size={24} alt={u.role !== 'User'} />
                <span className="grow">{u.fullname}</span>
                <span className="t-footnote c3">{u.role}</span>
              </label>
            ))}
          </fieldset>
          <div className="stack-3">
            <fieldset className="list" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="field-label" style={{ padding: '0 0 6px 2px' }}>Forms this group sees</legend>
              {SOURCES.map((s) => (
                <label key={s} className="list-row" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" className="check" checked={!g.sources?.length || g.sources.includes(s)} onChange={(e) => set({ sources: toggle(g.sources?.length ? g.sources : SOURCES, s, e.target.checked) })} />
                  <span className="grow">{s === 'Carrier' ? 'Insurance carriers' : s === 'Praxis' ? 'Praxis funds' : s}</span>
                </label>
              ))}
            </fieldset>
            <Field label="Limit to categories" htmlFor="g-cats" help="Leave empty for every category.">
              <Select id="g-cats" value="" onChange={(e) => e.target.value && set({ categories: toggle(g.categories, e.target.value as FormCategory, true) })}>
                <option value="">Add a category…</option>
                {CATEGORIES.filter((c) => !g.categories?.includes(c)).map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            </Field>
            <div className="row wrap" style={{ gap: 6 }}>
              {g.categories?.map((c) => (
                <span key={c} className="badge">
                  {c}
                  <IconButton icon="x" size={12} label={`Remove ${c}`} style={{ width: 18, height: 18 }} onClick={() => set({ categories: toggle(g.categories, c, false) })} />
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Sheet>
  );
}
