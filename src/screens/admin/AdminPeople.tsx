import { useEffect, useMemo, useRef, useState } from 'react';
import { profileFromDirectory, withRepAudit, type DirectoryUser } from '../../domain/advisor';
import type { FirmPolicy, FormCategory, FormSource, UserGroup, UserProfile, UserRole } from '../../domain/types';
import {
  bulkSummary,
  dormantDays,
  isActiveUser,
  lastAdminProblem,
  parseUserImport,
  planBulk,
  planImport,
  STATUS_LABEL,
  userStatus,
  usersCsv,
  waitingForRole,
  type BulkAction,
  type ImportOutcome,
  type UserStatus,
  type WaitingForRole,
} from '../../domain/users';
import { useServices } from '../../services';
import { Toolbar } from '../../shell/Shell';
import { saveUserChanges, type ChangeReport } from '../../state/people';
import { actableUsers, useApp } from '../../state/store';
import { Avatar, Badge, Button, downloadBytes, Field, IconButton, SearchField, Segmented, Select, Sheet, SwitchRow, TextArea, TextInput, toast } from '../../ui/controls';
import { Icon } from '../../ui/Icon';
import { RepAudit, RepDetails } from '../common/RepDetails';

const ROLES: { value: UserRole; label: string; detail: string }[] = [
  { value: 'User', label: 'User', detail: 'Advisor. Prepares and sends forms for their own clients.' },
  { value: 'Assistant', label: 'Assistant', detail: 'Fills out and sends forms on behalf of the Users in their groups.' },
  { value: 'Admin', label: 'Administrator', detail: 'Manages templates, groups, users and firm data.' },
];
/** Run a sheet's save with a spinner that always clears, and say so if it fails. */
async function runSave(setBusy: (b: boolean) => void, fn: () => Promise<void>) {
  setBusy(true);
  try {
    await fn();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'Could not save');
  } finally {
    setBusy(false);
  }
}

const SOURCES: FormSource[] = ['Everence', 'Praxis', 'Carrier'];
const CATEGORIES: FormCategory[] = ['Account maintenance', 'Beneficiary', 'Distributions', 'Transfers', 'New accounts', 'Insurance service', 'Banking'];

const STATUS_TONE: Record<UserStatus, 'accent' | 'warn' | 'info' | 'danger' | undefined> = {
  active: 'accent',
  dormant: 'warn',
  unused: undefined,
  inactive: undefined,
  disabled: 'danger',
  noProfile: 'info',
};

/** Say how a batch of saves went: all saved, or who failed and why. */
function announce(report: ChangeReport, what: string) {
  if (!report.failed.length) toast.ok(`${what}: ${report.saved.length} saved`);
  else toast.error(`${what}: ${report.saved.length} saved, ${report.failed.length} failed — ${report.failed.map((f) => `${f.name} (${f.error})`).join('; ')}`);
}

const lastSeen = (u: Pick<UserProfile, 'lastSeenOn'>) => (u.lastSeenOn ? new Date(u.lastSeenOn).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'never');

