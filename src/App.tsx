import { useEffect, useState } from 'react';
import { createHashRouter, Navigate, Outlet, RouterProvider } from 'react-router-dom';
import { FoliumAppIcon } from './brand/FoliumMark';
import { isActiveUser } from './domain/users';
import { AdminFeedback } from './screens/admin/AdminFeedback';
import { AdminAnnouncements } from './screens/admin/AdminAnnouncements';
import { AdminFirm } from './screens/admin/AdminFirm';
import { AdminSettings } from './screens/admin/AdminSettings';
import { AdminPeople } from './screens/admin/AdminPeople';
import { AdminTemplates } from './screens/admin/AdminTemplates';
import { TemplateEditor } from './screens/admin/TemplateEditor';
import { ClientScreen } from './screens/client/ClientScreen';
import { LibraryScreen } from './screens/library/LibraryScreen';
import { PacketsScreen } from './screens/library/PacketsScreen';
import { RecentScreen } from './screens/library/RecentScreen';
import { DraftsScreen } from './screens/requests/DraftsScreen';
import { DemoSigning, SigningReturn } from './screens/requests/InSessionSigning';
import { RequestsScreen } from './screens/requests/RequestsScreen';
import { ReviewScreen } from './screens/review/ReviewScreen';
import { SendScreen } from './screens/send/SendScreen';
import { SettingsScreen } from './screens/settings/SettingsScreen';
import { createServices, ServicesContext } from './services';
import { setDemoUser } from './services/demo';
import type { Services } from './services/types';
import { UnsavedGuards } from './shell/Recovery';
import { Shell } from './shell/Shell';
import { startJournal, useApp } from './state/store';
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

function Root() {
  return (
    <>
      <Shell>
        <Outlet />
      </Shell>
      <Toasts />
      <UnsavedGuards />
    </>
  );
}

// A data router, so leaving Review or Send with unsaved work can be confirmed (useBlocker).
const router = createHashRouter([
  {
    element: <Root />,
    children: [
      { path: '/', element: <LibraryScreen /> },
      { path: '/packets', element: <PacketsScreen /> },
      { path: '/recent', element: <RecentScreen /> },
      { path: '/review', element: <ReviewScreen /> },
      { path: '/send', element: <SendScreen /> },
      { path: '/requests', element: <RequestsScreen /> },
      { path: '/signing-return', element: <SigningReturn /> },
      { path: '/drafts', element: <DraftsScreen /> },
      { path: '/client', element: <ClientScreen /> },
      { path: '/settings', element: <SettingsScreen /> },
      { path: '/admin/templates', element: <AdminTemplates /> },
      { path: '/admin/templates/:id', element: <TemplateEditor /> },
      { path: '/admin/people', element: <AdminPeople /> },
      { path: '/admin/feedback', element: <AdminFeedback /> },
      { path: '/admin/announcements', element: <AdminAnnouncements /> },
      { path: '/admin/firm', element: <AdminFirm /> },
      { path: '/admin/settings', element: <AdminSettings /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
  // Demo mode's stand-in for DocuSign's signing page, outside the app shell.
  { path: '/demo-signing', element: <DemoSigning /> },
]);

export function App() {
  const [services, setServices] = useState<Services>();
  const ready = useApp((s) => s.ready);
  const error = useApp((s) => s.error);
  const boot = useApp((s) => s.boot);
  const me = useApp((s) => s.me);

  // Keep the open packet in the session journal so a reload doesn't lose it.
  useEffect(() => startJournal(), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await createServices();
        const demo = s.mode === 'demo';
        const contactId = await contactIdFromHost(demo);
        if (cancelled) return;
        setServices(s);
        await boot(s, contactId ?? (demo && !hasLastContact() ? 'c-jordan' : undefined));
      } catch (e) {
        // A misconfigured environment should say so, not spin forever.
        if (!cancelled) useApp.setState({ error: e instanceof Error ? e.message : String(e), ready: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [boot]);

  if (!ready) return <Launch />;
  if (error || !services) {
    return (
      <div className="empty" style={{ height: '100%', justifyContent: 'center' }}>
        <FoliumAppIcon size={64} />
        <h3>Folium couldn’t start</h3>
        <p className="t-callout">{error}</p>
        <button className="btn btn-filled" onClick={() => location.reload()}>Try again</button>
      </div>
    );
  }

  if (me && !isActiveUser(me)) {
    // Deactivated in Folium, or turned off in the directory. Their requests are kept.
    return (
      <div className="empty" style={{ height: '100%', justifyContent: 'center' }}>
        <FoliumAppIcon size={64} />
        <h3>Your Folium access is turned off</h3>
        <p className="t-callout">Ask a Folium administrator to reactivate your profile. Requests you sent are still on file.</p>
        {services.mode === 'demo' && (
          <button
            className="btn btn-filled"
            onClick={() => {
              setDemoUser('usr-advisor-1');
              location.reload();
            }}
          >
            Switch back to the demo advisor
          </button>
        )}
      </div>
    );
  }

  return (
    <ServicesContext.Provider value={services}>
      <RouterProvider router={router} />
    </ServicesContext.Provider>
  );
}
