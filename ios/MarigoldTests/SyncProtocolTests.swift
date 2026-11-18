import XCTest
import CryptoKit
@testable import Marigold

/// Checks the client against the test vector in docs/sync-protocol.md.
final class SyncProtocolTests: XCTestCase {
    private let account = "AAAAAAAAAAAAAAAAAAAAAA"
    private let masterKey = Data(repeating: 0x07, count: 32).base64URLEncodedString()
    private let plaintext = #"{"v":1,"id":"tab:vector","collection":"tab","updatedAt":1700000000000,"deviceId":"dev_a","deleted":false,"data":{"hello":"world"}}"#
    private let blob = "AQEBAQEBAQEBAQEBr+lOMtZZCMzUnTArNx0+8ZZuZebpgy8SWw+J8C0L1QC053PNmVAnS7SPvbyVeSZcfHcnnJq3sShdT01SYYeOR9ApZeM6EoZePrAabh59jwitzuVSsOU+J8xtOLoGbmVnt0HGE3e7bOypOs2W+0x1NnEiTghRtX8EQiZhNMlwrXRZ9OQA/c7i8PC4eh0HC9tAO3M="

    func testKeyDerivationMatchesVector() throws {
        let keys = try SyncCrypto.deriveKeys(account: account, key: masterKey)
        XCTAssertEqual(keys.authToken, "pHEZK2Zc2Wg6SHa84zocsFXvOvJV1ItMbumKv6fe4C4")
        XCTAssertEqual(SyncCrypto.keyData(keys.encKey).hexString,
                       "1162aace20fded62ea1bbf08cf3d70434aa3693b25578df317d1e0be53a52f3f")
    }

    func testDecryptVectorBlob() throws {
        let keys = try SyncCrypto.deriveKeys(account: account, key: masterKey)

        let raw = try SyncCrypto.open(blob: blob, id: "tab:vector", key: keys.encKey)
        XCTAssertEqual(String(data: raw, encoding: .utf8), plaintext)

        let record = try SyncCrypto.decrypt(id: "tab:vector", blob: blob, key: keys.encKey)
        XCTAssertEqual(record.v, 1)
        XCTAssertEqual(record.id, "tab:vector")
        XCTAssertEqual(record.collection, "tab")
        XCTAssertEqual(record.key, "vector")
        XCTAssertEqual(record.updatedAt, 1_700_000_000_000)
        XCTAssertEqual(record.deviceId, "dev_a")
        XCTAssertFalse(record.deleted)
        XCTAssertEqual(record.data, .object(["hello": .string("world")]))
    }

    func testSealWithVectorNonceReproducesBlob() throws {
        let keys = try SyncCrypto.deriveKeys(account: account, key: masterKey)
        let nonce = try AES.GCM.Nonce(data: Data(repeating: 0x01, count: 12))
        let sealed = try SyncCrypto.seal(plaintext: Data(plaintext.utf8), id: "tab:vector", key: keys.encKey, nonce: nonce)
        XCTAssertEqual(sealed, blob)
    }

    func testWrongIdIsRejected() throws {
        let keys = try SyncCrypto.deriveKeys(account: account, key: masterKey)
        // The id is the AAD, so a blob moved to another id must not decrypt.
        XCTAssertThrowsError(try SyncCrypto.decrypt(id: "tab:other", blob: blob, key: keys.encKey))
        XCTAssertThrowsError(try SyncCrypto.decrypt(id: "tab:vector", blob: "AAAA", key: keys.encKey))
    }

    func testEncryptDecryptRoundTrip() throws {
        let keys = try SyncCrypto.deriveKeys(account: account, key: masterKey)
        let tab = BrowserTab(id: "abc123", profileId: "p1", url: "https://example.com/a?b=c", title: "Example — 例",
                             faviconUrl: nil, pinned: true, order: 2.5, createdAt: 1_700_000_000_000,
                             lastActiveAt: 1_700_000_000_123, archivedAt: nil)
        let record = SyncRecord(id: "tab:abc123", collection: "tab", updatedAt: 1_763_450_000_000,
                                deviceId: "dev_test", deleted: false, data: tab.data())
        let sealed = try SyncCrypto.encrypt(record, key: keys.encKey)
        XCTAssertNotEqual(sealed, try SyncCrypto.encrypt(record, key: keys.encKey), "nonce must be random")
        let opened = try SyncCrypto.decrypt(id: record.id, blob: sealed, key: keys.encKey)
        XCTAssertEqual(opened, record)
        XCTAssertEqual(BrowserTab(record: opened), tab)
    }

