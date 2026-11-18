// Marigold sync server. Zero dependencies: `node sync/server/server.ts`.
// Stores opaque encrypted blobs per account; it cannot read any user data.
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';

interface StoredRecord {
  blob: string;
  seq: number;
  expiresAt?: number;
}

interface Account {
  tokenHash: string;
  seq: number;
  records: Map<string, StoredRecord>;
  listeners: Set<ServerResponse>;
  dirty: boolean;
}

export interface ServerOptions {
  dataDir: string;
  maxAccounts?: number;
  maxRecordsPerAccount?: number;
  maxBlobBytes?: number;
  maxBodyBytes?: number;
}

const ACCOUNT_RE = /^[A-Za-z0-9_-]{16,64}$/;
const ID_RE = /^[a-z]{1,16}:[A-Za-z0-9_.-]{1,80}$/;

export function createSyncServer(opts: ServerOptions): Server & { flush(): void } {
  const maxAccounts = opts.maxAccounts ?? 100;
  const maxRecords = opts.maxRecordsPerAccount ?? 20000;
  const maxBlob = opts.maxBlobBytes ?? 256 * 1024;
  const maxBody = opts.maxBodyBytes ?? 4 * 1024 * 1024;
  const accounts = new Map<string, Account>();
  mkdirSync(opts.dataDir, { recursive: true });

  for (const f of readdirSync(opts.dataDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(readFileSync(join(opts.dataDir, f), 'utf8'));
      accounts.set(f.slice(0, -5), {
        tokenHash: j.tokenHash,
        seq: j.seq,
        records: new Map(Object.entries(j.records as Record<string, StoredRecord>)),
        listeners: new Set(),
        dirty: false,
      });
    } catch (e) {
      console.error(`skipping unreadable account file ${f}:`, e);
    }
  }

  const flush = () => {
    for (const [id, a] of accounts) {
      if (!a.dirty) continue;
      const file = join(opts.dataDir, `${id}.json`);
      writeFileSync(`${file}.tmp`, JSON.stringify({ tokenHash: a.tokenHash, seq: a.seq, records: Object.fromEntries(a.records) }));
      renameSync(`${file}.tmp`, file);
      a.dirty = false;
    }
  };

  const purgeExpired = () => {
    const now = Date.now();
    for (const a of accounts.values()) {
      for (const [id, r] of a.records) {
        if (r.expiresAt && r.expiresAt < now) {
          a.records.delete(id);
          a.dirty = true;
        }
      }
    }
  };

  const hash = (t: string) => createHash('sha256').update(t).digest('hex');

  const send = (res: ServerResponse, status: number, body: unknown) => {
    const s = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(s);
  };

  /** Returns the account, creating it on first use (trust on first use). */
  const authenticate = (req: IncomingMessage, id: string, create: boolean): Account | number => {
    const m = /^Bearer ([A-Za-z0-9_-]{20,128})$/.exec(req.headers.authorization ?? '');
    if (!m) return 401;
    const h = hash(m[1]);
    const acct = accounts.get(id);
    if (!acct) {
      if (!create) return 404;
      if (accounts.size >= maxAccounts) return 507;
      const a: Account = { tokenHash: h, seq: 0, records: new Map(), listeners: new Set(), dirty: true };
      accounts.set(id, a);
      return a;
    }
    return timingSafeEqual(Buffer.from(h), Buffer.from(acct.tokenHash)) ? acct : 401;
  };

  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBody) {
          reject(new Error('too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'GET' && url.pathname === '/v1/health') return send(res, 200, { ok: true, service: 'marigold-sync', v: 1 });
      const m = /^\/v1\/accounts\/([^/]+)\/(records|events)$/.exec(url.pathname);
      if (!m || !ACCOUNT_RE.test(m[1])) return send(res, 404, { error: 'not_found' });
      const [, accountId, resource] = m;

      if (resource === 'records' && req.method === 'POST') {
        const acct = authenticate(req, accountId, true);
        if (typeof acct === 'number') return send(res, acct, { error: 'unauthorized' });
        let body: any;
        try {
          body = await readBody(req);
        } catch {
          return send(res, 400, { error: 'bad_body' });
        }
        const recs = body?.records;
        if (!Array.isArray(recs) || recs.length > 1000) return send(res, 400, { error: 'bad_records' });
        for (const r of recs) {
          const ok =
            r && typeof r.id === 'string' && ID_RE.test(r.id) && typeof r.blob === 'string' && r.blob.length <= maxBlob &&
            (r.expiresAt === undefined || (typeof r.expiresAt === 'number' && Number.isFinite(r.expiresAt)));
          if (!ok) return send(res, 400, { error: 'bad_record' });
        }
        const fresh = recs.filter((r: any) => !acct.records.has(r.id)).length;
        if (acct.records.size + fresh > maxRecords) return send(res, 507, { error: 'quota' });
        for (const r of recs) {
          const rec: StoredRecord = { blob: r.blob, seq: ++acct.seq };
          if (r.expiresAt !== undefined) rec.expiresAt = r.expiresAt;
          acct.records.set(r.id, rec);
        }
        if (recs.length) {
          acct.dirty = true;
          for (const l of acct.listeners) l.write(`event: seq\ndata: ${acct.seq}\n\n`);
        }
        return send(res, 200, { seq: acct.seq });
      }

      if (resource === 'records' && req.method === 'GET') {
        const acct = authenticate(req, accountId, false);
        if (acct === 404) return send(res, 200, { records: [], seq: 0, more: false });
        if (typeof acct === 'number') return send(res, acct, { error: 'unauthorized' });
        const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 500));
        const now = Date.now();
        const all = [...acct.records.entries()]
          .filter(([, r]) => r.seq > since && !(r.expiresAt && r.expiresAt < now))
          .sort((a, b) => a[1].seq - b[1].seq);
        const page = all.slice(0, limit).map(([id, r]) => ({ id, ...r }));
        const more = all.length > limit;
        return send(res, 200, { records: page, seq: more ? page[page.length - 1].seq : acct.seq, more });
      }

      if (resource === 'events' && req.method === 'GET') {
        const acct = authenticate(req, accountId, true);
        if (typeof acct === 'number') return send(res, acct, { error: 'unauthorized' });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.write(`event: seq\ndata: ${acct.seq}\n\n`);
        acct.listeners.add(res);
        req.on('close', () => acct.listeners.delete(res));
        return;
      }
      return send(res, 405, { error: 'method_not_allowed' });
    } catch (e) {
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: 'internal' });
    }
  });

  const keepalive = setInterval(() => {
    for (const a of accounts.values()) for (const l of a.listeners) l.write(': ping\n\n');
  }, 25_000);
  const saver = setInterval(() => {
    purgeExpired();
    flush();
  }, 2_000);
  keepalive.unref();
  saver.unref();
  server.on('close', () => {
    clearInterval(keepalive);
    clearInterval(saver);
    flush();
  });
  return Object.assign(server, { flush });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!) && process.argv[1].includes('server')) {
  const port = Number(process.env.PORT) || 8787;
  const host = process.env.HOST || '0.0.0.0';
  const dataDir = process.env.MARIGOLD_DATA_DIR || './sync-data';
  const server = createSyncServer({ dataDir, maxAccounts: Number(process.env.MARIGOLD_MAX_ACCOUNTS) || 100 });
  server.listen(port, host, () => console.log(`Marigold sync server listening on http://${host}:${port} (data: ${dataDir})`));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', () => {
    server.closeAllConnections();
    stop();
  });
}
