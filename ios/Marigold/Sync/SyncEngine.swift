import Foundation
import UIKit
import CryptoKit

/// Local record store + sync with the self-hosted server (pull / push / SSE).
/// Works without credentials too: records are then simply local.
@MainActor
final class SyncEngine: ObservableObject {
    enum Status: Equatable {
        case unpaired
        case connecting
        case connected
        case offline
    }

    /// All decrypted records keyed by id (including tombstones).
    @Published private(set) var records: [String: SyncRecord] = [:]
    @Published private(set) var status: Status = .unpaired
    @Published private(set) var lastSyncAt: Date?
    @Published private(set) var lastError: String?
    @Published private(set) var credentials: SyncCredentials?
    /// False while paired and the first pull of this pairing has not finished yet.
    @Published private(set) var initialPullDone = true
    @Published var deviceName: String {
        didSet {
            guard deviceName != oldValue else { return }
            UserDefaults.standard.set(deviceName, forKey: "deviceName")
            publishDevice()
        }
    }

    let deviceId: String
    /// Called after every successful pull (and after a failed one, with `false`).
    var onPullFinished: ((Bool) -> Void)?

    private var lastSeq: Int64 = 0
    private var dirty: Set<String> = []
    private var expiries: [String: Int64] = [:]
    private var keys: DerivedKeys?

    private var isPulling = false
    private var pullAgain = false
    private var isPushing = false
    private var pushAgain = false
    private var isForeground = true
    private var started = false

    private var pushDebounce: Task<Void, Never>?
    private var saveDebounce: Task<Void, Never>?
    private var eventsTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?

    private let session: URLSession
    private let storeURL: URL

    private static let keychainAccount = "credentials"
    private static let ephemeralCollections: Set<String> = ["aireq", "aires"]

    private struct PersistedState: Codable {
        var records: [String: SyncRecord]
        var lastSeq: Int64
        var dirty: [String]
        var expiries: [String: Int64]?
    }

    init() {
        let defaults = UserDefaults.standard
        if let existing = defaults.string(forKey: "deviceId"), !existing.isEmpty {
            deviceId = existing
        } else {
            let fresh = "dev_" + SyncCrypto.randomId()
            defaults.set(fresh, forKey: "deviceId")
            deviceId = fresh
        }
        _deviceName = Published(wrappedValue: defaults.string(forKey: "deviceName") ?? UIDevice.current.name)

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 75
        config.waitsForConnectivity = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: config)

