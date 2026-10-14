import { useMemo } from 'react';
import { runChecks, type CheckResult } from '../../domain/checks';
import { prefillPacket, type FormFill } from '../../domain/prefill';
import type { FormTemplate, PacketItem } from '../../domain/types';
import { latestLive, packetState, useActingFor, useApp, useScope } from '../../state/store';

export interface PacketView {
  templates: FormTemplate[];
  fills: FormFill[];
  checks: CheckResult[];
  totals: { filled: number; fields: number; missing: number; pages: number };
  /** Forms whose template no longer exists. They can't be shown or filled, only removed. */
  missing: PacketItem[];
}

/** Prefill + checks for the current packet, recomputed as values change. */
export function usePacketView(): PacketView | undefined {
  const scope = useScope();
  const packet = useApp((s) => s.packet);
  const templates = useApp((s) => s.templates);
  const advisor = useActingFor();

  return useMemo(() => {
    if (!scope) return undefined;
    const items = packet.items
      .map((i) => ({ template: templates.find((t) => t.id === i.templateId)!, account: scope.client.accounts.find((a) => a.accountid === i.accountId), itemId: i.id, copy: i.copy }))
      .filter((i) => i.template);
    const missing = packet.items.filter((i) => !templates.some((t) => t.id === i.templateId));
    const fills = prefillPacket(items, scope, packet.values);
    const checks = runChecks(fills, {
      scope,
      values: packet.values,
      latestFor: (n) => latestLive(templates, n),
      state: packetState(packet, scope.client),
      licensedStates: advisor?.licensedStates,
      missingForms: missing.map(missingLabel),
    });
    const relevant = fills.flatMap((f) => f.fields.filter((x) => x.origin !== 'signer'));
    return {
      missing,
      templates: items.map((i) => i.template),
      fills,
      checks,
      totals: {
        filled: relevant.filter((f) => f.value.trim()).length,
        fields: relevant.length,
        missing: fills.reduce((n, f) => n + f.missingCount, 0),
        pages: items.reduce((n, i) => n + i.template.pageCount, 0),
      },
    };
  }, [scope, packet, templates, advisor]);
}

/** How Review names a form whose template is gone. */
export const missingLabel = (i: PacketItem) => (i.missing ? `${i.missing.name} (${i.missing.formNumber} Rev ${i.missing.revision})` : 'A form that was removed from the library');
