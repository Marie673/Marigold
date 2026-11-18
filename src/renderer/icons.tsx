import { useState } from 'preact/hooks';

const P: Record<string, string> = {
  back: 'M15 18l-6-6 6-6',
  forward: 'M9 18l6-6-6-6',
  reload: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  pin: 'M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6zM12 14v7',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16z',
  archive: 'M4 7h16M5 7v12h14V7M9 11h6M3 4h18v3H3z',
  settings: 'M4 7h10M18 7h2M4 17h2M10 17h10M16 4v6M8 14v6',
  search: 'M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM16 16l5 5',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c3 3.5 3 14.500 0 18M12 3c-3 3.5-3 14.500 0 18',
  send: 'M5 12h14M13 6l6 6-6 6',
  square: 'M7 7h10v10H7z',
  sound: 'M4 10v4h4l5 4V6L8 10H4zM17 9a4 4 0 0 1 0 6',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  tab: 'M3 7h7l2 3h9v9H3z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  chevron: 'M6 9l6 6 6-6',
  check: 'M5 12l5 5 9-10',
  sidebar: 'M4 5h16v14H4zM9.500 5v14',
  up: 'M12 19V5M6 11l6-6 6 6',
  compose: 'M12 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6M17.500 3.500l3 3L12 15l-4 1 1-4 8.500-8.500z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.500 20a7.500 7.500 0 0 1 15 0',
  syncs: 'M4 9a8 8 0 0 1 14-3l2 2M20 4v4h-4M20 15a8 8 0 0 1-14 3l-2-2M4 20v-4h4',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M17 14H7',
  moon: 'M20 14.500A8 8 0 0 1 9.500 4a8 8 0 1 0 10.500 10.500z',
  gauge: 'M4 16a8 8 0 1 1 16 0M12 16l4-5',
  memory: 'M6 7h12v10H6zM9 7V4M15 7V4M9 20v-3M15 20v-3M3 10h3M3 14h3M18 10h3M18 14h3',
};

export function Icon({ name, size = 16 }: { name: keyof typeof P | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={P[name]} />
    </svg>
  );
}

export function Favicon({ url, page, size = 16 }: { url: string | null | undefined; page?: string; size?: number }) {
  // The letter tile shows until the real icon has actually loaded, so a slow or missing icon never leaves a hole.
  const [loaded, setLoaded] = useState<string | null>(null);
  let letter = '';
  try {
    letter = new URL(page ?? '').hostname.replace(/^www\./, '')[0]?.toUpperCase() ?? '';
  } catch {}
  const ready = !!url && loaded === url;
  return (
    <span class="favicon-box" style={{ width: size, height: size }}>
      {!ready && (letter ? <span class="favicon letter" style={{ fontSize: size * 0.6 }}>{letter}</span> : <Icon name="globe" size={size} />)}
      {url && <img class="favicon" style={{ opacity: ready ? 1 : 0 }} src={url} width={size} height={size} onLoad={() => setLoaded(url)} />}
    </span>
  );
}

/** The Marigold mark: a ring of petals. */
export function Mark({ size = 44 }: { size?: number }) {
  const petals = Array.from({ length: 12 }, (_, i) => i * 30);
  return (
    <svg class="mark" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      {petals.map((r) => <ellipse cx="24" cy="10.500" rx="4.200" ry="8" transform={`rotate(${r} 24 24)`} fill="var(--accent)" opacity={r % 60 ? 0.55 : 0.95} />)}
      <circle cx="24" cy="24" r="6.500" fill="var(--accent)" />
    </svg>
  );
}
