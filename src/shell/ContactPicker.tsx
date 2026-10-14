import { useEffect, useState } from 'react';
import type { Contact } from '../domain/types';
import { useServices } from '../services';
import { useApp } from '../state/store';
import { Avatar, Empty, SearchField, Sheet, Spinner, toast } from '../ui/controls';
import { Icon } from '../ui/Icon';

/** Pick the Dynamics 365 contact to work on (when Folium wasn't opened from a contact record). */
export function ContactPicker({ onClose }: { onClose: () => void }) {
  const services = useServices();
  const openContact = useApp((s) => s.openContact);
  const current = useApp((s) => s.contactId);
  const actingForId = useApp((s) => s.actingForId);
  const me = useApp((s) => s.me);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Contact[] | null>(null);

  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      try {
        const list = q.trim() ? await services.crm.searchContacts(q) : await services.crm.recentContacts();
        if (live) setResults(list);
      } catch (e) {
        if (!live) return;
        setResults([]);
        toast.error(e instanceof Error ? e.message : 'Could not search contacts');
      }
    }, q ? 180 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, services]);

  // Assistants see their advisor's book first.
  const sorted = (results ?? []).slice().sort((a, b) => Number(b.ownerid === actingForId) - Number(a.ownerid === actingForId));

  async function pick(c: Contact) {
    try {
      // False when the advisor chose to stay with their unsaved packet.
      if (await openContact(c.contactid)) onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not open contact');
    }
  }

  return (
    <Sheet title="Choose a client" onClose={onClose}>
      <div className="stack-4">
        <SearchField value={q} onChange={setQ} placeholder="Name, client ID or email" autoFocus label="Search contacts" />
        {results === null ? (
          <div className="row" style={{ justifyContent: 'center', padding: 24 }}>
            <Spinner />
          </div>
        ) : sorted.length === 0 ? (
          <Empty icon="person" title="No matching contacts">
            Check the spelling, or search by client ID.
          </Empty>
        ) : (
          <div className="list" role="listbox" aria-label="Contacts">
            {sorted.map((c) => (
              <button key={c.contactid} className="list-row" role="option" aria-selected={c.contactid === current} onClick={() => pick(c)}>
                <Avatar name={c.fullname} size={32} alt />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="t-headline">{c.fullname}</div>
                  <div className="t-footnote c3 ellipsis">
                    <span className="mono">{c.ev_clientid}</span> · {[c.address1_city, c.address1_stateorprovince].filter(Boolean).join(', ')}
                    {actingForId !== me?.systemuserid && c.ownerid === actingForId ? (me?.role === 'Assistant' ? ' · in your advisor’s book' : ' · in your colleague’s book') : ''}
                  </div>
                </div>
                {c.contactid === current && <Icon name="check" size={18} className="c-accent" />}
              </button>
            ))}
          </div>
        )}
        <p className="t-footnote c3">
          Opened from a contact in Dynamics 365, Folium picks the client automatically.
        </p>
      </div>
    </Sheet>
  );
}
