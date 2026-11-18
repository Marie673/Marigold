# Marigold sync protocol (v1)

Marigold devices (desktop, iOS) share state through a small self-hosted server.
Everything is end-to-end encrypted: the server stores opaque blobs and can read
only record ids, sizes and timing.

Reference implementation: `sync/core/protocol.ts` (crypto + model) and
`sync/server/server.ts` (server).

## Pairing

A sync account is three values:

| field     | format                                            |
|-----------|---------------------------------------------------|
| `server`  | base URL, no trailing slash                       |
| `account` | 16 random bytes, base64url (22 chars), no padding |
| `key`     | 32 random bytes (master key), base64url           |

Devices exchange them as a link (also shown as a QR code on desktop):

    marigold://sync?server=<urlencoded>&account=<account>&key=<key>

## Key derivation

HKDF-SHA256, `salt` = UTF-8 bytes of `account`, 32 bytes of output each:

- `authKey` = HKDF(master, salt, info = `marigold-sync-auth-v1`); the bearer token is `base64url(authKey)`.
- `encKey`  = HKDF(master, salt, info = `marigold-sync-enc-v1`).

## Record encryption

A decrypted record is this JSON object:

```json
{ "v": 1, "id": "tab:8f3a…", "collection": "tab", "updatedAt": 1763450000000,
  "deviceId": "dev_…", "deleted": false, "data": { } }
```

- `id` is `<collection>:<key>` and matches `^[a-z]{1,16}:[A-Za-z0-9_.-]{1,80}$`.
- `updatedAt` is Unix milliseconds. `deleted: true` is a tombstone.
- Wire `blob` = standard base64 of `nonce(12) || ciphertext || tag(16)`,
  AES-256-GCM with `encKey`, random nonce, AAD = UTF-8 bytes of the record `id`.
  (This is CryptoKit's `AES.GCM.SealedBox.combined`.)
- After decrypting, reject the record if the inner `id` differs from the wire `id`.

**Conflict resolution** is last-writer-wins per record: an incoming record
replaces the local one if its `updatedAt` is greater, or equal with a
lexicographically greater `deviceId`.

### Test vector

- account `AAAAAAAAAAAAAAAAAAAAAA`, master key = 32 bytes of `0x07`
- auth token: `pHEZK2Zc2Wg6SHa84zocsFXvOvJV1ItMbumKv6fe4C4`
- encKey (hex): `1162aace20fded62ea1bbf08cf3d70434aa3693b25578df317d1e0be53a52f3f`
- plaintext: `{"v":1,"id":"tab:vector","collection":"tab","updatedAt":1700000000000,"deviceId":"dev_a","deleted":false,"data":{"hello":"world"}}`
- nonce = 12 bytes of `0x01`, blob:
  `AQEBAQEBAQEBAQEBr+lOMtZZCMzUnTArNx0+8ZZuZebpgy8SWw+J8C0L1QC053PNmVAnS7SPvbyVeSZcfHcnnJq3sShdT01SYYeOR9ApZeM6EoZePrAabh59jwitzuVSsOU+J8xtOLoGbmVnt0HGE3e7bOypOs2W+0x1NnEiTghRtX8EQiZhNMlwrXRZ9OQA/c7i8PC4eh0HC9tAO3M=`

## HTTP API

All account endpoints need `Authorization: Bearer <token>`. An account is
created by the first authenticated `POST …/records` or `GET …/events`; the
server remembers a hash of that token and rejects any other (401).

| method & path                                   | body / query                                  | response |
|-------------------------------------------------|-----------------------------------------------|----------|
| `GET /v1/health`                                |                                               | `{ok:true}` |
| `POST /v1/accounts/{account}/records`           | `{records:[{id, blob, expiresAt?}]}` (≤1000)  | `{seq}` |
| `GET /v1/accounts/{account}/records`            | `?since=<seq>&limit=<n≤1000>`                 | `{records:[{id, blob, seq, expiresAt?}], seq, more}` |
| `GET /v1/accounts/{account}/events`             |                                               | Server-Sent Events |

- Every stored record gets the account's next `seq`. A client keeps the `seq`
  from its last pull and asks for `since=<that>`; while `more` is true it
  repeats with the returned `seq`. A never-used account returns an empty list.
- `expiresAt` (Unix ms, plaintext) lets the server drop short-lived records.
- The event stream sends `event: seq` / `data: <seq>` on connect and after each
  write, plus `: ping` comments every 25 s. Clients pull when the seq is ahead
  of theirs, and should also poll (e.g. every 30–60 s) as a fallback.

## Collections (`data` shapes)

| collection | id                     | data |
|------------|------------------------|------|
| `profile`  | `profile:<id>`         | `{name, color, icon, order}` — `color` is `#rrggbb`, `icon` an emoji |
| `tab`      | `tab:<id>`             | `{profileId, url, title, faviconUrl, pinned, order, createdAt, lastActiveAt, archivedAt}` |
| `settings` | `settings:global`      | `{archiveAfterMs, searchEngine}` — `archiveAfterMs` 0 = never |
| `device`   | `device:<deviceId>`    | `{name, platform: "desktop"\|"ios", aiProviders:[{id,label}], lastSeenAt}` |
| `aireq`    | `aireq:<uuid>`         | `{targetDeviceId, provider, messages:[{role,content}], context:[{title,url,text}]}` |
| `aires`    | `aires:<same uuid>`    | `{text, done, error}` |

`profileId` in a tab is the profile's key without the `profile:` prefix.

**Tabs are shared**: a tab record is the same tab on every device. A tab with
`archivedAt != null` is in the archive. Any device may archive unpinned tabs
whose `lastActiveAt` is older than `settings.archiveAfterMs`.

**AI relay** lets a phone use the LLM subscription that is signed in on a
desktop. The phone writes an `aireq` addressed to a desktop listed in `device`
records with a non-empty `aiProviders` (and `expiresAt` ≈ now + 10 min). That
desktop runs the request and repeatedly rewrites `aires:<uuid>` with the full
text so far, ending with `done: true` (or `error`). Writing the `aireq` again
with `deleted: true` cancels it.
