import { useState, type ReactNode } from 'react';
import type { SignatureRequest } from '../../domain/types';
import { useServices } from '../../services';
import { audit } from '../../state/actions';
import { useApp } from '../../state/store';
import { ConfirmSheet, toast } from '../../ui/controls';
import { NameSheet } from './NameSheet';

/** Delete, rename and "remove from my list" for drafts, shared by the draft card and the Drafts list. */
export function useDraftActions(onChanged?: () => void) {
  const services = useServices();
  const me = useApp((s) => s.me);
  const refreshRequests = useApp((s) => s.refreshRequests);
  const [sheet, setSheet] = useState<ReactNode>();
  const close = () => setSheet(undefined);
  const changed = async () => (await refreshRequests(), onChanged?.());

  /** Only the owner, whoever prepared it, or an Admin can delete. People it's shared with can only drop it from their list. */
  const canDelete = (r: SignatureRequest) => !!me && (me.role === 'Admin' || r.ownerId === me.systemuserid || r.preparedById === me.systemuserid);
  const isSharedWithMe = (r: SignatureRequest) => !!me && !canDelete(r) && !!r.sharedWith?.includes(me.systemuserid);

  function askDelete(r: SignatureRequest, clientName?: string) {
    setSheet(
      <ConfirmSheet
        title="Delete draft?"
        confirmLabel="Delete draft"
        onClose={close}
        onConfirm={async () => {
          await services.requests.remove(r.id);
          const wasOpen = useApp.getState().packet.requestId === r.id;
          if (wasOpen) useApp.getState().setPacket({ requestId: undefined });
          await changed();
          const undo = {
            label: 'Undo',
            onClick: async () => {
              try {
                await services.requests.restore(r.id);
                if (wasOpen && !useApp.getState().packet.requestId) useApp.getState().setPacket({ requestId: r.id });
                await changed();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : 'Could not restore the draft');
              }
            },
          };
          toast.ok(wasOpen ? 'This draft was deleted. Your forms are still open; Save draft to keep them.' : `Deleted “${r.title}”`, undo);
        }}
      >
        Delete draft “{r.title}”{clientName ? ` for ${clientName}` : ''}? Values you entered will be gone.
      </ConfirmSheet>,
    );
  }

  async function removeFromMyList(r: SignatureRequest) {
    if (!me) return;
    try {
      await services.requests.save({ ...r, sharedWith: (r.sharedWith ?? []).filter((id) => id !== me.systemuserid), audit: [...r.audit, audit(me, 'Removed from their shared list')] });
      await changed();
      toast.ok(`Removed “${r.title}” from your list`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update the draft');
    }
  }

  /** `siblings`: the client's other drafts, for the duplicate-name check. */
  function askRename(r: SignatureRequest, siblings: SignatureRequest[]) {
    setSheet(
      <NameSheet
        title="Rename draft"
        noun="draft"
        initial={r.title}
        existing={siblings.filter((x) => x.status === 'Drafted' && x.contactId === r.contactId).map((x) => ({ id: x.id, name: x.title }))}
        exceptId={r.id}
        saveLabel="Rename"
        onClose={close}
        onSave={async (title) => {
          await services.requests.save({ ...r, title, audit: [...r.audit, audit(me, 'Renamed', `“${r.title}” → “${title}”`)] });
          if (useApp.getState().packet.requestId === r.id) useApp.getState().setPacket({ title });
          await changed();
          toast.ok(`Renamed to “${title}”`);
        }}
      />,
    );
  }

  return { canDelete, isSharedWithMe, askDelete, removeFromMyList, askRename, sheet };
}
