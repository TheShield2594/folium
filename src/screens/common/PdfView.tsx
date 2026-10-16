import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { FieldState } from '../../domain/prefill';
import type { FieldRect, FormTemplate, Placement } from '../../domain/types';
import { inspectPdf, type PdfInspection } from '../../pdf/inspect';
import { loadPdf, renderPage } from '../../pdf/render';
import { roleLabel } from '../../domain/signers';
import { maskValue } from '../../domain/format';
import { useServices } from '../../services';

const inspections = new Map<string, Promise<PdfInspection>>();

export function useInspection(template: FormTemplate | undefined) {
  const services = useServices();
  const [info, setInfo] = useState<PdfInspection>();
  useEffect(() => {
    if (!template) return;
    let live = true;
    if (!inspections.has(template.id)) {
      const p = services.templates.getPdf(template).then(inspectPdf);
      // Don't cache a failure: the next mount should try again.
      p.catch(() => inspections.delete(template.id));
      inspections.set(template.id, p);
    }
    inspections
      .get(template.id)!
      .then((i) => live && setInfo(i))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [template, services]);
  return info;
}

type PageSize = { w: number; h: number; scale: number };

function PageCanvas({ template, page, width, onSize }: { template: FormTemplate; page: number; width: number; onSize: (page: number, s: PageSize) => void }) {
  const services = useServices();
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let live = true;
    loadPdf(template.id, () => services.templates.getPdf(template))
      .then((doc) => (live && ref.current ? renderPage(doc, page, ref.current, width) : undefined))
      .then((r) => r && live && onSize(page, { w: r.width, h: r.height, scale: r.scale }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [template, page, width, services, onSize]);
  return <canvas ref={ref} style={{ display: 'block' }} aria-hidden="true" />;
}

export interface PdfViewProps {
  template: FormTemplate;
  fields?: FieldState[];
  placements?: Placement[];
  width?: number;
  activeKey?: string;
  onFieldClick?: (f: FieldState) => void;
  /** Which fields `onFieldClick` acts on (default: every unlocked field). The rest are read as text. */
  canActivate?: (f: FieldState) => boolean;
  /** Ids of elements that describe a field (its check results), for screen readers. */
  describedBy?: (f: FieldState) => string | undefined;
  /** Placement editing: called with page coords when the page is clicked. */
  onPageClick?: (page: number, x: number, y: number) => void;
  onPlacementClick?: (index: number) => void;
  selectedPlacement?: number;
  showValues?: boolean;
  maskSensitive?: boolean;
  /** Only render the first N pages (thumbnails / quick look). */
  maxPages?: number;
  pageLabel?: (page: number) => ReactNode;
}

/**
 * Renders a template's pages with Folium's highlight layer on top: green for values
 * from CRM, amber for what still needs input, blue for edits, and signature tabs.
 * Values are drawn as an overlay so typing feels instant; the real fill happens with
 * pdf-lib when the advisor downloads or sends.
 */
export function PdfView({ template, fields = [], placements = [], width = 640, activeKey, onFieldClick, canActivate, describedBy, onPageClick, onPlacementClick, selectedPlacement, showValues = true, maskSensitive = true, maxPages, pageLabel }: PdfViewProps) {
  const info = useInspection(template);
  const [sizes, setSizes] = useState<Record<number, PageSize>>({});
  // Stable across renders, so each page's render effect only re-runs when it needs to.
  const onSize = useCallback((page: number, v: PageSize) => setSizes((p) => (p[page]?.scale === v.scale ? p : { ...p, [page]: v })), []);
  const pages = Math.min(info?.pageCount ?? template.pageCount, maxPages ?? Infinity);
  const total = info?.pageCount ?? template.pageCount;

  const rectsFor = (f: FieldState): FieldRect[] => {
    if (f.mapping.rect) return [f.mapping.rect];
    return info?.fields.find((x) => x.name === f.mapping.pdfField)?.rects ?? [];
  };

  return (
    <div className="stack-4" style={{ alignItems: 'center' }}>
      {Array.from({ length: pages }, (_, i) => i + 1).map((page) => {
        const sz = sizes[page];
        const s = sz?.scale ?? width / 612;
        return (
          <div key={page} className="stack" style={{ alignItems: 'center' }} role="group" aria-label={`Page ${page} of ${total}`}>
            <div
              className="pdf-page"
              style={{ width, minHeight: sz ? undefined : width * (792 / 612), cursor: onPageClick ? 'crosshair' : undefined }}
              onClick={(e) => {
                if (!onPageClick) return;
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                onPageClick(page, (e.clientX - r.left) / s, (e.clientY - r.top) / s);
              }}
            >
              <PageCanvas template={template} page={page} width={width} onSize={onSize} />
              <div className="pdf-overlay">
                {fields
                  .flatMap((f) => rectsFor(f).flatMap((r, j) => (r.page === page ? [{ f, r, j }] : [])))
                  // Tab and reading order follow the page (top to bottom, then left to right), not the mapping's order.
                  .sort((a, b) => a.r.y - b.r.y || a.r.x - b.r.x)
                  .map(({ f, r, j }) => {
                    const tone = f.locked ? 'locked' : f.origin === 'signer' ? 'signer' : f.missing || f.formatError ? 'need' : f.origin === 'edited' || f.origin === 'advisor' ? 'edit' : f.value ? 'crm' : 'empty';
                    const isCheck = f.mapping.format === 'checkbox' || !!f.mapping.checkedWhen;
                    const shown = f.origin === 'signer' ? '' : maskSensitive ? maskValue(f.display, f.mapping.format) : f.display;
                    const text = showValues && !f.locked ? (isCheck ? (/^(true|yes|y|x|on|1|checked)$/i.test(f.display) ? '✕' : '') : shown) : '';
                    const spoken = `${f.label}: ${spokenState(f, isCheck ? (text ? 'checked' : 'not checked') : shown)}`;
                    const cls = `hl hl-${tone}${activeKey === f.key ? ' active' : ''}`;
                    const style = { left: r.x * s, top: r.y * s, width: Math.max(r.width * s, 10), height: Math.max(r.height * s, 10), fontSize: Math.max(8, Math.min(11, r.height * s * 0.62)) };
                    const key = `${f.mapping.pdfField}-${j}`;
                    const title = f.locked ? `${f.label} · Locked ${f.lockReason ?? ''}`.trim() : `${f.label} · ${f.sourceLabel}`;
                    if (!onFieldClick || f.locked || (canActivate && !canActivate(f))) {
                      // Nothing to do here: read as text in the page, not as a button that does nothing.
                      return (
                        <span key={key} data-key={f.key} className={cls} style={style} title={title}>
                          <span className="sr-only">{spoken}</span>
                          <span aria-hidden="true">{text}</span>
                        </span>
                      );
                    }
                    return (
                      <button
                        key={key}
                        type="button"
                        data-key={f.key}
                        className={cls}
                        style={style}
                        onClick={(e) => {
                          e.stopPropagation();
                          onFieldClick(f);
                        }}
                        aria-label={spoken}
                        aria-describedby={describedBy?.(f)}
                        aria-current={activeKey === f.key || undefined}
                        title={title}
                      >
                        <span aria-hidden="true">{text}</span>
                      </button>
                    );
                  })}
                {placements
                  .map((p, i) => ({ p, i }))
                  .filter(({ p }) => p.page === page)
                  .sort((a, b) => a.p.y - b.p.y || a.p.x - b.p.x)
                  .map(({ p, i }) => {
                    const label = `${p.type === 'signature' ? 'Sign here' : p.type === 'dateSigned' ? 'Date signed' : p.type} · ${roleLabel(p.role)}`;
                    const body = (
                      <>
                        <span aria-hidden={!onPlacementClick || undefined}>{p.type === 'signature' ? 'Sign' : p.type === 'dateSigned' ? 'Date' : p.type === 'initials' ? 'Initial' : p.type}</span>
                        <em aria-hidden={!onPlacementClick || undefined}>{roleLabel(p.role)}</em>
                      </>
                    );
                    const cls = `tab tab-${p.type}${selectedPlacement === i ? ' active' : ''}`;
                    if (!onPlacementClick) {
                      return (
                        <span key={`pl-${i}`} className={cls} style={{ left: p.x * s, top: p.y * s }}>
                          <span className="sr-only">{label}</span>
                          {body}
                        </span>
                      );
                    }
                    return (
                      <button
                        key={`pl-${i}`}
                        type="button"
                        className={cls}
                        style={{ left: p.x * s, top: p.y * s }}
                        onClick={(e) => {
                          e.stopPropagation();
                          onPlacementClick(i);
                        }}
                        aria-label={label}
                        aria-pressed={selectedPlacement === i}
                      >
                        {body}
                      </button>
                    );
                  })}
              </div>
            </div>
            {pageLabel?.(page)}
          </div>
        );
      })}
    </div>
  );
}

/** What a screen reader hears after a field's label: its value and whether it still needs something. */
function spokenState(f: FieldState, shown: string): string {
  if (f.locked) return `locked${f.lockReason ? ` ${f.lockReason}` : ''}, prints blank`;
  if (f.origin === 'signer') return 'to be completed by the signer';
  const value = f.value ? shown || 'filled' : 'empty';
  const notes = [f.formatError ? `invalid: ${f.formatError}` : f.missing ? 'needs input' : '', f.value ? (f.origin === 'edited' || f.origin === 'advisor' ? 'entered on this form' : f.sourceLabel) : ''].filter(Boolean);
  return [value, ...notes].join(', ');
}