/** User groups by role and region, and each person's Folium role, status and rep details. */
export function AdminPeople() {
  const users = useApp((s) => s.users);
  const groups = useApp((s) => s.groups);
  const policy = useApp((s) => s.policy);
  const me = useApp((s) => s.me);
  const reloadDirectory = useApp((s) => s.reloadDirectory);
  const services = useServices();
  const [tab, setTab] = useState<'groups' | 'users'>('groups');
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<UserStatus | ''>('');
  const [roleFilter, setRoleFilter] = useState<UserRole | ''>('');
  const [groupFilter, setGroupFilter] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [bulk, setBulk] = useState<BulkAction>();
  const [importing, setImporting] = useState(false);
  const [editUser, setEditUser] = useState<UserProfile | 'new'>();
  /** The directory person a new profile starts from, when "Give a role" opened the sheet. */
  const [newFrom, setNewFrom] = useState<DirectoryUser>();
  const [editGroup, setEditGroup] = useState<UserGroup | 'new'>();
  const waiting = useWaitingForRole(users);

  const now = useMemo(() => new Date(), []);
  const statusOf = (u: UserProfile) => userStatus(u, u.directory, now, dormantDays(policy));
  const byId = (id: string) => users.find((u) => u.systemuserid === id);
  const filteredUsers = users.filter(
    (u) =>
      (!q || `${u.fullname} ${u.email} ${u.branch} ${u.region} ${u.repCode}`.toLowerCase().includes(q.toLowerCase())) &&
      (!statusFilter || statusOf(u) === statusFilter) &&
      (!roleFilter || u.role === roleFilter) &&
      (!groupFilter || u.groupIds.includes(groupFilter) || groups.find((g) => g.id === groupFilter)?.memberIds.includes(u.systemuserid)),
  );
  const filteredGroups = groups.filter((g) => !q || `${g.name} ${g.region} ${g.description}`.toLowerCase().includes(q.toLowerCase()));
  const shownSelected = selected.filter((id) => filteredUsers.some((u) => u.systemuserid === id));
  const counts = users.reduce<Partial<Record<UserStatus, number>>>((acc, u) => ({ ...acc, [statusOf(u)]: (acc[statusOf(u)] ?? 0) + 1 }), {});

  async function saveOne(before: UserProfile | undefined, u: UserProfile) {
    const problem = lastAdminProblem(users, [u]);
    if (problem) throw new Error(problem);
    const audited = withRepAudit(before, u, me?.fullname ?? 'Administrator');
    const report = await saveUserChanges(services.directory, users, groups, [audited]);
    if (report.failed.length) throw new Error(report.failed[0].error);
    await reloadDirectory();
  }

  function exportList() {
    const csv = usersCsv(filteredUsers, groups, statusOf);
    downloadBytes(new TextEncoder().encode(csv), `folium-users-${now.toISOString().slice(0, 10)}.csv`, 'text/csv;charset=utf-8');
  }

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
        {tab === 'users' && (
          <>
            <Button variant="gray" icon="upload" onClick={() => setImporting(true)}>
              Import
            </Button>
            <Button variant="gray" icon="download" onClick={exportList} disabled={!filteredUsers.length}>
              Download as Excel
            </Button>
          </>
        )}
        <Button
          variant="filled"
          icon="plus"
          onClick={() => {
            if (tab === 'groups') return setEditGroup('new');
            setNewFrom(undefined);
            setEditUser('new');
          }}
        >
          {tab === 'groups' ? 'New group' : 'Add user'}
        </Button>
      </Toolbar>
      <div className="scroll">
        <div className="page page-narrow stack-5">
          <div>
            <h1 className="t-large">Users & groups</h1>
            <p className="t-callout c2">
              {tab === 'groups'
                ? 'Groups gather people by office, region or team. They decide which forms people see, who can share packets, and which advisors an assistant works for.'
                : 'Access to Folium comes from the Microsoft Entra ID group the app is shared with: when someone leaves Everence, their access ends with their account. Deactivate a profile to take someone out of Folium without touching their requests.'}
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
            <div className="stack-3">
              {waiting.length > 0 && (
                <section className="stack-2" aria-labelledby="waiting-heading">
                  <h2 id="waiting-heading" className="t-headline">
                    Opened Folium without a role ({waiting.length})
                  </h2>
                  <p className="t-footnote c3">They can open Folium through the Entra ID group but have no Folium profile, so they work as a User with no groups. Give them a role and groups.</p>
                  <div className="list">
                    {waiting.map((w) => (
                      <div key={w.systemuserid} className="list-row" style={{ padding: '8px 16px' }}>
                        <Avatar name={w.person.fullname} size={34} />
                        <div className="grow" style={{ minWidth: 0 }}>
                          <div className="t-headline">{w.person.fullname}</div>
                          <div className="t-footnote c3 ellipsis">
                            {[w.person.email, w.person.title].filter(Boolean).join(' · ')} · last opened {lastSeen({ lastSeenOn: w.lastOpenedOn })}
                            {w.days > 1 ? `, on ${w.days} days` : ''}
                          </div>
                        </div>
                        <Button
                          variant="gray"
                          size="sm"
                          onClick={() => {
                            setNewFrom(w.person);
                            setEditUser('new');
                          }}
                        >
                          Give a role
                        </Button>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              <div className="row wrap" style={{ gap: 8 }}>
                <Select aria-label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as UserStatus | '')} style={{ width: 'auto' }}>
                  <option value="">Every status</option>
                  {(Object.keys(STATUS_LABEL) as UserStatus[])
                    .filter((k) => k !== 'noProfile')
                    .map((k) => (
                      <option key={k} value={k}>
                        {STATUS_LABEL[k]} ({counts[k] ?? 0})
                      </option>
                    ))}
                </Select>
                <Select aria-label="Role" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as UserRole | '')} style={{ width: 'auto' }}>
                  <option value="">Every role</option>
                  {ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}s
                    </option>
                  ))}
                </Select>
                <Select aria-label="Group" value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} style={{ width: 'auto' }}>
                  <option value="">Every group</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </Select>
                <span className="spacer" />
                <span className="t-footnote c3">
                  {filteredUsers.length} of {users.length}
                  {counts.dormant ? ` · ${counts.dormant} dormant` : ''}
                  {counts.disabled ? ` · ${counts.disabled} left Everence` : ''}
                </span>
              </div>

              {shownSelected.length > 0 && (
                <div className="card card-pad row wrap" role="region" aria-label="Selected people" style={{ gap: 8 }}>
                  <strong className="grow">{shownSelected.length} selected</strong>
                  <Select
                    aria-label="Change selected people"
                    value=""
                    style={{ width: 'auto' }}
                    onChange={(e) => {
                      const [kind, arg] = e.target.value.split(':');
                      if (!kind) return;
                      setBulk(kind === 'role' ? { kind, role: arg as UserRole } : kind === 'addGroup' || kind === 'removeGroup' ? { kind, groupId: arg } : ({ kind } as BulkAction));
                    }}
                  >
                    <option value="">Change…</option>
                    <optgroup label="Role">
                      {ROLES.map((r) => (
                        <option key={r.value} value={`role:${r.value}`}>
                          Make {r.label}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Add to group">
                      {groups.map((g) => (
                        <option key={g.id} value={`addGroup:${g.id}`}>
                          Add to {g.name}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Remove from group">
                      {groups.map((g) => (
                        <option key={g.id} value={`removeGroup:${g.id}`}>
                          Remove from {g.name}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Access">
                      <option value="deactivate">Deactivate</option>
                      <option value="reactivate">Reactivate</option>
                    </optgroup>
                  </Select>
                  <Button variant="gray" size="sm" onClick={() => setSelected([])}>
                    Clear
                  </Button>
                </div>
              )}

              <div className="list">
                <label className="list-row" style={{ cursor: 'pointer', padding: '8px 16px' }}>
                  <input
                    type="checkbox"
                    className="check"
                    aria-label="Select everyone shown"
                    checked={!!filteredUsers.length && shownSelected.length === filteredUsers.length}
                    onChange={(e) => setSelected(e.target.checked ? filteredUsers.map((u) => u.systemuserid) : [])}
                  />
                  <span className="t-footnote c3 grow">Select everyone shown</span>
                  <span className="t-footnote c3">Last sign-in</span>
                </label>
                {filteredUsers.map((u) => {
                  const forWhom = u.role === 'Assistant' ? actableUsers(u, users, groups, policy) : [];
                  const status = statusOf(u);
                  return (
                    <div key={u.systemuserid} className="list-row" style={{ padding: '8px 16px', opacity: isActiveUser(u) ? 1 : 0.7 }}>
                      <input
                        type="checkbox"
                        className="check"
                        aria-label={`Select ${u.fullname}`}
                        checked={selected.includes(u.systemuserid)}
                        onChange={(e) => setSelected(e.target.checked ? [...selected, u.systemuserid] : selected.filter((x) => x !== u.systemuserid))}
                      />
                      <button className="row grow" onClick={() => setEditUser(u)} style={{ all: 'unset', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', flex: 1, minWidth: 0 }}>
                        <Avatar name={u.fullname} size={34} alt={u.role !== 'User'} />
                        <div className="grow" style={{ minWidth: 0 }}>
                          <div className="t-headline">{u.fullname}</div>
                          <div className="t-footnote c3 ellipsis">
                            {u.title} · {u.branch}
                            {u.repCode ? ` · ${u.repCode}` : ''}
                            {forWhom.length ? ` · works for ${forWhom.map((x) => x.fullname).join(', ')}` : ''}
                          </div>
                        </div>
                        {status !== 'active' && <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>}
                        <Badge tone={u.role === 'Admin' ? 'info' : u.role === 'Assistant' ? 'warn' : 'accent'}>{u.role}</Badge>
                        <span className="t-footnote c3" style={{ width: 92, textAlign: 'right' }}>
                          {lastSeen(u)}
                        </span>
                        <Icon name="chevronRight" size={14} className="c3" />
                      </button>
                    </div>
                  );
                })}
              </div>
              <p className="t-footnote c3">
                “Dormant” means no sign-in for {dormantDays(policy)} days (Administration › Settings). “Left Everence” means the Microsoft account is turned off.
              </p>
            </div>
          )}
        </div>
      </div>

      {editUser && me && (
        <UserSheet
          user={editUser === 'new' ? undefined : editUser}
          initial={editUser === 'new' ? newFrom : undefined}
          me={me}
          users={users}
          groups={groups}
          policy={policy}
          status={editUser === 'new' ? undefined : statusOf(editUser)}
          onClose={() => setEditUser(undefined)}
          onSave={async (u) => {
            await saveOne(editUser === 'new' ? undefined : editUser, u);
            setEditUser(undefined);
            toast.ok(`Saved ${u.fullname}`);
          }}
          onSetActive={
            editUser === 'new'
              ? undefined
              : async (active) => {
                  await saveOne(editUser, { ...editUser, active });
                  setEditUser(undefined);
                  toast.ok(active ? `${editUser.fullname} reactivated` : `${editUser.fullname} deactivated. Their requests are kept.`);
                }
          }
        />
      )}
      {bulk && (
        <BulkSheet
          action={bulk}
          users={users}
          groups={groups}
          ids={shownSelected}
          onClose={() => setBulk(undefined)}
          onConfirm={async (changed) => {
            const report = await saveUserChanges(services.directory, users, groups, changed);
            await reloadDirectory();
            announce(report, bulkSummary(bulk, changed.length, groups));
            setBulk(undefined);
            setSelected(report.failed.length ? selected : []);
          }}
        />
      )}
      {importing && (
        <ImportSheet
          users={users}
          groups={groups}
          onClose={() => setImporting(false)}
          onConfirm={async (changed) => {
            const report = await saveUserChanges(services.directory, users, groups, changed);
            await reloadDirectory();
            announce(report, 'Import');
            if (!report.failed.length) setImporting(false);
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

/** Look back this far for people who opened Folium without a profile. */
const WAITING_DAYS = 90;

/**
 * People who opened Folium without a profile (`user.noprofile` usage events) and still
 * have none, with their directory details. Empty when the read fails: it's a nicety.
 */
function useWaitingForRole(users: UserProfile[]): (WaitingForRole & { person: DirectoryUser })[] {
  const services = useServices();
  const [out, setOut] = useState<(WaitingForRole & { person: DirectoryUser })[]>([]);
  const ids = users.map((u) => u.systemuserid).join(',');
  useEffect(() => {
    let live = true;
    (async () => {
      const since = new Date(Date.now() - WAITING_DAYS * 86_400_000).toISOString();
      const { events } = await services.usage.list(since, ['user.noprofile']);
      const waiting = waitingForRole(events, users);
      const people = waiting.length ? await services.directory.directoryByIds(waiting.map((w) => w.systemuserid)) : [];
      const byId = new Map(people.map((p) => [p.systemuserid.toLowerCase(), p]));
      const found = waiting.flatMap((w) => {
        const person = byId.get(w.systemuserid.toLowerCase());
        return person && !person.disabled ? [{ ...w, person }] : [];
      });
      if (live) setOut(found);
    })().catch(() => live && setOut([]));
    return () => {
      live = false;
    };
    // Reload when the list of profiles changes (someone was just given one).
  }, [services, ids]);
  return out;
}

/** Search the directory (`systemuser`, synced from Entra ID) for the person to add. */
function DirectoryPicker({ users, onPick }: { users: UserProfile[]; onPick: (d: DirectoryUser) => void }) {
  const services = useServices();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<DirectoryUser[]>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setResults(undefined);
      setProblem(undefined);
      return;
    }
    let live = true;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const found = await services.directory.searchDirectory(query);
        if (live) (setResults(found), setProblem(undefined));
      } catch (e) {
        if (live) setProblem(e instanceof Error ? e.message : 'Could not search the directory');
      } finally {
        if (live) setBusy(false);
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, services]);
  const profileOf = (d: DirectoryUser) => users.find((u) => u.systemuserid.toLowerCase() === d.systemuserid.toLowerCase());
  return (
    <div className="stack-3">
      <SearchField value={q} onChange={setQ} placeholder="Name or email" label="Find a person in the directory" autoFocus />
      {problem && (
        <p className="t-footnote" role="alert" style={{ color: 'var(--danger)' }}>
          {problem}
        </p>
      )}
      {busy && !results && <span className="spinner" aria-label="Searching" />}
      {results && !results.length && <p className="t-footnote c3">No one in the directory matches “{q.trim()}”.</p>}
      {results && results.length > 0 && (
        <div className="list" aria-busy={busy}>
          {results.map((d) => {
            const has = profileOf(d);
            return (
              <button
                key={d.systemuserid}
                type="button"
                className="list-row"
                disabled={!!has}
                onClick={() => onPick(d)}
                style={{ all: 'unset', display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px', cursor: has ? 'default' : 'pointer', opacity: has ? 0.6 : 1 }}
              >
                <Avatar name={d.fullname} size={34} />
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="t-headline" style={{ display: 'block' }}>
                    {d.fullname}
                  </span>
                  <span className="t-footnote c3 ellipsis" style={{ display: 'block' }}>
                    {[d.email, d.title, d.city].filter(Boolean).join(' · ')}
                  </span>
                </span>
                {has ? <Badge>In Folium · {has.role}</Badge> : <Icon name="chevronRight" size={14} className="c3" />}
              </button>
            );
          })}
        </div>
      )}
      {!results && !problem && <p className="t-footnote c3">Search by name or email. Name, email, phone and title come from their Microsoft account and stay current; you set their role, groups, branch and rep code here.</p>}
    </div>
  );
}

function UserSheet({
  user,
  initial,
  me,
  users,
  groups,
  policy,
  status,
  onClose,
  onSave,
  onSetActive,
}: {
  user?: UserProfile;
  /** For a new profile: the directory person it's for, when already chosen. */
  initial?: DirectoryUser;
  me: UserProfile;
  users: UserProfile[];
  groups: UserGroup[];
  policy: FirmPolicy;
  status?: UserStatus;
  onClose: () => void;
  onSave: (u: UserProfile) => Promise<void>;
  onSetActive?: (active: boolean) => Promise<void>;
}) {
  const [picked, setPicked] = useState<DirectoryUser | undefined>(initial);
  const [u, setU] = useState<UserProfile>(
    user
      ? { ...user, groupIds: groups.filter((g) => g.memberIds.includes(user.systemuserid)).map((g) => g.id) }
      : initial
        ? profileFromDirectory(initial)
        : { systemuserid: '', fullname: '', email: '', phone: '', repCode: '', branch: '', title: '', role: 'User', groupIds: [] },
  );
  const pick = (d: DirectoryUser | undefined) => {
    setPicked(d);
    if (d) setU({ ...profileFromDirectory(d), role: u.role, groupIds: u.groupIds, region: u.region, canEditRepData: u.canEditRepData, canViewReports: u.canViewReports });
  };
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<UserProfile>) => setU({ ...u, ...p });
  const active = !user || user.active !== false;
  const roleProblem = user ? lastAdminProblem(users, [u]) : undefined;
  const deactivateProblem = user ? lastAdminProblem(users, [{ ...user, active: false }]) : undefined;
  return (
    <Sheet
      wide
      title={user ? user.fullname : 'Add user'}
      onClose={onClose}
      footer={
        <>
          {onSetActive && (
            <Button
              variant={active ? 'danger' : 'gray'}
              disabled={busy || (active && !!deactivateProblem)}
              onClick={() => runSave(setBusy, () => onSetActive(!active))}
            >
              {active ? 'Deactivate' : 'Reactivate'}
            </Button>
          )}
          <span className="spacer" />
          <Button variant="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="filled" busy={busy} disabled={(!user && !picked) || !u.fullname || !u.email || !!roleProblem} onClick={() => runSave(setBusy, () => onSave(u))}>
            Save
          </Button>
        </>
      }
    >
      <div className="stack-4">
        {!user && !picked && <DirectoryPicker users={users} onPick={pick} />}
        {!user && picked && (
          <div className="row" style={{ gap: 12 }}>
            <Avatar name={picked.fullname} size={40} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="t-headline">{picked.fullname}</div>
              <div className="t-footnote c3 ellipsis">{[picked.email, picked.title].filter(Boolean).join(' · ')}</div>
            </div>
            <Button variant="gray" size="sm" onClick={() => pick(undefined)}>
              Choose someone else
            </Button>
          </div>
        )}
        {user && status && (
          <p className="t-footnote c3 row" style={{ gap: 8 }}>
            <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
            Last opened Folium: {lastSeen(user)}
            {!active && ' · Deactivated profiles drop out of groups, acting-for and share lists; their requests stay.'}
          </p>
        )}
        {(roleProblem || (active && deactivateProblem && onSetActive)) && (
          <p className="t-footnote" role="note" style={{ color: 'var(--warn)' }}>
            {roleProblem ?? deactivateProblem}
          </p>
        )}
        {(user || picked) && <RepDetails value={u} onChange={set} editor={me} policy={policy} idPrefix="eu" />}
        <div className="grid-2">
          <Field label="Region" htmlFor="eu-region">
            <TextInput id="eu-region" value={u.region ?? ''} onChange={(e) => set({ region: e.target.value })} />
          </Field>
          <Field label="Can edit their own rep details" htmlFor="eu-canedit" help="Rep, OSJ and RIA numbers stay with administrators either way.">
            <Select id="eu-canedit" value={u.canEditRepData === undefined ? '' : String(u.canEditRepData)} onChange={(e) => set({ canEditRepData: e.target.value === '' ? undefined : e.target.value === 'true' })}>
              <option value="">As the firm sets it ({policy.repDataSelfEdit === false ? 'no' : 'yes'})</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </Select>
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
        {u.role !== 'Admin' && (
          <div className="list">
            <SwitchRow
              label="Can open usage reports"
              detail="The reporting role: the sidebar’s Reports link to the firm’s Power BI report. Administrators always have it."
              checked={!!u.canViewReports}
              onChange={(v) => set({ canViewReports: v || undefined })}
            />
          </div>
        )}
        {active && (
          <fieldset className="list" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label" style={{ padding: '0 0 6px 2px' }}>Groups</legend>
            {groups.map((g) => (
              <label key={g.id} className="list-row" style={{ cursor: 'pointer' }}>
                <input type="checkbox" className="check" checked={u.groupIds.includes(g.id)} onChange={(e) => set({ groupIds: e.target.checked ? [...u.groupIds, g.id] : u.groupIds.filter((x) => x !== g.id) })} />
                <span className="grow">{g.name}</span>
                {g.region && <span className="t-footnote c3">{g.region}</span>}
              </label>
            ))}
          </fieldset>
        )}
        {user && <RepAudit user={user} />}
      </div>
    </Sheet>
  );
}

/** Confirm a bulk change: what it does, to whom, and what it can't do. */
function BulkSheet({ action, users, groups, ids, onClose, onConfirm }: { action: BulkAction; users: UserProfile[]; groups: UserGroup[]; ids: string[]; onClose: () => void; onConfirm: (changed: UserProfile[]) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const changed = planBulk(users, ids, action);
  const problem = lastAdminProblem(users, changed);
  const unchanged = ids.length - changed.length;
  const summary = bulkSummary(action, changed.length, groups);
  return (
    <Sheet
      title={summary}
      onClose={onClose}
      footer={
        <>
          <Button variant="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={action.kind === 'deactivate' ? 'danger' : 'filled'} busy={busy} disabled={!changed.length || !!problem} onClick={() => runSave(setBusy, () => onConfirm(changed))}>
            {summary}
          </Button>
        </>
      }
    >
      <div className="stack-3">
        {problem && (
          <p className="t-callout" role="alert" style={{ color: 'var(--danger)' }}>
            {problem}
          </p>
        )}
        {action.kind === 'deactivate' && <p className="t-footnote c3">They drop out of every group and can no longer be worked for or shared with. Their requests and drafts stay, with them as owner.</p>}
        <ul className="list" style={{ margin: 0, padding: 0 }}>
          {changed.map((u) => (
            <li key={u.systemuserid} className="list-row">
              <Avatar name={u.fullname} size={24} alt={u.role !== 'User'} />
              <span className="grow">{u.fullname}</span>
            </li>
          ))}
        </ul>
        {unchanged > 0 && <p className="t-footnote c3">{unchanged === 1 ? '1 selected person is' : `${unchanged} selected people are`} already set this way, so nothing changes for them.</p>}
      </div>
    </Sheet>
  );
}

const SAMPLE_CSV = 'email,role,groups,repCode,branch\r\ntaylor.brenneman@example.org,User,Goshen advisors,EV4471,Goshen\r\nmorgan.beachy@example.org,Assistant,Goshen advisors; Virginia,,Goshen\r\n';

const OUTCOME: Record<ImportOutcome['kind'], { label: string; tone?: 'accent' | 'warn' | 'info' | 'danger' }> = {
  new: { label: 'New', tone: 'accent' },
  changed: { label: 'Changed', tone: 'info' },
  unchanged: { label: 'No change' },
  notFound: { label: 'Not in the directory', tone: 'warn' },
  invalid: { label: 'Can’t import', tone: 'danger' },
};

/** Import or update people from a CSV, previewed against the directory before anything is saved. */
function ImportSheet({ users, groups, onClose, onConfirm }: { users: UserProfile[]; groups: UserGroup[]; onClose: () => void; onConfirm: (changed: UserProfile[]) => Promise<void> }) {
  const services = useServices();
  const [text, setText] = useState('');
  const [plan, setPlan] = useState<ImportOutcome[]>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  async function preview(source: string) {
    setText(source);
    setPlan(undefined);
    const parsed = parseUserImport(source, groups);
    setProblem(parsed.problem);
    if (parsed.problem) return;
    await runSave(setBusy, async () => {
      const directory = await services.directory.lookupDirectory(parsed.rows.map((r) => r.email).filter(Boolean));
      setPlan(planImport(parsed.rows, users, directory, groups));
    });
  }

  const toSave = (plan ?? []).filter((o): o is Extract<ImportOutcome, { next: UserProfile }> => o.kind === 'new' || o.kind === 'changed');
  const adminProblem = lastAdminProblem(users, toSave.map((o) => o.next));
  return (
    <Sheet
      wide
      title="Import people"
      onClose={onClose}
      footer={
        <>
          <Button variant="plain" icon="download" onClick={() => downloadBytes(new TextEncoder().encode(SAMPLE_CSV), 'folium-users-sample.csv', 'text/csv;charset=utf-8')}>
            Sample CSV
          </Button>
          <span className="spacer" />
          <Button variant="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="filled" busy={busy} disabled={!toSave.length || !!adminProblem} onClick={() => runSave(setBusy, () => onConfirm(toSave.map((o) => o.next)))}>
            {toSave.length ? `Save ${toSave.length} ${toSave.length === 1 ? 'person' : 'people'}` : 'Save'}
          </Button>
        </>
      }
    >
      <div className="stack-4">
        <p className="t-footnote c3">
          A CSV with the columns <span className="mono">email, role, groups, repCode, branch</span>. Each email is matched to a person in the Microsoft directory; groups are names separated by “;”. Nothing is saved until you
          confirm, and existing details the file leaves blank are kept.
        </p>
        <div className="row" style={{ gap: 8 }}>
          <input
            ref={file}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) await preview(await f.text());
              e.target.value = '';
            }}
          />
          <Button variant="gray" icon="upload" onClick={() => file.current?.click()}>
            Choose a CSV file
          </Button>
          <span className="t-footnote c3">or paste it below</span>
        </div>
        <TextArea aria-label="CSV to import" rows={5} className="mono" value={text} onChange={(e) => setText(e.target.value)} placeholder={SAMPLE_CSV} />
        <div>
          <Button variant="tinted" disabled={!text.trim() || busy} onClick={() => preview(text)}>
            Preview
          </Button>
        </div>
        {problem && (
          <p className="t-callout" role="alert" style={{ color: 'var(--danger)' }}>
            {problem}
          </p>
        )}
        {adminProblem && (
          <p className="t-callout" role="alert" style={{ color: 'var(--danger)' }}>
            {adminProblem}
          </p>
        )}
        {plan && (
          <ul className="list" aria-label="What the import will do" style={{ margin: 0, padding: 0 }}>
            {plan.map((o) => (
              <li key={`${o.row.line}`} className="list-row" style={{ alignItems: 'flex-start' }}>
                <span className="t-footnote c3 mono" style={{ width: 36 }}>
                  {o.row.line}
                </span>
                <span className="grow">
                  <span style={{ display: 'block', fontWeight: 600 }}>{'next' in o ? o.next.fullname : o.row.email || '(no email)'}</span>
                  <span className="t-footnote c3">
                    {o.kind === 'invalid'
                      ? o.row.errors.join('; ')
                      : o.kind === 'notFound'
                        ? `No one with ${o.row.email} signs in to Microsoft here. Check the spelling.`
                        : 'changes' in o
                          ? o.changes.join(' · ')
                          : o.row.email}
                    {o.row.unknownGroups.length ? ` · No group called ${o.row.unknownGroups.map((g) => `“${g}”`).join(', ')}` : ''}
                  </span>
                </span>
                <Badge tone={OUTCOME[o.kind].tone}>{OUTCOME[o.kind].label}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  );
}

function GroupSheet({ group, users, onClose, onSave, onDelete }: { group?: UserGroup; users: UserProfile[]; onClose: () => void; onSave: (g: UserGroup) => Promise<void>; onDelete?: () => Promise<void> }) {
  const [g, setG] = useState<UserGroup>(group ?? { id: `new-${Date.now()}`, name: '', memberIds: [] });
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<UserGroup>) => setG({ ...g, ...p });
  const toggle = <T,>(list: T[] | undefined, v: T, on: boolean) => (on ? [...(list ?? []), v] : (list ?? []).filter((x) => x !== v));
  const firms = useApp((s) => s.firms);
  const connections = useServices().signing.list();

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
          <Button variant="filled" busy={busy} disabled={!g.name.trim()} onClick={() => runSave(setBusy, () => onSave(g))}>
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
            {users.filter((u) => isActiveUser(u) || g.memberIds.includes(u.systemuserid)).map((u) => (
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
            {firms.length > 1 && (
              <Field label="Firm profile for other forms" htmlFor="g-firm" help="For forms whose issuer no firm profile lists, such as carrier forms. A profile that lists the issuer, or one set on the template, still wins.">
                <Select id="g-firm" value={g.defaultFirmId ?? ''} onChange={(e) => set({ defaultFirmId: e.target.value || undefined })}>
                  <option value="">The default profile</option>
                  {firms.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {connections.length > 1 && (
              <Field label="E-signature" htmlFor="g-sign" help="Over the firm’s default. A firm profile that names one still wins for its forms.">
                <Select id="g-sign" value={g.signingProviderId ?? ''} onChange={(e) => set({ signingProviderId: e.target.value || undefined })}>
                  <option value="">The firm’s default</option>
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
        </div>
      </div>
    </Sheet>
  );
}
