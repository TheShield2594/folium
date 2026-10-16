import { useState } from 'react';

/**
 * Where the approved Everence brandmark artwork goes. Marketing supplies the SVG; it is
 * never redrawn here (guidelines p.6–11). Drop it in at this path and it appears top-left
 * of the sidebar. Until it's there the slot stays empty rather than showing a stand-in.
 */
export const BRANDMARK_SRC = './brand/everence-brandmark.svg';

export function EverenceBrandmark() {
  const [missing, setMissing] = useState(false);
  if (missing) return null;
  return <img className="brandmark" src={BRANDMARK_SRC} alt="Everence" onError={() => setMissing(true)} />;
}
