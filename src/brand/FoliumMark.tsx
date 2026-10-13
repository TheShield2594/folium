// The Folium mark: a single leaf split into Everence's two greens, with a vine
// tendril for a stem — a leaf from the Everence vine.

const LIME = '#B5BF00';
const GREEN = '#719500';

export const LEAF_PATHS = {
  upper: 'M20 44 C 14 26, 28 10, 56 8 C 44 18, 32 30, 20 44 Z',
  lower: 'M23 47 C 42 52, 58 36, 57 11 C 47 25, 36 37, 23 47 Z',
  tendril: 'M21.5 45.5 C 17 50, 11 51.5, 10.4 47.2 C 9.9 43.6, 15.2 43.4, 15.8 47.6 C 16.4 52, 12.6 55.4, 8.8 56.2',
};

export function FoliumMark({ size = 28, title = 'Folium', mono }: { size?: number; title?: string; mono?: string }) {
  return (
    <svg width={size} height={size} viewBox="4 4 56 56" role="img" aria-label={title}>
      <path d={LEAF_PATHS.upper} fill={mono ?? LIME} />
      <path d={LEAF_PATHS.lower} fill={mono ?? GREEN} />
      <path d={LEAF_PATHS.tendril} fill="none" stroke={mono ?? GREEN} strokeWidth={3.4} strokeLinecap="round" />
    </svg>
  );
}

/** App icon: the mark on Apple's rounded-square tile. */
export function FoliumAppIcon({ size = 64 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="folium-tile" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#EAEDD3" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14.5" fill="url(#folium-tile)" />
      <g transform="translate(6 5) scale(0.82)">
        <path d={LEAF_PATHS.upper} fill={LIME} />
        <path d={LEAF_PATHS.lower} fill={GREEN} />
        <path d={LEAF_PATHS.tendril} fill="none" stroke={GREEN} strokeWidth={3.4} strokeLinecap="round" />
      </g>
    </svg>
  );
}
