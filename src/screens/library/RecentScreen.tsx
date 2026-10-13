import { useNavigate } from 'react-router-dom';
import type { FormTemplate } from '../../domain/types';
import { Toolbar } from '../../shell/Shell';
import { latestLive, useApp } from '../../state/store';
import { Badge, Button, Empty, IconButton } from '../../ui/controls';
import { Icon } from '../../ui/Icon';
import { fmtDay } from '../requests/RequestCard';

/** One form, with favorite and add-to-packet controls. Module scope so React keeps rows (and focus) across renders. */
function Row({ t, detail }: { t: FormTemplate; detail?: string }) {
  const inPacket = useApp((s) => s.packet.items.some((i) => i.templateId === t.id));
  const fav = useApp((s) => s.favorites.includes(t.id));
  const client = useApp((s) => s.client);
  const addToPacket = useApp((s) => s.addToPacket);
  const removeFromPacket = useApp((s) => s.removeFromPacket);
  const toggleFavorite = useApp((s) => s.toggleFavorite);
  return (
    <div className="list-row">
      <Icon name="doc" size={20} className="c3" />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="t-headline">{t.name}</div>
        <div className="t-footnote c3">
          <span className="mono">{t.formNumber}</span> · {t.issuer ?? t.source} · Rev {t.revision}
          {detail ? ` · ${detail}` : ''}
        </div>
      </div>
      {t.status !== 'Live' && <Badge tone="warn">{t.status}</Badge>}
      <IconButton icon={fav ? 'starFill' : 'star'} label={fav ? 'Remove from favorites' : 'Add to favorites'} className={fav ? 'fav on' : 'fav'} onClick={() => toggleFavorite(t.id)} />
      <Button variant={inPacket ? 'tinted' : 'gray'} size="sm" icon={inPacket ? 'check' : 'plus'} disabled={!client} onClick={() => (inPacket ? removeFromPacket(t.id) : addToPacket(t.id))}>
        {inPacket ? 'Added' : 'Add'}
      </Button>
    </div>
  );
}

/** Recently used and favorite forms, one click from the packet. */
export function RecentScreen() {
  const templates = useApp((s) => s.templates);
  const recent = useApp((s) => s.recent);
  const favorites = useApp((s) => s.favorites);
  const packet = useApp((s) => s.packet);
  const navigate = useNavigate();

  // A favorite or recent may point at an old revision; always show the current one.
  const current = (id: string) => {
    const t = templates.find((x) => x.id === id);
    return t ? latestLive(templates, t.formNumber) ?? t : undefined;
  };
  const favs = favorites.map(current).filter((t): t is FormTemplate => !!t);
  const recents = recent.map((r) => ({ t: current(r.templateId), at: r.at })).filter((r): r is { t: FormTemplate; at: string } => !!r.t);

  return (
    <>
      <Toolbar title="Recent & favorites">
        {packet.items.length > 0 && (
          <Button variant="filled" icon="wand" onClick={() => navigate('/review')}>
            Review {packet.items.length}
          </Button>
        )}
      </Toolbar>
      <div className="scroll">
        <div className="page page-narrow stack-5">
          <h1 className="t-large">Recent & favorites</h1>
          <section className="stack">
            <h2 className="section-title">Favorites</h2>
            {favs.length ? (
              <div className="list form-fav">{favs.map((t) => <Row key={t.id} t={t} />)}</div>
            ) : (
              <Empty icon="star" title="No favorites yet">Star forms in Find forms to keep them here.</Empty>
            )}
          </section>
          <section className="stack">
            <h2 className="section-title">Recently used</h2>
            {recents.length ? (
              <div className="list">{recents.map((r) => <Row key={r.t.id} t={r.t} detail={`used ${fmtDay(r.at)}`} />)}</div>
            ) : (
              <Empty icon="clock" title="Nothing yet">Forms you download or send show up here.</Empty>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
