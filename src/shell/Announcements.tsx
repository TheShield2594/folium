import { useEffect, useState } from 'react';
import { activeAnnouncements, canDismiss, messageParts, type Announcement } from '../domain/announcements';
import { useApp } from '../state/store';
import { IconButton } from '../ui/controls';
import { Icon } from '../ui/Icon';

/** A message as text with its http(s) links clickable. Never HTML. */
export function AnnouncementText({ message }: { message: string }) {
  return (
    <>
      {messageParts(message).map((p, i) =>
        'href' in p ? (
          <a key={i} href={p.href} target="_blank" rel="noopener noreferrer">
            {p.text}
          </a>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

const TONE: Record<Announcement['severity'], string> = { info: 'banner info', warn: 'banner', critical: 'banner critical' };

/**
 * Announcements from Administration › Announcements, across the top of the main column.
 * Read again when the window comes back into focus, at most every 15 minutes, so an
 * outage notice reaches people who keep Folium open all day.
 */
export function AnnouncementBanners() {
  const announcements = useApp((s) => s.announcements);
  const me = useApp((s) => s.me);
  const groups = useApp((s) => s.groups);
  const dismissed = useApp((s) => s.dismissed);
  const dismiss = useApp((s) => s.dismissAnnouncement);
  const refresh = useApp((s) => s.refreshAnnouncements);
  const [all, setAll] = useState(false);
  // Re-render every minute, so a scheduled one starts and a live one ends without a reload.
  const [, setTick] = useState(0);

  useEffect(() => {
    const onFocus = () => {
      setTick((n) => n + 1);
      void refresh();
    };
    const onVisible = () => document.visibilityState === 'visible' && onFocus();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    const tick = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(tick);
    };
  }, [refresh]);

  const { shown, more } = activeAnnouncements(announcements, me, groups, new Date(), dismissed, all ? Infinity : undefined);
  if (!shown.length) return null;
  return (
    <>
      {shown.map((a, i) => (
        <div key={a.id} className={`${TONE[a.severity]} app-banner announcement`} role={a.severity === 'critical' ? 'alert' : 'status'}>
          <Icon name={a.severity === 'info' ? 'bell' : 'warning'} size={18} />
          <span className="grow t-callout announcement-text">
            <AnnouncementText message={a.message} />
          </span>
          {i === shown.length - 1 && more > 0 && (
            <button type="button" className="btn btn-plain btn-sm" onClick={() => setAll(true)}>
              +{more} more
            </button>
          )}
          {canDismiss(a) && <IconButton icon="x" label="Dismiss announcement" onClick={() => dismiss(a.id)} />}
        </div>
      ))}
    </>
  );
}
