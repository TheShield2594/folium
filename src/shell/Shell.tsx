import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { FoliumMark } from '../brand/FoliumMark';
import { useServices } from '../services';
import { actableUsers, useActingFor, useApp } from '../state/store';
import { Avatar, IconButton, Select } from '../ui/controls';
import { Icon, type IconName } from '../ui/Icon';
import { CommandPalette } from './CommandPalette';
import { ContactPicker } from './ContactPicker';
import { ConnectionBanner, IdleAutoSave, RestoreBanner } from './Recovery';

function NavItem({ to, icon, children, count, alert, end }: { to: string; icon: IconName; children: ReactNode; count?: number; alert?: boolean; end?: boolean }) {
  const setSidebar = useApp((s) => s.setSidebar);
  return (
    <NavLink to={to} end={end} className="nav-item" onClick={() => setSidebar(false)}>
      <Icon name={icon} size={18} />
      <span className="grow ellipsis">{children}</span>
      {count ? <span className={['count', alert && 'alert'].filter(Boolean).join(' ')}>{count}</span> : null}
    </NavLink>
  );
}

export function Sidebar() {
  const me = useApp((s) => s.me);
  const users = useApp((s) => s.users);
  const groups = useApp((s) => s.groups);
  const client = useApp((s) => s.client);
  const requests = useApp((s) => s.requests);
  const packet = useApp((s) => s.packet);
  const setActingFor = useApp((s) => s.setActingFor);
  const actingFor = useActingFor();
  const services = useServices();
  const [picking, setPicking] = useState(false);
  const navigate = useNavigate();

  const waiting = requests.filter((r) => r.status === 'Sent' || r.status === 'Viewed').length;
  const toFile = requests.filter((r) => r.status === 'Signed' && !r.uploadedToOnBase).length;
  const drafts = requests.filter((r) => r.status === 'Drafted').length;
  const canAct = me ? actableUsers(me, users, groups) : [];

  return (
    <nav className="sidebar" aria-label="Folium">
      <div className="sidebar-head">
        <FoliumMark size={26} />
        <span className="wordmark">Folium</span>
        {services.mode === 'demo' && (
          <span className="badge" style={{ marginLeft: 'auto' }} title="Running on sample data">
            Demo
          </span>
        )}
      </div>

      <div className="sidebar-scroll">
        {me?.role === 'Assistant' && (
          <div className="field" style={{ marginBottom: 12, padding: '0 2px' }}>
            <label htmlFor="acting-for" className="t-caption c3" style={{ paddingLeft: 8 }}>
              Working for
            </label>
            <Select id="acting-for" value={actingFor?.systemuserid} onChange={(e) => setActingFor(e.target.value)}>
              {canAct.map((u) => (
                <option key={u.systemuserid} value={u.systemuserid}>
                  {u.fullname}
                </option>
              ))}
            </Select>
          </div>
        )}

        <button className="client-card" onClick={() => setPicking(true)} aria-label={client ? `Client: ${client.contact.fullname}. Change client` : 'Choose a client'}>
          {client ? <Avatar name={client.contact.fullname} size={34} alt /> : <span className="avatar" style={{ width: 34, height: 34, background: 'var(--fill-2)', color: 'var(--label-3)' }}><Icon name="person" size={18} /></span>}
          <span className="grow" style={{ minWidth: 0 }}>
            <span className="t-headline ellipsis" style={{ display: 'block' }}>{client ? client.contact.fullname : 'Choose a client'}</span>
            <span className="t-footnote c3 ellipsis" style={{ display: 'block' }}>
              {client ? `${client.contact.ev_clientid} · ${client.accounts.length} accounts` : 'Search Dynamics 365 contacts'}
            </span>
          </span>
          <Icon name="chevronDown" size={14} className="c3" />
        </button>

        <div className="sidebar-section">
          <h2>Forms</h2>
          <NavItem to="/" end icon="docs" count={packet.items.length || undefined}>
            Find forms
          </NavItem>
          <NavItem to="/packets" icon="tray">
            Saved packets
          </NavItem>
          <NavItem to="/recent" icon="clock">
            Recent & favorites
          </NavItem>
        </div>

        <div className="sidebar-section">
          <h2>Activity</h2>
          <NavItem to="/requests" icon="signature" count={waiting + toFile || undefined} alert={toFile > 0}>
            Signature requests
          </NavItem>
          <NavItem to="/drafts" icon="pencil" count={drafts || undefined}>
            Drafts & shared
          </NavItem>
        </div>

        {client && (
          <div className="sidebar-section">
            <h2>Client</h2>
            <NavItem to="/client" icon="person">
              Contact & accounts
            </NavItem>
          </div>
        )}

        {me?.role === 'Admin' && (
          <div className="sidebar-section">
            <h2>Administration</h2>
            <NavItem to="/admin/templates" icon="folder">
              Template library
            </NavItem>
            <NavItem to="/admin/people" icon="people">
              Users & groups
            </NavItem>
            <NavItem to="/admin/firm" icon="building">
              Firm profile
            </NavItem>
          </div>
        )}
      </div>

      <div className="sidebar-foot">
        <Avatar name={me?.fullname ?? '?'} size={30} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="t-callout ellipsis" style={{ fontWeight: 600 }}>{me?.fullname}</div>
          <div className="t-footnote c3 ellipsis">{me?.role === 'Assistant' ? `Assistant · for ${actingFor?.fullname ?? '—'}` : me?.role === 'Admin' ? 'Administrator' : me?.title}</div>
        </div>
        <IconButton icon="gear" label="Settings" onClick={() => navigate('/settings')} />
      </div>

      {picking && <ContactPicker onClose={() => setPicking(false)} />}
    </nav>
  );
}

