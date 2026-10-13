import { useEffect, useState } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { FoliumAppIcon } from './brand/FoliumMark';
import { AdminFirm } from './screens/admin/AdminFirm';
import { AdminPeople } from './screens/admin/AdminPeople';
import { AdminTemplates } from './screens/admin/AdminTemplates';
import { TemplateEditor } from './screens/admin/TemplateEditor';
import { ClientScreen } from './screens/client/ClientScreen';
import { LibraryScreen } from './screens/library/LibraryScreen';
import { PacketsScreen } from './screens/library/PacketsScreen';
import { RecentScreen } from './screens/library/RecentScreen';
import { DraftsScreen } from './screens/requests/DraftsScreen';
import { RequestsScreen } from './screens/requests/RequestsScreen';
import { ReviewScreen } from './screens/review/ReviewScreen';
import { SendScreen } from './screens/send/SendScreen';
import { SettingsScreen } from './screens/settings/SettingsScreen';
import { createServices, ServicesContext } from './services';
import type { Services } from './services/types';
import { Shell } from './shell/Shell';
import { useApp } from './state/store';
import { Toasts } from './ui/controls';

/** Folium is opened from the Contact form with `?contactId=<guid>` (or `#/...?contactId=`). */
function launchContactId(): string | undefined {
  const fromSearch = new URLSearchParams(location.search).get('contactId');
  if (fromSearch) return fromSearch.replace(/[{}]/g, '');
  const hashQuery = location.hash.split('?')[1];
  return hashQuery ? new URLSearchParams(hashQuery).get('contactId')?.replace(/[{}]/g, '') ?? undefined : undefined;
}

async function contactIdFromHost(demo: boolean): Promise<string | undefined> {
  const direct = launchContactId();
  if (direct) return direct;
  // Outside the Power Apps host there's no context to ask; open the sample client.
  if (demo) return undefined;
  try {
    const { getContext } = await import('@microsoft/power-apps/app');
    const ctx = await Promise.race([getContext(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500))]);
    return ctx.app.queryParams?.contactId?.replace(/[{}]/g, '');
  } catch {
    return undefined;
  }
}

function hasLastContact() {
  try {
    return !!localStorage.getItem('folium.lastContact');
  } catch {
    return false;
  }
}

function Launch() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
      <div className="stack-3" style={{ alignItems: 'center' }}>
        <div style={{ animation: 'pop-in 600ms var(--ease)' }}>
          <FoliumAppIcon size={72} />
        </div>
        <span className="spinner" aria-label="Loading Folium" />
      </div>
    </div>
  );
}

export function App() {
  const [services, setServices] = useState<Services>();
  const ready = useApp((s) => s.ready);
  const error = useApp((s) => s.error);
  const boot = useApp((s) => s.boot);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await createServices();
      const demo = s.mode === 'demo';
      const contactId = await contactIdFromHost(demo);
      if (cancelled) return;
      setServices(s);
      await boot(s, contactId ?? (demo && !hasLastContact() ? 'c-jordan' : undefined));
    })();
    return () => {
      cancelled = true;
    };
  }, [boot]);

  if (!services || !ready) return <Launch />;
  if (error) {
    return (
      <div className="empty" style={{ height: '100%', justifyContent: 'center' }}>
        <FoliumAppIcon size={64} />
        <h3>Folium couldn’t start</h3>
        <p className="t-callout">{error}</p>
        <button className="btn btn-filled" onClick={() => location.reload()}>Try again</button>
      </div>
    );
  }

  return (
    <ServicesContext.Provider value={services}>
      <HashRouter>
        <Shell>
          <Routes>
            <Route path="/" element={<LibraryScreen />} />
            <Route path="/packets" element={<PacketsScreen />} />
            <Route path="/recent" element={<RecentScreen />} />
            <Route path="/review" element={<ReviewScreen />} />
            <Route path="/send" element={<SendScreen />} />
            <Route path="/requests" element={<RequestsScreen />} />
            <Route path="/drafts" element={<DraftsScreen />} />
            <Route path="/client" element={<ClientScreen />} />
            <Route path="/settings" element={<SettingsScreen />} />
            <Route path="/admin/templates" element={<AdminTemplates />} />
            <Route path="/admin/templates/:id" element={<TemplateEditor />} />
            <Route path="/admin/people" element={<AdminPeople />} />
            <Route path="/admin/firm" element={<AdminFirm />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Shell>
        <Toasts />
      </HashRouter>
    </ServicesContext.Provider>
  );
}
