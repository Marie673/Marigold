import Foundation

// Typed views over the `data` of synced records. Field names match docs/sync-protocol.md.
// Each `data(merging:)` starts from the existing object so unknown fields survive.

struct Profile: Identifiable, Equatable {
    var id: String
    var name: String
    var color: String
    var icon: String
    var order: Double

    init(id: String, name: String, color: String, icon: String, order: Double) {
        self.id = id
        self.name = name
        self.color = color
        self.icon = icon
        self.order = order
    }

    init?(record: SyncRecord) {
        guard record.collection == "profile", !record.deleted, record.data.objectValue != nil else { return nil }
        id = record.key
        name = record.data["name"]?.stringValue ?? "Profile"
        color = record.data["color"]?.stringValue ?? "#f5a623"
        icon = record.data["icon"]?.stringValue ?? "🌼"
        order = record.data["order"]?.doubleValue ?? 0
    }

    func data(merging existing: JSONValue? = nil) -> JSONValue {
        var obj = existing?.objectValue ?? [:]
        obj["name"] = .string(name)
        obj["color"] = .string(color)
        obj["icon"] = .string(icon)
        obj["order"] = .number(order)
        return .object(obj)
    }
}

struct BrowserTab: Identifiable, Equatable {
    var id: String
    var profileId: String
    var url: String
    var title: String
    var faviconUrl: String?
    var pinned: Bool
    var order: Double
    var createdAt: Int64
    var lastActiveAt: Int64
    var archivedAt: Int64?

    init(id: String, profileId: String, url: String, title: String, faviconUrl: String?, pinned: Bool,
         order: Double, createdAt: Int64, lastActiveAt: Int64, archivedAt: Int64?) {
        self.id = id
        self.profileId = profileId
        self.url = url
        self.title = title
        self.faviconUrl = faviconUrl
        self.pinned = pinned
        self.order = order
        self.createdAt = createdAt
        self.lastActiveAt = lastActiveAt
        self.archivedAt = archivedAt
    }

    init?(record: SyncRecord) {
        guard record.collection == "tab", !record.deleted, record.data.objectValue != nil else { return nil }
        guard let pid = record.data["profileId"]?.stringValue else { return nil }
        id = record.key
        profileId = pid
        url = record.data["url"]?.stringValue ?? ""
        title = record.data["title"]?.stringValue ?? ""
        faviconUrl = record.data["faviconUrl"]?.stringValue
        pinned = record.data["pinned"]?.boolValue ?? false
        order = record.data["order"]?.doubleValue ?? 0
        createdAt = record.data["createdAt"]?.int64Value ?? record.updatedAt
        lastActiveAt = record.data["lastActiveAt"]?.int64Value ?? record.updatedAt
        archivedAt = record.data["archivedAt"]?.int64Value
    }

    /// `faviconUrl` and `archivedAt` are always written, as explicit null when absent.
    func data(merging existing: JSONValue? = nil) -> JSONValue {
        var obj = existing?.objectValue ?? [:]
        obj["profileId"] = .string(profileId)
        obj["url"] = .string(url)
        obj["title"] = .string(title)
        obj["faviconUrl"] = JSONValue.optionalString(faviconUrl)
        obj["pinned"] = .bool(pinned)
        obj["order"] = .number(order)
        obj["createdAt"] = JSONValue.int(createdAt)
        obj["lastActiveAt"] = JSONValue.int(lastActiveAt)
        obj["archivedAt"] = JSONValue.optionalInt(archivedAt)
        return .object(obj)
    }

    var isBlank: Bool {
        return url.isEmpty || url == "about:blank"
    }

    var host: String {
        guard let h = URL(string: url)?.host else { return "" }
        return h.hasPrefix("www.") ? String(h.dropFirst(4)) : h
    }

    var displayTitle: String {
        if !title.isEmpty { return title }
        if isBlank { return L10n.t("New Tab", "新しいタブ") }
        return host.isEmpty ? url : host
    }

    var faviconURL: URL? {
        if let f = faviconUrl, let u = URL(string: f), u.scheme == "http" || u.scheme == "https" { return u }
        return BrowserTab.defaultFavicon(for: url).flatMap { URL(string: $0) }
    }

    static func defaultFavicon(for pageURL: String) -> String? {
        guard let u = URL(string: pageURL), let scheme = u.scheme, scheme == "http" || scheme == "https",
              let host = u.host, !host.isEmpty else { return nil }
        var out = scheme + "://" + host
        if let port = u.port { out += ":\(port)" }
        return out + "/favicon.ico"
    }
}

struct AppSettings: Equatable {
    static let defaultArchiveAfterMs: Int64 = 86_400_000

    /// Unpinned tabs idle for longer than this are archived. 0 = never.
    var archiveAfterMs: Int64 = AppSettings.defaultArchiveAfterMs
    var searchEngine: String = "google"

    init() {}

    init(record: SyncRecord?) {
        guard let record = record, !record.deleted else { return }
        if let ms = record.data["archiveAfterMs"]?.int64Value, ms >= 0 { archiveAfterMs = ms }
        if let engine = record.data["searchEngine"]?.stringValue, !engine.isEmpty { searchEngine = engine }
    }

    func data(merging existing: JSONValue? = nil) -> JSONValue {
        var obj = existing?.objectValue ?? [:]
        obj["archiveAfterMs"] = JSONValue.int(archiveAfterMs)
        obj["searchEngine"] = .string(searchEngine)
        return .object(obj)
    }

    func searchURL(for query: String) -> URL? {
        let base: String
        switch searchEngine {
        case "duckduckgo": base = "https://duckduckgo.com/"
        case "bing": base = "https://www.bing.com/search"
        default: base = "https://www.google.com/search"
        }
        var comps = URLComponents(string: base)
        comps?.queryItems = [URLQueryItem(name: "q", value: query)]
        if let encoded = comps?.percentEncodedQuery {
            comps?.percentEncodedQuery = encoded.replacingOccurrences(of: "+", with: "%2B")
        }
        return comps?.url
    }
}

/// One LLM provider offered by a desktop (from `device` records).
struct AIProviderOption: Identifiable, Equatable {
    var deviceId: String
    var deviceName: String
    var providerId: String
    var providerLabel: String

    var id: String { deviceId + "/" + providerId }
    var title: String { providerLabel + " — " + deviceName }
}

enum DeviceRecords {
    static func providers(from records: [SyncRecord]) -> [AIProviderOption] {
        var out: [AIProviderOption] = []
        let devices = records
            .filter { $0.collection == "device" && !$0.deleted }
            .sorted { ($0.data["lastSeenAt"]?.int64Value ?? 0) > ($1.data["lastSeenAt"]?.int64Value ?? 0) }
        for rec in devices {
            guard let providers = rec.data["aiProviders"]?.arrayValue, !providers.isEmpty else { continue }
            let name = rec.data["name"]?.stringValue ?? rec.key
            for p in providers {
                guard let pid = p["id"]?.stringValue else { continue }
                out.append(AIProviderOption(deviceId: rec.key, deviceName: name, providerId: pid,
                                            providerLabel: p["label"]?.stringValue ?? pid))
            }
        }
        return out
    }
}
