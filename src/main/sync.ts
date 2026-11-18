// Sync client: pushes dirty records, pulls remote ones, listens for changes.
import { net, safeStorage } from 'electron';
import {
  decryptRecord, deriveKeys, encryptRecord, generateCredentials, pairingLink, parsePairingLink,
  type DerivedKeys, type DeviceData, type ProfileData, type SyncCredentials, type TabData, type WireRecord,
} from '../../sync/core/protocol.ts';
import type { SyncStatus } from '../shared/types.ts';
import type { Store } from './store.ts';

export class SyncClient {
  private keys: DerivedKeys | null = null;
  private creds: SyncCredentials | null = null;
  private state: SyncStatus['state'] = 'off';
  private error: string | null = null;
  private lastSyncAt: number | null = null;
  private pushTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private stream: AbortController | null = null;
  private busy: Promise<void> = Promise.resolve();
  private generation = 0;
  private readonly store: Store;
  private readonly onChange: () => void;
  /** Reported in this device's `device` record. */
  aiProviders: () => { id: string; label: string }[] = () => [];

  constructor(store: Store, onChange: () => void) {
    this.store = store;
    this.onChange = onChange;
    store.on('change', (_id: string, origin: string) => {
      if (origin === 'local' && _id !== 'local' && this.creds) this.schedulePush();
    });
  }

  status(): SyncStatus {
    const devices = this.creds
      ? this.store.list<DeviceData>('device').map((d) => ({ id: d.key, name: d.data.name, platform: d.data.platform, lastSeenAt: d.data.lastSeenAt, self: d.key === this.store.local.deviceId }))
      : [];
    return { state: this.state, server: this.creds?.server ?? null, error: this.error, lastSyncAt: this.lastSyncAt, devices };
  }

  private loadCreds(): SyncCredentials | null {
    const s = this.store.local.sync;
    if (!s) return null;
    try {
      const key = s.keyEnc ? safeStorage.decryptString(Buffer.from(s.keyEnc, 'base64')) : s.key;
      return key ? { server: s.server, account: s.account, key } : null;
    } catch {
      return null;
    }
  }

  private saveCreds(c: SyncCredentials) {
    const enc = safeStorage.isEncryptionAvailable();
    this.store.setLocal({
      sync: { server: c.server, account: c.account, ...(enc ? { keyEnc: safeStorage.encryptString(c.key).toString('base64') } : { key: c.key }) },
      syncSeq: 0,
    });
  }

  /** Starts sync if this device is paired. */
  start() {
    this.creds = this.loadCreds();
    if (!this.creds) {
      if (this.store.local.sync) this.setState('error', 'Could not unlock the sync key. Pair this device again.');
      return;
    }
    this.keys = deriveKeys(this.creds);
    const gen = ++this.generation;
    this.setState('connecting');
    this.publishDevice();
    this.enqueue(() => this.cycle());
    this.pollTimer = setInterval(() => this.enqueue(() => this.cycle()), 45_000);
    void this.listen(gen);
  }

  stop() {
    this.generation++;
    this.stream?.abort();
    this.stream = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pollTimer = this.pushTimer = null;
    this.creds = this.keys = null;
    this.setState('off');
  }

  /** Creates a new sync account on `server` and uploads everything. */
  async create(server: string): Promise<string> {
    const c = generateCredentials(server);
    await this.probe(c.server);
    this.stop();
    this.saveCreds(c);
    this.store.markAllDirty();
    this.start();
    return pairingLink(c);
  }

  /** Joins an account created on another device. */
  async join(link: string) {
    const c = parsePairingLink(link);
    await this.probe(c.server);
    this.stop();
    const pristine = this.pristineProfile();
    this.saveCreds(c);
    this.store.markAllDirty();
    this.start();
    await this.busy;
    // A fresh install has one empty default profile; drop it in favour of the synced ones.
    if (pristine) {
      const others = this.store.list<ProfileData>('profile').filter((p) => p.key !== pristine).sort((a, b) => a.data.order - b.data.order);
      if (others.length) {
        this.store.remove(`profile:${pristine}`);
        if (this.store.local.currentProfileId === pristine) this.store.setLocal({ currentProfileId: others[0].key });
        this.onChange();
      }
    }
  }

  disconnect() {
    this.stop();
    this.store.setLocal({ sync: null, syncSeq: 0 });
    this.onChange();
  }

  link(): string | null {
    const c = this.loadCreds();
    return c ? pairingLink(c) : null;
  }

