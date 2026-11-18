// Pure tab-lifecycle rules: which tabs get archived, which get unloaded.

export interface LifecycleTab {
  id: string;
  pinned: boolean;
  lastActiveAt: number;
  archivedAt: number | null;
}

/** Unpinned tabs untouched for longer than `archiveAfterMs` leave the tab strip. */
export function tabsToArchive(tabs: LifecycleTab[], now: number, archiveAfterMs: number, keep: ReadonlySet<string> = new Set()): string[] {
  if (archiveAfterMs <= 0) return [];
  return tabs
    .filter((t) => !t.pinned && t.archivedAt === null && !keep.has(t.id) && now - t.lastActiveAt >= archiveAfterMs)
    .map((t) => t.id);
}

export interface LiveView {
  id: string;
  lastUsed: number;
  audible: boolean;
}

/** Background pages idle for longer than `sleepAfterMs` are unloaded; audible ones never are. */
export function viewsToSleep(views: LiveView[], now: number, sleepAfterMs: number, activeId: string | null): string[] {
  if (sleepAfterMs <= 0) return [];
  return views.filter((v) => v.id !== activeId && !v.audible && now - v.lastUsed >= sleepAfterMs).map((v) => v.id);
}

const SEARCH: Record<string, string> = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q=',
};

/** Turns address-bar input into a URL: a real URL, a bare host, or a search. */
export function resolveInput(input: string, engine: string = 'google'): string {
  const s = input.trim();
  if (!s) return '';
  if (/^(https?|file|about|view-source):/i.test(s)) return s;
  const hostLike = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\]|([a-z0-9-]+\.)+[a-z]{2,})(:\d+)?(\/.*)?$/i;
  if (!/\s/.test(s) && hostLike.test(s)) {
    const local = /^(localhost|127\.|10\.|192\.168\.|\[)/i.test(s);
    return `${local ? 'http' : 'https'}://${s}`;
  }
  return (SEARCH[engine] ?? SEARCH.google) + encodeURIComponent(s);
}

/** Order value that places an item between two neighbours. */
export function orderBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 1;
  if (before === undefined) return after! - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}