    func testJSONShapes() throws {
        let tab = BrowserTab(id: "abc123", profileId: "p1", url: "https://example.com/", title: "Example",
                             faviconUrl: nil, pinned: false, order: 3, createdAt: 1_700_000_000_000,
                             lastActiveAt: 1_700_000_000_123, archivedAt: nil)
        let record = SyncRecord(id: "tab:abc123", collection: "tab", updatedAt: 1_763_450_000_000,
                                deviceId: "dev_test", deleted: false, data: tab.data())
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let json = String(data: try encoder.encode(record), encoding: .utf8) ?? ""
        // Millisecond timestamps are integers; absent values are explicit nulls.
        XCTAssertTrue(json.contains(#""updatedAt":1763450000000"#), json)
        XCTAssertTrue(json.contains(#""lastActiveAt":1700000000123"#), json)
        XCTAssertTrue(json.contains(#""createdAt":1700000000000"#), json)
        XCTAssertTrue(json.contains(#""archivedAt":null"#), json)
        XCTAssertTrue(json.contains(#""faviconUrl":null"#), json)
        XCTAssertTrue(json.contains(#""pinned":false"#), json)
        XCTAssertTrue(json.contains(#""v":1"#), json)
    }

    func testUnknownDataRoundTripsUntouched() throws {
        let source = #"{"v":1,"id":"future:x","collection":"future","updatedAt":5,"deviceId":"dev_b","deleted":false,"data":{"a":[1,2.5,"s",null,true],"b":{"c":{}}}}"#
        let record = try JSONDecoder().decode(SyncRecord.self, from: Data(source.utf8))
        let again = try JSONDecoder().decode(SyncRecord.self, from: try JSONEncoder().encode(record))
        XCTAssertEqual(record, again)
        XCTAssertEqual(record.data["a"]?.arrayValue?.count, 5)
        XCTAssertEqual(record.data["a"]?.arrayValue?[4], .bool(true))
        XCTAssertEqual(record.data["a"]?.arrayValue?[0], .number(1))
    }

    func testLastWriterWins() {
        func rec(_ updatedAt: Int64, _ device: String) -> SyncRecord {
            return SyncRecord(id: "tab:x", collection: "tab", updatedAt: updatedAt, deviceId: device, deleted: false, data: .null)
        }
        XCTAssertTrue(SyncCrypto.isNewer(rec(1, "dev_a"), than: nil))
        XCTAssertTrue(SyncCrypto.isNewer(rec(2, "dev_a"), than: rec(1, "dev_b")))
        XCTAssertFalse(SyncCrypto.isNewer(rec(1, "dev_b"), than: rec(2, "dev_a")))
        XCTAssertTrue(SyncCrypto.isNewer(rec(2, "dev_b"), than: rec(2, "dev_a")))
        XCTAssertFalse(SyncCrypto.isNewer(rec(2, "dev_a"), than: rec(2, "dev_b")))
        XCTAssertFalse(SyncCrypto.isNewer(rec(2, "dev_a"), than: rec(2, "dev_a")))
    }

    func testPairingLink() throws {
        let link = "marigold://sync?server=http%3A%2F%2F192.168.1.20%3A8787%2F&account=\(account)&key=\(masterKey)"
        let creds = try SyncCrypto.parsePairingLink(link)
        XCTAssertEqual(creds.server, "http://192.168.1.20:8787")
        XCTAssertEqual(creds.account, account)
        XCTAssertEqual(creds.key, masterKey)

        XCTAssertThrowsError(try SyncCrypto.parsePairingLink("https://example.com/?server=x"))
        XCTAssertThrowsError(try SyncCrypto.parsePairingLink("marigold://sync?server=https%3A%2F%2Fa.example&account=\(account)"))
        XCTAssertThrowsError(try SyncCrypto.parsePairingLink("marigold://sync?server=https%3A%2F%2Fa.example&account=\(account)&key=AAAA"))
        XCTAssertThrowsError(try SyncCrypto.parsePairingLink("marigold://sync?server=ftp%3A%2F%2Fa.example&account=\(account)&key=\(masterKey)"))
    }

    func testBase64URL() {
        let bytes = Data([0xfb, 0xff, 0xfe, 0x00, 0x01])
        let encoded = bytes.base64URLEncodedString()
        XCTAssertFalse(encoded.contains("+") || encoded.contains("/") || encoded.contains("="))
        XCTAssertEqual(Data(base64URLEncoded: encoded), bytes)
        XCTAssertEqual(SyncCrypto.randomId().count, 16)
    }

    func testProfileStoreIdentifierIsStable() {
        XCTAssertEqual(ProfileStore.uuid(for: "p1"), ProfileStore.uuid(for: "p1"))
        XCTAssertNotEqual(ProfileStore.uuid(for: "p1"), ProfileStore.uuid(for: "p2"))
    }
}