        let fm = FileManager.default
        let base = (try? fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? fm.temporaryDirectory
        let dir = base.appendingPathComponent("Marigold", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        storeURL = dir.appendingPathComponent("store.json")

        if let data = try? Data(contentsOf: storeURL),
           let state = try? JSONDecoder().decode(PersistedState.self, from: data) {
            records = state.records
            lastSeq = state.lastSeq
            dirty = Set(state.dirty)
            expiries = state.expiries ?? [:]
        }

        if let data = Keychain.load(account: SyncEngine.keychainAccount),
           let creds = try? JSONDecoder().decode(SyncCredentials.self, from: data),
           let derived = try? SyncCrypto.deriveKeys(account: creds.account, key: creds.key) {
            credentials = creds
            keys = derived
            status = .connecting
            initialPullDone = lastSeq > 0
        }
    }

    var isPaired: Bool { credentials != nil }

    // MARK: - Lifecycle

    /// Call once when the UI appears.
    func start() {
        guard !started else { return }
        started = true
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                guard let self = self else { return }
                if self.isForeground && self.isPaired {
                    self.pullNow()
                    if !self.dirty.isEmpty { self.pushNow() }
                }
            }
        }
        if isPaired { connect() }
    }

    func setForeground(_ foreground: Bool) {
        let changed = foreground != isForeground
        isForeground = foreground
        guard started else { return }
        if foreground {
            if isPaired && (changed || eventsTask == nil) { connect() }
        } else {
            eventsTask?.cancel()
            eventsTask = nil
            if !dirty.isEmpty { pushNow() }
            saveNow()
        }
    }

    private func connect() {
        guard let creds = credentials, let keys = keys else { return }
        eventsTask?.cancel()
        if status != .connected { status = .connecting }
        publishDevice()
        pullNow()
        eventsTask = Task { [weak self] in
            await self?.runEvents(creds: creds, keys: keys)
        }
    }

    // MARK: - Pairing

    func pair(link: String) throws {
        let creds = try SyncCrypto.parsePairingLink(link)
        let derived = try SyncCrypto.deriveKeys(account: creds.account, key: creds.key)
        if creds == credentials {
            if started { connect() }
            return
        }
        if let data = try? JSONEncoder().encode(creds) {
            Keychain.save(data, account: SyncEngine.keychainAccount)
        }
        credentials = creds
        keys = derived
        lastSeq = 0
        lastSyncAt = nil
        lastError = nil
        initialPullDone = false
        status = .connecting
        // Bring tabs/profiles that were created locally into the account.
        for rec in records.values where rec.collection == "tab" || rec.collection == "profile" {
            dirty.insert(rec.id)
        }
        scheduleSave()
        if started { connect() }
    }

    func disconnect() {
        Keychain.delete(account: SyncEngine.keychainAccount)
        eventsTask?.cancel()
        eventsTask = nil
        pushDebounce?.cancel()
        credentials = nil
        keys = nil
        lastSeq = 0
        dirty.removeAll()
        expiries.removeAll()
        lastError = nil
        lastSyncAt = nil
        initialPullDone = true
        status = .unpaired
        scheduleSave()
    }

    // MARK: - Local store API

    /// A live (non-tombstone) record.
    func record(_ id: String) -> SyncRecord? {
        guard let rec = records[id], !rec.deleted else { return nil }
        return rec
    }

    func liveRecords(in collection: String) -> [SyncRecord] {
        return records.values.filter { $0.collection == collection && !$0.deleted }
    }

    /// Writes a record locally and queues it for upload.
    @discardableResult
    func put(collection: String, key: String, data: JSONValue, deleted: Bool = false, expiresAt: Int64? = nil) -> SyncRecord {
        let id = collection + ":" + key
        let previous = records[id]
        // Always move forward, even if another device's clock is ahead of ours.
        let updatedAt = max(SyncCrypto.nowMs(), (previous?.updatedAt ?? 0) + 1)
        let rec = SyncRecord(id: id, collection: collection, updatedAt: updatedAt, deviceId: deviceId, deleted: deleted, data: data)
        records[id] = rec
        if let expiresAt = expiresAt {
            expiries[id] = expiresAt
        }
        if isPaired {
            dirty.insert(id)
            schedulePush()
        }
        scheduleSave()
        return rec
    }

    /// Tombstones a record, keeping its data.
    func delete(id: String) {
        guard let rec = records[id], !rec.deleted else { return }
        put(collection: rec.collection, key: rec.key, data: rec.data, deleted: true, expiresAt: expiries[id])
    }

    func publishDevice() {
        guard isPaired else { return }
        let id = "device:" + deviceId
        var obj = records[id]?.data.objectValue ?? [:]
        obj["name"] = .string(deviceName)
        obj["platform"] = .string("ios")
        obj["aiProviders"] = .array([])
        obj["lastSeenAt"] = JSONValue.int(SyncCrypto.nowMs())
        put(collection: "device", key: deviceId, data: .object(obj))
    }

    // MARK: - Pull

    func pullNow() {
        guard isPaired else { return }
        if isPulling {
            pullAgain = true
            return
        }
        Task { [weak self] in
            await self?.pullLoop()
        }
    }

    private func pullLoop() async {
        guard !isPulling, let creds = credentials, let keys = keys else { return }
        isPulling = true
        defer {
            isPulling = false
            // A pull was requested while this one was running and it ended early.
            if pullAgain {
                pullAgain = false
                pullNow()
            }
        }
        var again = true
        while again {
            pullAgain = false
            do {
                var more = true
                while more {
                    let resp = try await fetchRecords(since: lastSeq, creds: creds, keys: keys)
                    // Pairing changed while we were waiting: drop the response.
                    guard credentials == creds else { return }
                    if resp.seq < lastSeq {
                        // The server has less history than we do (it was reset): start over
                        // and upload our copy again.
                        lastSeq = 0
                        for rec in records.values where !SyncEngine.ephemeralCollections.contains(rec.collection) {
                            dirty.insert(rec.id)
                        }
                        schedulePush()
                        continue
                    }
                    merge(resp.records, keys: keys)
                    let advanced = resp.seq > lastSeq
                    lastSeq = resp.seq
                    more = resp.more && advanced
                }
                pruneEphemeral()
                lastSyncAt = Date()
                lastError = nil
                initialPullDone = true
                if status == .connecting { status = .connected }
                scheduleSave()
                if !dirty.isEmpty { schedulePush() }
                onPullFinished?(true)
            } catch {
                if credentials == creds {
                    note(error)
                    onPullFinished?(false)
                }
                return
            }
            again = pullAgain
        }
    }

    private func merge(_ wires: [WireRecord], keys: DerivedKeys) {
        guard !wires.isEmpty else { return }
        var next = records
        var changed = false
        for wire in wires {
            // Undecryptable or malformed records are skipped.
            guard let rec = try? SyncCrypto.decrypt(id: wire.id, blob: wire.blob, key: keys.encKey) else { continue }
            if SyncCrypto.isNewer(rec, than: next[rec.id]) {
                next[rec.id] = rec
                dirty.remove(rec.id)
                if let exp = wire.expiresAt {
                    expiries[rec.id] = exp
                }
                changed = true
            }
        }
        if changed { records = next }
    }

    /// The server drops short-lived records; forget our copies too.
    private func pruneEphemeral() {
        let now = SyncCrypto.nowMs()
        let cutoff = now - 3_600_000
        var next = records
        var changed = false
        for rec in records.values where SyncEngine.ephemeralCollections.contains(rec.collection) {
            if dirty.contains(rec.id) { continue }
            let expired = (expiries[rec.id].map { $0 < now } ?? false) && rec.updatedAt < now - 60_000
            if rec.updatedAt < cutoff || expired {
                next.removeValue(forKey: rec.id)
                expiries.removeValue(forKey: rec.id)
                changed = true
            }
        }
        if changed { records = next }
    }

    // MARK: - Push

    private func schedulePush() {
        guard isPaired else { return }
        pushDebounce?.cancel()
        pushDebounce = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            if Task.isCancelled { return }
            self?.pushNow()
        }
    }

    private func pushNow() {
        guard isPaired else { return }
        if isPushing {
            pushAgain = true
            return
        }
        // A separate task so that re-arming the debounce never cancels a request in flight.
        Task { [weak self] in
            await self?.pushLoop()
        }
    }

    private func pushLoop() async {
        guard !isPushing, let creds = credentials, let keys = keys else { return }
        isPushing = true
        defer { isPushing = false }
        var again = true
        while again {
            pushAgain = false
            let batch: [SyncRecord] = dirty.compactMap { records[$0] }
            for id in dirty where records[id] == nil {
                dirty.remove(id)
            }
            if batch.isEmpty { return }
            var index = 0
            while index < batch.count {
                let chunk = Array(batch[index..<min(index + 500, batch.count)])
                index += 500
                var wires: [WireRecord] = []
                for rec in chunk {
                    if let blob = try? SyncCrypto.encrypt(rec, key: keys.encKey) {
                        wires.append(WireRecord(id: rec.id, blob: blob, seq: nil, expiresAt: expiries[rec.id]))
                    }
                }
                do {
                    try await postRecords(wires, creds: creds, keys: keys)
                } catch {
                    if credentials == creds { note(error) }
                    return // retried by the poll loop
                }
                guard credentials == creds else { return }
                for rec in chunk where records[rec.id]?.updatedAt == rec.updatedAt {
                    dirty.remove(rec.id)
                }
            }
            scheduleSave()
            again = pushAgain || !dirty.isEmpty
        }
    }

    // MARK: - Events (SSE)

    private func runEvents(creds: SyncCredentials, keys: DerivedKeys) async {
        var backoff: UInt64 = 1
        while !Task.isCancelled {
            do {
                var request = URLRequest(url: try endpoint("events", creds: creds))
                request.setValue("Bearer " + keys.authToken, forHTTPHeaderField: "Authorization")
                request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                request.timeoutInterval = 75 // the server pings every 25 s
                let (bytes, response) = try await session.bytes(for: request)
                guard let http = response as? HTTPURLResponse else { throw SyncError.badResponse }
                guard http.statusCode == 200 else { throw SyncError.http(http.statusCode) }
                if Task.isCancelled { break }
                backoff = 1
                status = .connected
                for try await line in bytes.lines {
                    guard line.hasPrefix("data:") else { continue }
                    let value = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                    if let seq = Int64(value), seq != lastSeq {
                        pullNow()
                    }
                }
            } catch {
                if Task.isCancelled { break }
                note(error)
            }
            if Task.isCancelled { break }
            if credentials == creds { status = .offline }
            try? await Task.sleep(nanoseconds: backoff * 1_000_000_000)
            backoff = min(backoff * 2, 30)
        }
    }

    // MARK: - HTTP

    private func endpoint(_ name: String, creds: SyncCredentials, query: [URLQueryItem] = []) throws -> URL {
        guard var comps = URLComponents(string: creds.server + "/v1/accounts/" + creds.account + "/" + name) else {
            throw SyncError.invalidServer
        }
        if !query.isEmpty { comps.queryItems = query }
        guard let url = comps.url else { throw SyncError.invalidServer }
        return url
    }

    private func fetchRecords(since: Int64, creds: SyncCredentials, keys: DerivedKeys) async throws -> PullResponse {
        let url = try endpoint("records", creds: creds, query: [
            URLQueryItem(name: "since", value: String(since)),
            URLQueryItem(name: "limit", value: "500")
        ])
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        request.setValue("Bearer " + keys.authToken, forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw SyncError.badResponse }
        guard http.statusCode == 200 else { throw SyncError.http(http.statusCode) }
        return try JSONDecoder().decode(PullResponse.self, from: data)
    }

    private func postRecords(_ wires: [WireRecord], creds: SyncCredentials, keys: DerivedKeys) async throws {
        guard !wires.isEmpty else { return }
        var request = URLRequest(url: try endpoint("records", creds: creds))
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("Bearer " + keys.authToken, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(PushBody(records: wires))
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw SyncError.badResponse }
        guard http.statusCode >= 200 && http.statusCode < 300 else { throw SyncError.http(http.statusCode) }
    }

    private func note(_ error: Error) {
        if error is CancellationError { return }
        if let urlError = error as? URLError, urlError.code == .cancelled { return }
        lastError = error.localizedDescription
        if status != .unpaired && status != .connected { status = .offline }
    }

    // MARK: - Persistence

    private func scheduleSave() {
        saveDebounce?.cancel()
        saveDebounce = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            if Task.isCancelled { return }
            self?.saveNow()
        }
    }

    func saveNow() {
        saveDebounce?.cancel()
        let state = PersistedState(records: records, lastSeq: lastSeq, dirty: Array(dirty), expiries: expiries)
        guard let data = try? JSONEncoder().encode(state) else { return }
        try? data.write(to: storeURL, options: [.atomic])
    }
}
