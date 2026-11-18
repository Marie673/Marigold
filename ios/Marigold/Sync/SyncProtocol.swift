import Foundation
import CryptoKit

// Wire protocol: see docs/sync-protocol.md (reference: sync/core/protocol.ts).

enum SyncError: Error, LocalizedError {
    case invalidLink
    case incompleteLink
    case invalidAccount
    case invalidKey
    case invalidServer
    case badBlob
    case idMismatch
    case badResponse
    case http(Int)

    var errorDescription: String? {
        switch self {
        case .invalidLink: return L10n.t("Not a Marigold pairing link", "Marigold のペアリングリンクではありません")
        case .incompleteLink: return L10n.t("Pairing link is incomplete", "ペアリングリンクが不完全です")
        case .invalidAccount: return L10n.t("Invalid account id", "アカウント ID が不正です")
        case .invalidKey: return L10n.t("Invalid key", "キーが不正です")
        case .invalidServer: return L10n.t("Sync server must be an http(s) URL", "同期サーバーは http(s) の URL である必要があります")
        case .badBlob: return L10n.t("Malformed record", "レコードの形式が不正です")
        case .idMismatch: return L10n.t("Record id mismatch", "レコード ID が一致しません")
        case .badResponse: return L10n.t("Unexpected server response", "サーバーの応答が不正です")
        case .http(let code):
            if code == 401 {
                return L10n.t("The server rejected this key (401)", "サーバーがこのキーを拒否しました (401)")
            }
            return L10n.t("Server error (\(code))", "サーバーエラー (\(code))")
        }
    }
}

// MARK: - base64url

extension Data {
    /// base64url without padding (also accepts padded / standard input).
    init?(base64URLEncoded string: String) {
        var s = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while s.hasSuffix("=") { s.removeLast() }
        let rem = s.count % 4
        if rem == 1 { return nil }
        if rem > 0 { s += String(repeating: "=", count: 4 - rem) }
        guard let d = Data(base64Encoded: s) else { return nil }
        self = d
    }

