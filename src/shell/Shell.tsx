import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { FoliumMark } from '../brand/FoliumMark';
import { canOpenReports } from '../domain/reports';
import { useServices } from '../services';
import { actableUsers, useActingFor, useApp } from '../state/store';
import { Avatar, IconButton, Select } from '../ui/controls';
import { Icon, type IconName } from '../ui/Icon';
import { CommandPalette } from './CommandPalette';
import { ContactPicker } from './ContactPicker';
import { FeedbackNotices } from '../screens/common/MyFeedback';
import { AnnouncementBanners } from './Announcements';
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

/** A sidebar link that opens outside Folium (the Power BI report). */
function ExternalNavItem({ href, icon, children }: { href: string; icon: IconName; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="nav-item">
      <Icon name={icon} size={18} />
      <span className="grow ellipsis">{children}</span>
      <Icon name="arrowUpRight" size={14} className="c3" />
    </a>
  );
}

export function Sidebar() {
  const me = useApp((s) => s.me);
  const firm = useApp((s) => s.firm);
  const reports = canOpenReports(me, firm);
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
  const policy = useApp((s) => s.policy);
  const canAct = me ? actableUsers(me, users, groups, policy) : [];
  // Assistants always pick a User; Users do when the firm lets them work as a colleague in their groups.
  const picker = me?.role === 'Assistant' || canAct.length > 1;

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
        {picker && (
          <div className="field" style={{ marginBottom: 12, padding: '0 2px' }}>
            <label htmlFor="acting-for" className="t-caption c3" style={{ paddingLeft: 8 }}>
              Working for
            </label>
            <Select id="acting-for" value={actingFor?.systemuserid} onChange={(e) => setActingFor(e.target.value)}>
              {canAct.map((u) => (
                <option key={u.systemuserid} value={u.systemuserid}>
                  {u.systemuserid === me?.systemuserid ? `${u.fullname} (you)` : u.fullname}
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
            <NavItem to="/admin/feedback" icon="flag">
              Form feedback
            </NavItem>
            <NavItem to="/admin/announcements" icon="bell">
              Announcements
            </NavItem>
            <NavItem to="/admin/firm" icon="building">
              Firm profiles
            </NavItem>
            <NavItem to="/admin/settings" icon="lock">
              Settings
            </NavItem>
            <NavItem to="/admin/readiness" icon="target">
              Readiness
            </NavItem>
            {reports && (
              <ExternalNavItem href={firm!.reportsUrl!} icon="chart">
                Reports
              </ExternalNavItem>
            )}
          </div>
        )}

        {me?.role !== 'Admin' && reports && (
          <div className="sidebar-section">
            <h2>Reporting</h2>
            <ExternalNavItem href={firm!.reportsUrl!} icon="chart">
              Reports
            </ExternalNavItem>
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
  // Each screen names the browser tab, so the page title says where you are (WCAG 2.4.2).
  useEffect(() => {
    if (typeof title === 'string') document.title = `${title} – Folium`;
  }, [title]);
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

  const main = useRef<HTMLElement>(null);
  const firstPath = useRef(true);
  useEffect(() => {
    document.querySelector('.scroll')?.scrollTo({ top: 0 });
    // A new screen takes focus, so keyboard and screen-reader users start at its top
    // instead of back in the sidebar. A screen that focuses a field itself goes after this.
    if (firstPath.current) firstPath.current = false;
    else if (!main.current?.contains(document.activeElement)) main.current?.focus({ preventScroll: true });
  }, [location.pathname]);

  return (
    <div className="app" data-sidebar={sidebarOpen ? 'open' : undefined}>
      <a className="skip-link" href="#main" onClick={(e) => (e.preventDefault(), main.current?.focus())}>
        Skip to content
      </a>
      <Sidebar />
      <div className="scrim" onClick={() => setSidebar(false)} aria-hidden="true" />
      <main id="main" ref={main} className="main" tabIndex={-1}>
        <AnnouncementBanners />
        <ConnectionBanner />
        <RestoreBanner />
        <IdleAutoSave />
        <FeedbackNotices />
        {children}
      </main>
      {paletteOpen && <CommandPalette onClose={() => setPalette(false)} />}
    </div>
  );
}