export function Toolbar({ title, subtitle, children, back }: { title?: ReactNode; subtitle?: ReactNode; children?: ReactNode; back?: { label: string; to: string } }) {
  const setSidebar = useApp((s) => s.setSidebar);
  const setPalette = useApp((s) => s.setPalette);
  const navigate = useNavigate();
  return (
    <header className="toolbar">
      <IconButton icon="sidebar" label="Show sidebar" className="only-compact" onClick={() => setSidebar(true)} />
      {back && (
        <button className="btn btn-plain" onClick={() => navigate(back.to)} style={{ paddingLeft: 4 }}>
          <Icon name="chevronLeft" size={18} strokeWidth={2.2} />
          {back.label}
        </button>
      )}
      <div className="grow" style={{ minWidth: 0 }}>
        {title && <div className="toolbar-title">{title}</div>}
        {subtitle && <div className="toolbar-sub ellipsis">{subtitle}</div>}
      </div>
      {children}
      <IconButton icon="search" label="Search everything (⌘K)" onClick={() => setPalette(true)} />
    </header>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const setSidebar = useApp((s) => s.setSidebar);
  const paletteOpen = useApp((s) => s.paletteOpen);
  const setPalette = useApp((s) => s.setPalette);
  const location = useLocation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(!useApp.getState().paletteOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPalette]);

  useEffect(() => {
    document.querySelector('.scroll')?.scrollTo({ top: 0 });
  }, [location.pathname]);

  const scrim = useMemo(
    () => sidebarOpen && <div onClick={() => setSidebar(false)} style={{ position: 'fixed', inset: 0, zIndex: 55, background: 'rgba(0,0,0,.25)' }} aria-hidden="true" />,
    [sidebarOpen, setSidebar],
  );

  return (
    <div className="app" data-sidebar={sidebarOpen ? 'open' : undefined}>
      <Sidebar />
      {scrim}
      <div className="main">
        <ConnectionBanner />
        <RestoreBanner />
        <IdleAutoSave />
        {children}
      </div>
      {paletteOpen && <CommandPalette onClose={() => setPalette(false)} />}
    </div>
  );
}
