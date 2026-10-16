import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { searchTemplates } from '../screens/library/search';
import { PACKET_LIMIT, currentTemplates, useApp, visibleTemplates } from '../state/store';
import { toast } from '../ui/controls';
import { Icon, type IconName } from '../ui/Icon';

interface Cmd {
  id: string;
  icon: IconName;
  title: string;
  detail?: string;
  run: () => void;
}

/** ⌘K: jump anywhere, or add a form to the packet without leaving the keyboard. */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const navigate = useNavigate();
  const me = useApp((s) => s.me);
  const groups = useApp((s) => s.groups);
  const templates = useApp((s) => s.templates);
  const packets = useApp((s) => s.packets);
  const addToPacket = useApp((s) => s.addToPacket);
  const loadPacket = useApp((s) => s.loadPacket);
  const client = useApp((s) => s.client);
  const listRef = useRef<HTMLDivElement>(null);

  const cmds = useMemo<Cmd[]>(() => {
    const go = (to: string) => () => navigate(to);
    const nav: Cmd[] = [
      { id: 'n-forms', icon: 'docs', title: 'Find forms', run: go('/') },
      { id: 'n-review', icon: 'checkCircle', title: 'Review packet', run: go('/review') },
      { id: 'n-req', icon: 'signature', title: 'Signature requests', run: go('/requests') },
      { id: 'n-drafts', icon: 'pencil', title: 'Drafts & shared', run: go('/drafts') },
      { id: 'n-packets', icon: 'tray', title: 'Saved packets', run: go('/packets') },
      { id: 'n-client', icon: 'person', title: 'Contact & accounts', run: go('/client') },
      { id: 'n-settings', icon: 'gear', title: 'Settings', run: go('/settings') },
      ...(me?.role === 'Admin'
        ? [
            { id: 'n-tpl', icon: 'folder' as IconName, title: 'Template library', run: go('/admin/templates') },
            { id: 'n-ppl', icon: 'people' as IconName, title: 'Users & groups', run: go('/admin/people') },
            { id: 'n-ann', icon: 'bell' as IconName, title: 'Announcements', run: go('/admin/announcements') },
            { id: 'n-firm', icon: 'building' as IconName, title: 'Firm profiles', run: go('/admin/firm') },
            { id: 'n-ready', icon: 'target' as IconName, title: 'Readiness', run: go('/admin/readiness') },
          ]
        : []),
    ];
    const live = currentTemplates(visibleTemplates(me, groups, templates));
    const forms: Cmd[] = searchTemplates(live, q)
      .slice(0, 8)
      .map((t) => ({
        id: `f-${t.id}`,
        icon: 'plus',
        title: `Add ${t.name}`,
        detail: `${t.formNumber} · ${t.issuer ?? t.source}`,
        run: () => {
          if (!client) return toast.error('Choose a client first.');
          const r = addToPacket(t.id);
          if (r === 'full') toast.error(`A packet holds up to ${PACKET_LIMIT} forms.`);
          else toast.ok(r === 'present' ? `${t.name} is already in the packet` : `Added ${t.name}`);
        },
      }));
    const pk: Cmd[] = packets
      .filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 4)
      .map((p) => ({ id: `p-${p.id}`, icon: 'tray', title: `Start “${p.name}”`, detail: `${p.templateIds.length} forms`, run: async () => {
        if (!(await useApp.getState().confirmReplacePacket('open-draft'))) return;
        loadPacket(p);
        navigate('/');
      } }));
    const s = q.toLowerCase();
    return [...(q ? forms : []), ...pk, ...nav.filter((n) => !s || n.title.toLowerCase().includes(s))];
  }, [q, me, groups, templates, packets, navigate, addToPacket, loadPacket, client]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((i) => Math.min(cmds.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      cmds[sel]?.run();
      onClose();
    } else if (e.key === 'Escape') {
      onClose();
    }
  }

  return createPortal(
    <div className="sheet-backdrop instant" style={{ placeItems: 'start center', paddingTop: '12vh' }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Search Folium" style={{ width: 'min(620px, 100%)' }}>
        <div className="row" style={{ padding: '14px 16px', borderBottom: '0.5px solid var(--separator)' }}>
          <Icon name="search" size={20} className="c3" />
          <input
            autoFocus
            className="grow"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search forms, packets and places"
            role="combobox"
            aria-label="Search"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls="palette-list"
            aria-activedescendant={cmds[sel] ? `cmd-${cmds[sel].id}` : undefined}
            style={{ border: 0, outline: 'none', background: 'transparent', font: 'var(--t-title3)', fontWeight: 400 }}
          />
          <span className="kbd">esc</span>
        </div>
        {cmds.length === 0 && (
          <div className="t-callout c3" role="status" style={{ padding: 16 }}>
            Nothing matches “{q}”.
          </div>
        )}
        <div ref={listRef} id="palette-list" role="listbox" aria-label="Results" style={{ maxHeight: 420, overflow: 'auto', padding: cmds.length ? 6 : 0 }}>
          {cmds.map((c, i) => (
            <div
              key={c.id}
              id={`cmd-${c.id}`}
              data-i={i}
              role="option"
              aria-selected={i === sel}
              className="menu-item"
              style={i === sel ? { background: 'var(--accent)', color: 'var(--on-accent)' } : undefined}
              onMouseMove={() => setSel(i)}
              onClick={() => {
                c.run();
                onClose();
              }}
            >
              <Icon name={c.icon} size={17} />
              <span className="grow ellipsis">{c.title}</span>
              {c.detail && <span className="t-footnote" style={{ opacity: i === sel ? 1 : 0.75 }}>{c.detail}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
