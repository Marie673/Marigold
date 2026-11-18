// Shared sync protocol: record model + end-to-end encryption.
// The wire format is specified in docs/sync-protocol.md; the iOS client
// implements the same format with CryptoKit.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export type Collection = 'profile' | 'tab' | 'settings' | 'device' | 'aireq' | 'aires';

export interface ProfileData {
  name: string;
  color: string;
  icon: string;
  order: number;
}

export interface TabData {
  profileId: string;
  url: string;
  title: string;
  faviconUrl: string | null;
  pinned: boolean;
  order: number;
  createdAt: number;
  lastActiveAt: number;
  archivedAt: number | null;
}

export interface SettingsData {
  /** Unpinned tabs idle for longer than this are archived. 0 = never. */
  archiveAfterMs: number;
  searchEngine: 'google' | 'duckduckgo' | 'bing';
}

export interface DeviceData {
  name: string;
  platform: 'desktop' | 'ios';
  /** LLM providers this device can run on behalf of others (desktop only). */
  aiProviders: { id: string; label: string }[];
  lastSeenAt: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface PageContext {
  title: string;
  url: string;
  text: string;
}

export interface AiRequestData {
  targetDeviceId: string;
  provider: string;
  messages: ChatMessage[];
  context: PageContext[];
}

export interface AiResponseData {
  text: string;
  done: boolean;
  error: string | null;
}

/** Decrypted record. `id` is always `${collection}:${key}`. */
export interface SyncRecord<T = unknown> {
  v: 1;
  id: string;
  collection: Collection;
  updatedAt: number;
  deviceId: string;
  deleted: boolean;
  data: T;
}

/** What the server stores: it never sees anything but the id and ciphertext. */
export interface WireRecord {
  id: string;
  blob: string;
  seq?: number;
  expiresAt?: number;
}

export interface SyncCredentials {
  server: string;
  account: string;
  /** 32-byte master key, base64url. */
  key: string;
}

const b64url = (b: Buffer) => b.toString('base64url');

export function generateCredentials(server: string): SyncCredentials {
  return { server: normalizeServer(server), account: b64url(randomBytes(16)), key: b64url(randomBytes(32)) };
}

export function normalizeServer(server: string): string {
  const u = new URL(server.trim());
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Sync server must be http(s)');
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

export function pairingLink(c: SyncCredentials): string {
  const q = new URLSearchParams({ server: c.server, account: c.account, key: c.key });
  return `marigold://sync?${q.toString()}`;
}

export function parsePairingLink(link: string): SyncCredentials {
  const u = new URL(link.trim());
  if (u.protocol !== 'marigold:' || (u.hostname !== 'sync' && u.pathname.replace(/^\/+/, '') !== 'sync')) {
    throw new Error('Not a Marigold pairing link');
  }
  const server = u.searchParams.get('server');
  const account = u.searchParams.get('account');
  const key = u.searchParams.get('key');
  if (!server || !account || !key) throw new Error('Pairing link is incomplete');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(account)) throw new Error('Invalid account id');
  if (Buffer.from(key, 'base64url').length !== 32) throw new Error('Invalid key');
  return { server: normalizeServer(server), account, key };
}

export interface DerivedKeys {
  authToken: string;
  encKey: Buffer;
}

export function deriveKeys(c: Pick<SyncCredentials, 'account' | 'key'>): DerivedKeys {
  const master = Buffer.from(c.key, 'base64url');
  if (master.length !== 32) throw new Error('Invalid key');
  const salt = Buffer.from(c.account, 'utf8');
  const auth = Buffer.from(hkdfSync('sha256', master, salt, 'marigold-sync-auth-v1', 32));
  const enc = Buffer.from(hkdfSync('sha256', master, salt, 'marigold-sync-enc-v1', 32));
  return { authToken: b64url(auth), encKey: enc };
}

/** blob = base64(nonce[12] || ciphertext || tag[16]); AAD = record id. */
export function encryptRecord(rec: SyncRecord, encKey: Buffer, nonce: Buffer = randomBytes(12)): string {
  const cipher = createCipheriv('aes-256-gcm', encKey, nonce);
  cipher.setAAD(Buffer.from(rec.id, 'utf8'));
  const ct = Buffer.concat([cipher.update(JSON.stringify(rec), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString('base64');
}

export function decryptRecord(wire: Pick<WireRecord, 'id' | 'blob'>, encKey: Buffer): SyncRecord {
  const raw = Buffer.from(wire.blob, 'base64');
  if (raw.length < 28) throw new Error('Blob too short');
  const decipher = createDecipheriv('aes-256-gcm', encKey, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(wire.id, 'utf8'));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  const pt = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
  const rec = JSON.parse(pt.toString('utf8')) as SyncRecord;
  if (rec.id !== wire.id) throw new Error('Record id mismatch');
  return rec;
}

/** Last-writer-wins: newer updatedAt wins, device id breaks ties. */
export function isNewer(incoming: Pick<SyncRecord, 'updatedAt' | 'deviceId'>, local: Pick<SyncRecord, 'updatedAt' | 'deviceId'> | undefined): boolean {
  if (!local) return true;
  if (incoming.updatedAt !== local.updatedAt) return incoming.updatedAt > local.updatedAt;
  return incoming.deviceId > local.deviceId;
}
