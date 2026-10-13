import { useState } from 'react';
import { ContactPicker } from '../../shell/ContactPicker';
import { Toolbar } from '../../shell/Shell';
import { Button, Empty, Spinner } from '../../ui/controls';

export function NoClient({ loading }: { loading?: boolean }) {
  const [picking, setPicking] = useState(false);
  return (
    <>
      <Toolbar title="Folium" />
      <div className="scroll" style={{ display: 'grid', placeItems: 'center' }}>
        {loading ? (
          <Spinner />
        ) : (
          <Empty
            icon="person"
            title="Choose a client to start"
            action={
              <Button variant="filled" size="lg" icon="search" onClick={() => setPicking(true)}>
                Find a client
              </Button>
            }
          >
            Folium prefills forms from the client’s record in Dynamics 365. Open it from a contact’s Forms tab, or search here.
          </Empty>
        )}
      </div>
      {picking && <ContactPicker onClose={() => setPicking(false)} />}
    </>
  );
}
