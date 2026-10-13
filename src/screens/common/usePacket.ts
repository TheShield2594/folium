import { useMemo } from 'react';
import { runChecks, type CheckResult } from '../../domain/checks';
import { prefillPacket, type FormFill } from '../../domain/prefill';
import type { FormTemplate } from '../../domain/types';
import { latestLive, useApp, useScope } from '../../state/store';

export interface PacketView {
  templates: FormTemplate[];
  fills: FormFill[];
  checks: CheckResult[];
  totals: { filled: number; fields: number; missing: number; pages: number };
}

/** Prefill + checks for the current packet, recomputed as values change. */
export function usePacketView(): PacketView | undefined {
  const scope = useScope();
  const packet = useApp((s) => s.packet);
  const templates = useApp((s) => s.templates);

  return useMemo(() => {
    if (!scope) return undefined;
    const items = packet.items
      .map((i) => ({ template: templates.find((t) => t.id === i.templateId)!, account: scope.client.accounts.find((a) => a.accountid === i.accountId) }))
      .filter((i) => i.template);
    const fills = prefillPacket(items, scope, packet.values);
    const checks = runChecks(fills, { scope, values: packet.values, latestFor: (n) => latestLive(templates, n) });
    const relevant = fills.flatMap((f) => f.fields.filter((x) => x.origin !== 'signer'));
    return {
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
  }, [scope, packet, templates]);
}
