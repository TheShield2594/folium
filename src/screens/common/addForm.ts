import { PACKET_LIMIT, useApp, type AddResult } from '../../state/store';
import { toast } from '../../ui/controls';

/** Add a form to the packet, saying so when the packet is full. */
export function addForm(templateId: string, accountId?: string, opts?: { duplicate?: boolean }): AddResult {
  const r = useApp.getState().addToPacket(templateId, accountId, opts);
  if (r === 'full') toast.error(`A packet holds up to ${PACKET_LIMIT} forms. Send this one, then start another.`);
  return r;
}
