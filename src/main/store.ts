// Persistent state. Synced entities (profiles, tabs, settings) are kept as
// sync records so local edits and remote changes share one code path.
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { isNewer, type Collection, type ProfileData, type SettingsData, type SyncRecord, type TabData } from '../../sync/core/protocol.ts';
import type { LocalSettings } from '../shared/types.ts';

export interface LocalConfig extends LocalSettings {
  deviceId: string;
  currentProfileId: string;
  activeTabByProfile: Record<string, string | null>;
  sync: { server: string; account: string; key?: string; keyEnc?: string } | null;
  syncSeq: number;
  windowBounds: { x?: number; y?: number; width: number; height: number } | null;
}

export interface HistoryEntry {
  url: string;
  title: string;
  profileId: string;
  visits: number;
  last: number;
}

const EPHEMERAL: ReadonlySet<string> = new Set(['aireq', 'aires']);
const HISTORY_MAX = 4000;

export const newId = (n = 16) => randomBytes(n).toString('base64url').replace(/[-_]/g, 'x').slice(0, n).toLowerCase();

export const DEFAULT_SETTINGS: SettingsData = { archiveAfterMs: 24 * 3600_000, searchEngine: 'google' };

export class Store extends EventEmitter {
  readonly records = new Map<string, SyncRecord>();
  readonly dirty = new Set<string>();
  readonly expires = new Map<string, number>();
  history: HistoryEntry[] = [];
  local: LocalConfig;
  private readonly dir: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private historyDirty = false;

  constructor(dir: string) {
    super();
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.local = {
      deviceId: `dev_${newId(12)}`,
      deviceName: hostname() || 'Desktop',
      currentProfileId: '',
      activeTabByProfile: {},
      sync: null,
      syncSeq: 0,
      windowBounds: null,
      sleepAfterMs: 30 * 60_000,
      aiProvider: 'claude',
      aiModels: {},
      aiPanelOpen: false,
      cliPaths: {},
    };
    const state = this.read('state.json');
    if (state) {
      Object.assign(this.local, state.local);
      for (const r of state.records as SyncRecord[]) this.records.set(r.id, r);
      for (const id of state.dirty as string[]) this.dirty.add(id);
    }
    this.history = this.read('history.json') ?? [];
    if (!this.list<ProfileData>('profile').length) {
      const id = newId();
      this.put<ProfileData>('profile', id, { name: 'Personal', color: '#f59e0b', icon: '🌼', order: 1 });
      this.local.currentProfileId = id;
    }
    if (!this.get<ProfileData>(`profile:${this.local.currentProfileId}`)) {
      this.local.currentProfileId = this.list<ProfileData>('profile')[0].key;
    }
  }

  private read(name: string): any {
    const file = join(this.dir, name);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      // Keep the unreadable file for recovery instead of silently overwriting it.
      try {
        renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {}
      console.error(`could not read ${name}:`, e);
      return null;
    }
  }

  private write(name: string, data: unknown) {
    const file = join(this.dir, name);
    writeFileSync(`${file}.tmp`, JSON.stringify(data));
    renameSync(`${file}.tmp`, file);
  }

  scheduleSave() {
    this.saveTimer ??= setTimeout(() => this.flush(), 800);
  }

  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      this.write('state.json', {
        local: this.local,
        records: [...this.records.values()].filter((r) => !EPHEMERAL.has(r.collection)),
        dirty: [...this.dirty].filter((id) => !EPHEMERAL.has(id.split(':')[0])),
      });
      if (this.historyDirty) {
        this.write('history.json', this.history);
        this.historyDirty = false;
      }
    } catch (e) {
      console.error('could not save state:', e);
    }
  }

  /** Live (non-deleted) records of a collection. */
  list<T>(collection: Collection): { key: string; data: T; updatedAt: number }[] {
    const out: { key: string; data: T; updatedAt: number }[] = [];
    const prefix = `${collection}:`;
    for (const r of this.records.values()) {
      if (!r.deleted && r.id.startsWith(prefix)) out.push({ key: r.id.slice(prefix.length), data: r.data as T, updatedAt: r.updatedAt });
    }
    return out;
  }

  get<T>(id: string): T | null {
    const r = this.records.get(id);
    return r && !r.deleted ? (r.data as T) : null;
  }

  put<T>(collection: Collection, key: string, data: T, opts: { deleted?: boolean; expiresAt?: number } = {}) {
    const id = `${collection}:${key}`;
    const prev = this.records.get(id);
    // Never go backwards in time relative to the record we replace (clock skew between devices).
    const updatedAt = Math.max(Date.now(), (prev?.updatedAt ?? 0) + 1);
    this.records.set(id, { v: 1, id, collection, updatedAt, deviceId: this.local.deviceId, deleted: opts.deleted ?? false, data });
    this.dirty.add(id);
    if (opts.expiresAt) this.expires.set(id, opts.expiresAt);
    this.scheduleSave();
    this.emit('change', id, 'local');
  }

  patch<T extends object>(id: string, partial: Partial<T>) {
    const cur = this.get<T>(id);
    if (!cur) return;
    const changed = (Object.keys(partial) as (keyof T)[]).some((k) => cur[k] !== partial[k]);
    if (!changed) return;
    const [collection, ...rest] = id.split(':');
    this.put(collection as Collection, rest.join(':'), { ...cur, ...partial });
  }

  remove(id: string) {
    const r = this.records.get(id);
    if (!r || r.deleted) return;
    const [collection, ...rest] = id.split(':');
    this.put(collection as Collection, rest.join(':'), r.data, { deleted: true });
  }

  /** Merges a record pulled from the sync server. Returns true if it was applied. */
  applyRemote(rec: SyncRecord): boolean {
    if (!isNewer(rec, this.records.get(rec.id))) return false;
    this.records.set(rec.id, rec);
    this.dirty.delete(rec.id);
    this.scheduleSave();
    this.emit('change', rec.id, 'remote');
    return true;
  }

  markAllDirty() {
    for (const r of this.records.values()) if (!EPHEMERAL.has(r.collection)) this.dirty.add(r.id);
    this.scheduleSave();
  }

  settings(): SettingsData {
    return { ...DEFAULT_SETTINGS, ...(this.get<SettingsData>('settings:global') ?? {}) };
  }

  tab(id: string): TabData | null {
    return this.get<TabData>(`tab:${id}`);
  }

  setLocal(partial: Partial<LocalConfig>) {
    Object.assign(this.local, partial);
    this.scheduleSave();
    this.emit('change', 'local', 'local');
  }

  addHistory(url: string, title: string, profileId: string) {
    if (!/^https?:/.test(url)) return;
    const i = this.history.findIndex((h) => h.url === url && h.profileId === profileId);
    const entry = i >= 0 ? this.history.splice(i, 1)[0] : { url, title, profileId, visits: 0, last: 0 };
    entry.visits += 1;
    entry.last = Date.now();
    if (title) entry.title = title;
    this.history.unshift(entry);
    if (this.history.length > HISTORY_MAX) this.history.length = HISTORY_MAX;
    this.historyDirty = true;
    this.scheduleSave();
  }

  setHistoryTitle(url: string, title: string, profileId: string) {
    const h = this.history.find((x) => x.url === url && x.profileId === profileId);
    if (h && title && h.title !== title) {
      h.title = title;
      this.historyDirty = true;
      this.scheduleSave();
    }
  }

  clearHistory(profileId: string) {
    this.history = this.history.filter((h) => h.profileId !== profileId);
    this.historyDirty = true;
    this.scheduleSave();
  }
}
