import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { applyEnvelopeStatus, signingEventMessage, signingReturnUrl, withSigningEvent } from '../../domain/requests';
import { roleLabel } from '../../domain/signers';
import type { SignatureRequest } from '../../domain/types';
import { useServices } from '../../services';
import { audit } from '../../state/actions';
import { trackStatus, useApp } from '../../state/store';
import { Button, Spinner, toast } from '../../ui/controls';
import { Icon } from '../../ui/Icon';

/** Query parameters from the URL and from the hash route (`#/route?x=1`). */
function routeParams(): URLSearchParams {
  const p = new URLSearchParams(location.search);
  const hashQuery = location.hash.split('?').slice(1).join('&');
  if (hashQuery) new URLSearchParams(hashQuery).forEach((v, k) => p.set(k, v));
  return p;
}

/**
 * "Sign now" for each in-session signer who hasn't signed. Every click asks DocuSign for
 * a fresh link (they're short-lived and single-use) and opens it in a new tab: DocuSign's
 * page shouldn't be framed inside the Power Apps host.
 */
export function SignNowButtons({ req }: { req: SignatureRequest }) {
  const services = useServices();
  const [busy, setBusy] = useState<string>();
  const waiting = req.signers.filter((s) => s.inSession && s.status !== 'signed' && s.status !== 'declined');
  if (!req.envelopeId || !(req.status === 'Sent' || req.status === 'Viewed') || !waiting.length) return null;

  async function open(role: string) {
    // Open the tab inside the click, so popup blockers allow it, then point it at DocuSign.
    const tab = window.open('about:blank', '_blank');
    setBusy(role);
    try {
      const url = await services.signing.signingUrl(req.envelopeId!, role, signingReturnUrl(location.href, req.envelopeId!, role));
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else window.location.href = url;
    } catch (e) {
      tab?.close();
      toast.error(e instanceof Error ? e.message : 'DocuSign didn’t open the signing page');
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="req-action">
      <span className="grow t-callout" style={{ minWidth: 220 }}>
        <Icon name="signature" size={16} className="c-accent" /> Signing in session: hand over your screen when DocuSign opens.
      </span>
      {waiting.map((s) => (
        <Button key={s.role} variant="filled" icon="signature" busy={busy === s.role} onClick={() => open(s.role)}>
          Sign now: {s.name || roleLabel(s.role)}
        </Button>
      ))}
    </div>
  );
}

/**
 * Where DocuSign sends an in-session signer back to. Reads `event`, checks status, adds
 * an audit entry naming the advisor who was present, and goes to Signature requests.
 */
export function SigningReturn() {
  const services = useServices();
  const navigate = useNavigate();
  const me = useApp((s) => s.me);
  const refreshRequests = useApp((s) => s.refreshRequests);
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current || !me) return;
    handled.current = true;
    const p = routeParams();
    const envelopeId = p.get('envelope') ?? '';
    const role = p.get('role') ?? '';
    const event = p.get('event') ?? undefined;
    (async () => {
      try {
        const r = (await services.requests.listMine()).find((x) => x.envelopeId === envelopeId);
        if (!r) throw new Error('Folium couldn’t find the request for that envelope.');
        const signer = r.signers.find((s) => s.role === role);
        const msg = signingEventMessage(event, signer?.name ?? roleLabel(role));
        const { next } = applyEnvelopeStatus(r, await services.signing.getStatus(envelopeId));
        await services.requests.save({ ...next, audit: [...next.audit, audit(me, msg.audit, `${signer?.name ?? roleLabel(role)}, with ${me.fullname} present`)] });
        trackStatus(r, next);
        await refreshRequests();
        if (msg.done) toast.ok(msg.text);
        else toast.error(msg.text);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Couldn’t update the request after signing');
      }
      navigate('/requests', { replace: true });
    })();
  }, [me, services, navigate, refreshRequests]);

  return (
    <div className="row" style={{ justifyContent: 'center', padding: 60 }}>
      <Spinner />
      <span className="t-callout c2">Checking with DocuSign…</span>
    </div>
  );
}

/** Demo mode's stand-in for DocuSign's signing page. */
export function DemoSigning() {
  const p = routeParams();
  const envelopeId = p.get('envelope') ?? '';
  const role = p.get('role') ?? '';
  const back = p.get('return') ?? '';
  const [busy, setBusy] = useState(false);

  async function finish(event: 'signing_complete' | 'cancel') {
    setBusy(true);
    if (event === 'signing_complete') (await import('../../services/demo')).demoSignInSession(envelopeId, role);
    window.location.href = withSigningEvent(back, event);
  }

  return (
    <div className="scroll" style={{ display: 'grid', placeItems: 'center', minHeight: '100%' }}>
      <section className="card card-pad stack-4" style={{ maxWidth: 460, margin: 16 }}>
        <span className="badge badge-info">DocuSign (demo)</span>
        <h1 className="t-title2">Review and sign</h1>
        <p className="t-callout c2">
          In Folium’s demo this page stands in for DocuSign’s signing ceremony for the {roleLabel(role).toLowerCase()}. In production DocuSign shows the forms with their signature tabs here.
        </p>
        <div className="row wrap">
          <Button variant="filled" icon="signature" busy={busy} onClick={() => finish('signing_complete')}>
            Finish
          </Button>
          <Button variant="gray" disabled={busy} onClick={() => finish('cancel')}>
            Finish later
          </Button>
        </div>
      </section>
    </div>
  );
}