    func base64URLEncodedString() -> String {
        return base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    var hexString: String {
        return map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - Model

/// Decrypted record. `id` is always `<collection>:<key>`.
struct SyncRecord: Codable, Equatable {
    var v: Int
    var id: String
    var collection: String
    var updatedAt: Int64
    var deviceId: String
    var deleted: Bool
    var data: JSONValue

    enum CodingKeys: String, CodingKey {
        case v, id, collection, updatedAt, deviceId, deleted, data
    }

    init(id: String, collection: String, updatedAt: Int64, deviceId: String, deleted: Bool, data: JSONValue) {
        self.v = 1
        self.id = id
        self.collection = collection
        self.updatedAt = updatedAt
        self.deviceId = deviceId
        self.deleted = deleted
        self.data = data
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let decodedId = try c.decode(String.self, forKey: .id)
        id = decodedId
        v = (try? c.decodeIfPresent(Int.self, forKey: .v)) ?? 1
        if let col = try? c.decodeIfPresent(String.self, forKey: .collection) {
            collection = col
        } else {
            collection = String(decodedId.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
        }
        // Tolerate a float here; always store integer milliseconds.
        let ts = try c.decode(Double.self, forKey: .updatedAt)
        updatedAt = (ts.isFinite && abs(ts) < 9.0e18) ? Int64(ts) : 0
        deviceId = (try? c.decodeIfPresent(String.self, forKey: .deviceId)) ?? ""
        deleted = (try? c.decodeIfPresent(Bool.self, forKey: .deleted)) ?? false
        data = (try? c.decodeIfPresent(JSONValue.self, forKey: .data)) ?? .null
    }

    /// The part of the id after `<collection>:`.
    var key: String {
        guard let idx = id.firstIndex(of: ":") else { return id }
        return String(id[id.index(after: idx)...])
    }
}

/// What the server stores.
struct WireRecord: Codable {
    var id: String
    var blob: String
    var seq: Int64?
    var expiresAt: Int64?
}

struct PullResponse: Decodable {
    var records: [WireRecord]
    var seq: Int64
    var more: Bool
}

struct PushBody: Encodable {
    var records: [WireRecord]
}

struct SyncCredentials: Codable, Equatable {
    var server: String
    var account: String
    var key: String
}

struct DerivedKeys {
    var authToken: String
    var encKey: SymmetricKey
}

// MARK: - Crypto + helpers

enum SyncCrypto {
    static func deriveKeys(account: String, key: String) throws -> DerivedKeys {
        guard let master = Data(base64URLEncoded: key), master.count == 32 else { throw SyncError.invalidKey }
        let ikm = SymmetricKey(data: master)
        let salt = Data(account.utf8)
        let auth = HKDF<SHA256>.deriveKey(inputKeyMaterial: ikm, salt: salt,
                                          info: Data("marigold-sync-auth-v1".utf8), outputByteCount: 32)
        let enc = HKDF<SHA256>.deriveKey(inputKeyMaterial: ikm, salt: salt,
                                         info: Data("marigold-sync-enc-v1".utf8), outputByteCount: 32)
        return DerivedKeys(authToken: keyData(auth).base64URLEncodedString(), encKey: enc)
    }

    static func keyData(_ key: SymmetricKey) -> Data {
        return key.withUnsafeBytes { Data(Array($0)) }
    }

    /// blob = base64(nonce[12] || ciphertext || tag[16]); AAD = record id.
    static func seal(plaintext: Data, id: String, key: SymmetricKey, nonce: AES.GCM.Nonce = AES.GCM.Nonce()) throws -> String {
        let box = try AES.GCM.seal(plaintext, using: key, nonce: nonce, authenticating: Data(id.utf8))
        guard let combined = box.combined else { throw SyncError.badBlob }
        return combined.base64EncodedString()
    }

    static func open(blob: String, id: String, key: SymmetricKey) throws -> Data {
        guard let raw = Data(base64Encoded: blob), raw.count >= 28 else { throw SyncError.badBlob }
        let box = try AES.GCM.SealedBox(combined: raw)
        return try AES.GCM.open(box, using: key, authenticating: Data(id.utf8))
    }

    static func encrypt(_ record: SyncRecord, key: SymmetricKey, nonce: AES.GCM.Nonce = AES.GCM.Nonce()) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        let plaintext = try encoder.encode(record)
        return try seal(plaintext: plaintext, id: record.id, key: key, nonce: nonce)
    }

    static func decrypt(id: String, blob: String, key: SymmetricKey) throws -> SyncRecord {
        let plaintext = try open(blob: blob, id: id, key: key)
        let record = try JSONDecoder().decode(SyncRecord.self, from: plaintext)
        guard record.id == id else { throw SyncError.idMismatch }
        return record
    }

    /// Last-writer-wins: newer updatedAt wins, device id breaks ties.
    static func isNewer(_ incoming: SyncRecord, than local: SyncRecord?) -> Bool {
        guard let local = local else { return true }
        if incoming.updatedAt != local.updatedAt { return incoming.updatedAt > local.updatedAt }
        return incoming.deviceId > local.deviceId
    }

    static func normalizeServer(_ server: String) throws -> String {
        let trimmed = server.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let comps = URLComponents(string: trimmed),
              let scheme = comps.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = comps.host, !host.isEmpty else {
            throw SyncError.invalidServer
        }
        var out = scheme + "://"
        if host.contains(":") && !host.hasPrefix("[") {
            out += "[" + host + "]"
        } else {
            out += host
        }
        if let port = comps.port { out += ":\(port)" }
        var path = comps.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }
        return out + path
    }

    /// `marigold://sync?server=<urlencoded>&account=<account>&key=<key>`
    static func parsePairingLink(_ link: String) throws -> SyncCredentials {
        let trimmed = link.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let comps = URLComponents(string: trimmed), comps.scheme?.lowercased() == "marigold" else {
            throw SyncError.invalidLink
        }
        let pathPart = comps.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard comps.host == "sync" || pathPart == "sync" else { throw SyncError.invalidLink }
        var values: [String: String] = [:]
        for item in comps.queryItems ?? [] {
            if let value = item.value { values[item.name] = value }
        }
        guard let server = values["server"], let account = values["account"], let key = values["key"],
              !server.isEmpty, !account.isEmpty, !key.isEmpty else {
            throw SyncError.incompleteLink
        }
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
        guard account.count >= 16, account.count <= 64,
              account.unicodeScalars.allSatisfy({ allowed.contains($0) }) else {
            throw SyncError.invalidAccount
        }
        guard let keyBytes = Data(base64URLEncoded: key), keyBytes.count == 32 else { throw SyncError.invalidKey }
        return SyncCredentials(server: try normalizeServer(server), account: account, key: key)
    }

    /// Random id: 16 chars of [a-z0-9].
    static func randomId(_ length: Int = 16) -> String {
        let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        var out = ""
        for _ in 0..<length {
            out.append(alphabet[Int.random(in: 0..<alphabet.count)])
        }
        return out
    }

    static func nowMs() -> Int64 {
        return Int64(Date().timeIntervalSince1970 * 1000)
    }
}