  publishDevice() {
    if (!this.creds) return;
    this.store.put<DeviceData>('device', this.store.local.deviceId, {
      name: this.store.local.deviceName, platform: 'desktop', aiProviders: this.aiProviders(), lastSeenAt: Date.now(),
    });
  }

  private pristineProfile(): string | null {
    const profiles = this.store.list<ProfileData>('profile');
    if (profiles.length !== 1) return null;
    const hasTabs = this.store.list<TabData>('tab').some((t) => t.data.profileId === profiles[0].key);
    return hasTabs ? null : profiles[0].key;
  }

  private async probe(server: string) {
    const res = await net.fetch(`${server}/v1/health`).catch(() => null);
    const body = res?.ok ? await res.json().catch(() => null) : null;
    if (body?.service !== 'marigold-sync') throw new Error(`No Marigold sync server answered at ${server}`);
  }

  private setState(state: SyncStatus['state'], error: string | null = null) {
    if (this.state === state && this.error === error) return;
    this.state = state;
    this.error = error;
    this.onChange();
  }

  private schedulePush() {
    this.pushTimer ??= setTimeout(() => {
      this.pushTimer = null;
      this.enqueue(() => this.push());
    }, 1200);
  }

  /** Serialises network work so pushes and pulls never interleave. */
  private enqueue(job: () => Promise<void>) {
    const gen = this.generation;
    this.busy = this.busy.then(async () => {
      if (gen !== this.generation) return;
      try {
        await job();
        this.lastSyncAt = Date.now();
        this.setState('ok');
        this.onChange();
      } catch (e) {
        if (gen === this.generation) this.setState('error', e instanceof Error ? e.message : String(e));
      }
    });
  }

  private async cycle() {
    await this.pull();
    await this.push();
  }

  private async request(path: string, init?: RequestInit): Promise<any> {
    const c = this.creds!;
    const res = await net.fetch(`${c.server}/v1/accounts/${c.account}/${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.keys!.authToken}`, 'content-type': 'application/json' },
    });
    if (res.status === 401) throw new Error('The sync server rejected this device (wrong key).');
    if (!res.ok) throw new Error(`Sync server error ${res.status}`);
    return res.json();
  }

  private async pull() {
    let more = true;
    while (more && this.creds) {
      const r = await this.request(`records?since=${this.store.local.syncSeq}&limit=500`);
      let touchedTabs = false;
      for (const w of r.records as WireRecord[]) {
        try {
          const rec = decryptRecord(w, this.keys!.encKey);
          if (this.store.applyRemote(rec) && (rec.collection === 'tab' || rec.collection === 'profile')) touchedTabs = true;
        } catch {
          // Unreadable record (wrong key or newer format): skip it.
        }
      }
      this.store.local.syncSeq = r.seq;
      this.store.scheduleSave();
      more = r.more === true;
      if (touchedTabs) this.store.emit('remote-tabs');
    }
  }

  private async push() {
    const ids = [...this.store.dirty];
    for (let i = 0; i < ids.length && this.creds; i += 200) {
      const batch = ids.slice(i, i + 200);
      const records: WireRecord[] = [];
      const sent = new Map<string, number>();
      for (const id of batch) {
        const rec = this.store.records.get(id);
        if (!rec) continue;
        const w: WireRecord = { id, blob: encryptRecord(rec, this.keys!.encKey) };
        const exp = this.store.expires.get(id);
        if (exp) w.expiresAt = exp;
        records.push(w);
        sent.set(id, rec.updatedAt);
      }
      if (!records.length) continue;
      await this.request('records', { method: 'POST', body: JSON.stringify({ records }) });
      // Only clear records that were not edited again while the request was in flight.
      for (const [id, at] of sent) if (this.store.records.get(id)?.updatedAt === at) this.store.dirty.delete(id);
      this.store.scheduleSave();
    }
  }

  /** Server-sent events: pull as soon as another device writes. */
  private async listen(gen: number) {
    let delay = 1000;
    while (gen === this.generation && this.creds) {
      const abort = new AbortController();
      this.stream = abort;
      try {
        const c = this.creds;
        const res = await net.fetch(`${c.server}/v1/accounts/${c.account}/events`, {
          headers: { authorization: `Bearer ${this.keys!.authToken}`, accept: 'text/event-stream' },
          signal: abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
        delay = 1000;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line.startsWith('data:') && Number(line.slice(5)) > this.store.local.syncSeq) this.enqueue(() => this.pull());
          }
        }
      } catch {
        // Fall through to reconnect; the poll timer covers the gap.
      }
      if (gen !== this.generation) return;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }
}
