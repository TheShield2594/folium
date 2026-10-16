import { suggestPacket, type PacketSuggestion } from '../../domain/startPacket';
import { availableIn, pickVariant } from '../../domain/states';
import type { FormTemplate } from '../../domain/types';
import { currentTemplates, packetState, useApp, visibleTemplates } from '../../state/store';
import { toast } from '../../ui/controls';
import { addForm } from '../common/addForm';

/** The forms the advisor can use for the open client now: current, in their groups, one version per state group. */
export function usableTemplates(): FormTemplate[] {
  const { me, groups, templates, packet, client } = useApp.getState();
  const live = currentTemplates(visibleTemplates(me, groups, templates));
  const state = packetState(packet, client);
  const shown = new Set<string>();
  return live.filter((t) => {
    if (!availableIn(t, state)) return false;
    if (!t.variantGroup) return true;
    if (shown.has(t.variantGroup)) return false;
    const pick = pickVariant(live, t.variantGroup, state) ?? t;
    if (pick.id !== t.id) return false;
    shown.add(t.variantGroup);
    return true;
  });
}

/**
 * Start a packet for the open client from a description: replace the packet on screen
 * (asking first if it has unsaved work), add the matched forms and remember why each
 * was added. Resolves to the forms added, or undefined when nothing happened.
 */
export async function buildPacket(text: string): Promise<PacketSuggestion[] | undefined> {
  const app = useApp.getState();
  if (!app.client) return undefined;
  const picks = suggestPacket(text, usableTemplates(), app.client);
  if (!picks.length) {
    toast.error('No forms matched that. Try a form name or number, or browse Find forms.');
    return undefined;
  }
  if (!(await app.confirmReplacePacket('switch'))) return undefined;
  useApp.getState().clearPacket();
  // Key each reason by the template that actually went in: adding picks the version for
  // the packet's state, which can differ from the one suggested.
  const added: PacketSuggestion[] = [];
  const reasons: Record<string, string> = {};
  for (const p of picks) {
    if (addForm(p.template.id) !== 'added') continue;
    const item = useApp.getState().packet.items.at(-1);
    reasons[item?.templateId ?? p.template.id] = p.reason;
    added.push(p);
  }
  useApp.getState().setPacket({ reasons });
  return added;
}
