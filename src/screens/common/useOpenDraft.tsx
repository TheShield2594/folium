import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { draftFreshness, upgradeAuditDetail, upgradeDraft } from '../../domain/drafts';
import type { SignatureRequest } from '../../domain/types';
import { useApp } from '../../state/store';
import { toast } from '../../ui/controls';
import { UpgradeSheet } from './UpgradeSheet';

/**
 * Open a draft (or a request's forms again) in Review. When a form in it has a newer
 * revision, ask first: update to the current forms (the default) or open as is, which
 * keeps today's behaviour and leaves the send check blocking.
 */
export function useOpenDraft() {
  const navigate = useNavigate();
  const [sheet, setSheet] = useState<ReactNode>();
  const close = () => setSheet(undefined);

  async function load(r: SignatureRequest, asNew: boolean, upgrade: boolean) {
    const app = useApp.getState();
    try {
      // Opening a draft replaces the packet on screen: ask first if it has unsaved work.
      if (!(await app.confirmReplacePacket('open-draft'))) return;
      if (r.contactId !== useApp.getState().contactId && !(await app.openContact(r.contactId))) return;
      let req: SignatureRequest = asNew ? { ...r, id: '' } : r;
      let detail = '';
      if (upgrade) {
        const u = upgradeDraft(req, useApp.getState().templates);
        req = { ...req, documents: u.documents, values: u.values };
        detail = upgradeAuditDetail(u.report);
      }
      useApp.getState().loadRequest(req);
      if (asNew) useApp.getState().setPacket({ requestId: undefined, sharedWith: [], snapshot: undefined });
      // The upgrade is unsaved work, recorded in the audit trail at the next save.
      if (detail) useApp.getState().setPacket({ formsUpdated: detail, dirty: true });
      navigate('/review');
    } catch {
      toast.error('That client isn’t available to you.');
    }
  }

  function open(r: SignatureRequest, asNew = false) {
    const templates = useApp.getState().templates;
    if (draftFreshness(r, templates).state === 'current') return void load(r, asNew, false);
    const { report } = upgradeDraft(r, templates);
    setSheet(<UpgradeSheet report={report} onUpdate={() => (close(), void load(r, asNew, true))} onOpenAsIs={() => (close(), void load(r, asNew, false))} onClose={close} />);
  }

  return { open, sheet };
}
