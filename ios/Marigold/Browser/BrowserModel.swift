import Foundation
import SwiftUI
import Combine

/// App state on top of the sync store: profiles, tabs, live web views, auto-archive.
@MainActor
final class BrowserModel: ObservableObject {
    let sync: SyncEngine
    let chat: AIChatModel

    @Published var currentProfileId: String {
        didSet { UserDefaults.standard.set(currentProfileId, forKey: "currentProfileId") }
    }
    @Published var activeTabId: String?

    private var controllers: [String: WebTabController] = [:]
    private var lru: [String] = []
    private let maxLiveWebViews = 3
    private var cancellables = Set<AnyCancellable>()
    private var archiveTask: Task<Void, Never>?
    private var started = false

    init(sync: SyncEngine) {
        self.sync = sync
        self.chat = AIChatModel()
        _currentProfileId = Published(wrappedValue: UserDefaults.standard.string(forKey: "currentProfileId") ?? "")
        // Re-render views observing this model whenever the store changes.
        sync.objectWillChange
            .sink { [weak self] _ in
                self?.objectWillChange.send()
            }
            .store(in: &cancellables)
        sync.onPullFinished = { [weak self] success in
            self?.pullFinished(success: success)
        }
    }

    // MARK: - Lifecycle

    func start() {
        guard !started else { return }
        started = true
        sync.start()
        if !sync.isPaired || sync.initialPullDone {
            ensureDefaultProfile()
        }
        if !sync.isPaired {
            runAutoArchive()
        }
        archiveTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 60_000_000_000)
                self?.runAutoArchive()
            }
        }
    }

    func scenePhaseChanged(active: Bool, background: Bool) {
        if active {
            sync.setForeground(true) // pulls; auto-archive runs when the pull finishes
            if !sync.isPaired { runAutoArchive() }
        } else if background {
            sync.setForeground(false)
        }
    }

    private func pullFinished(success: Bool) {
        if success {
            cleanUpAutoProfile()
            ensureDefaultProfile()
            runAutoArchive()
        } else {
            // Offline on first launch: still be usable.
            ensureDefaultProfile()
        }
    }

    func pair(link: String) throws {
        try sync.pair(link: link)
    }

    func disconnect() {
        sync.disconnect()
        ensureDefaultProfile()
    }

    // MARK: - Profiles

    var profiles: [Profile] {
        return sync.liveRecords(in: "profile")
            .compactMap { Profile(record: $0) }
            .sorted { ($0.order, $0.id) < ($1.order, $1.id) }
    }

    var currentProfile: Profile? {
        let all = profiles
        return all.first { $0.id == currentProfileId } ?? all.first
    }

    var accentColor: Color {
        return Color(hex: currentProfile?.color) ?? Color.orange
    }

    func switchProfile(_ id: String) {
        guard id != currentProfileId else { return }
        activeTabId = nil
        currentProfileId = id
    }

    private func ensureDefaultProfile() {
        guard profiles.isEmpty else { return }
        let id = SyncCrypto.randomId()
        let profile = Profile(id: id, name: L10n.t("Personal", "個人"), color: "#f5a623", icon: "🌼", order: 0)
        sync.put(collection: "profile", key: id, data: profile.data())
        UserDefaults.standard.set(id, forKey: "autoProfileId")
        currentProfileId = id
    }

    /// If the default profile we created locally turned out to be redundant once
    /// the account's real profiles arrived (and it holds no tabs), remove it.
    private func cleanUpAutoProfile() {
        let defaults = UserDefaults.standard
        guard let autoId = defaults.string(forKey: "autoProfileId") else { return }
        let others = profiles.filter { $0.id != autoId }
        guard let fallback = others.first else { return }
        let hasTabs = allTabs.contains { $0.profileId == autoId }
        if !hasTabs {
            sync.delete(id: "profile:" + autoId)
            if currentProfileId == autoId { currentProfileId = fallback.id }
        }
        defaults.removeObject(forKey: "autoProfileId")
    }

    // MARK: - Settings

    var settings: AppSettings {
        return AppSettings(record: sync.record("settings:global"))
    }

    func setArchiveAfter(ms: Int64) {
        var s = settings
        guard s.archiveAfterMs != ms || sync.record("settings:global") == nil else { return }
        s.archiveAfterMs = ms
        sync.put(collection: "settings", key: "global", data: s.data(merging: sync.record("settings:global")?.data))
    }

    // MARK: - Tabs

    var allTabs: [BrowserTab] {
        return sync.liveRecords(in: "tab").compactMap { BrowserTab(record: $0) }
    }

    private var profileTabs: [BrowserTab] {
        guard let pid = currentProfile?.id else { return [] }
        return allTabs.filter { $0.profileId == pid }
    }

    var pinnedTabs: [BrowserTab] {
        return profileTabs.filter { $0.pinned && $0.archivedAt == nil }
            .sorted { ($0.order, $0.id) < ($1.order, $1.id) }
    }

    var openTabs: [BrowserTab] {
        return profileTabs.filter { !$0.pinned && $0.archivedAt == nil }
            .sorted { ($0.order, $0.id) < ($1.order, $1.id) }
    }

    var archivedTabs: [BrowserTab] {
        return profileTabs.filter { $0.archivedAt != nil }
            .sorted { ($0.archivedAt ?? 0) > ($1.archivedAt ?? 0) }
    }

    func tab(_ id: String) -> BrowserTab? {
        guard let rec = sync.record("tab:" + id) else { return nil }
        return BrowserTab(record: rec)
    }

    /// The tab shown in the browser screen, if it still exists and is not archived.
    var activeTab: BrowserTab? {
        guard let id = activeTabId, let t = tab(id), t.archivedAt == nil else { return nil }
        return t
    }

    private func write(_ tab: BrowserTab) {
        sync.put(collection: "tab", key: tab.id, data: tab.data(merging: sync.record("tab:" + tab.id)?.data))
    }

    private func update(_ id: String, _ change: (inout BrowserTab) -> Void) {
        guard var t = tab(id) else { return }
        let before = t
        change(&t)
        if t != before { write(t) }
    }

    func newTab(url: String? = nil) {
        guard let pid = currentProfile?.id else { return }
        let now = SyncCrypto.nowMs()
        let maxOrder = allTabs.map { $0.order }.max() ?? 0
        let target = url ?? "about:blank"
        let tab = BrowserTab(id: SyncCrypto.randomId(), profileId: pid, url: target, title: "",
                             faviconUrl: BrowserTab.defaultFavicon(for: target), pinned: false,
                             order: maxOrder + 1, createdAt: now, lastActiveAt: now, archivedAt: nil)
        write(tab)
        activeTabId = tab.id
    }

    func open(_ id: String) {
        guard let rec = sync.record("tab:" + id), let t = BrowserTab(record: rec) else { return }
        // Another device navigated this tab while we held a live web view for it.
        if let c = controllers[id], rec.deviceId != sync.deviceId, !t.isBlank, t.url != c.lastKnownURL {
            c.load(t.url)
        }
        let now = SyncCrypto.nowMs()
        update(id) {
            $0.lastActiveAt = now
            $0.archivedAt = nil
        }
        activeTabId = id
    }

    func showSwitcher() {
        activeTabId = nil
    }

    func close(_ id: String) {
        sync.delete(id: "tab:" + id)
        controllers.removeValue(forKey: id)
        lru.removeAll { $0 == id }
        if activeTabId == id { activeTabId = nil }
    }

    func togglePin(_ id: String) {
        update(id) { $0.pinned.toggle() }
    }

    func archive(_ id: String) {
        let now = SyncCrypto.nowMs()
        update(id) { $0.archivedAt = now }
        if activeTabId == id { activeTabId = nil }
    }

    /// Takes a tab out of the archive without opening it.
    func restore(_ id: String) {
        let now = SyncCrypto.nowMs()
        update(id) {
            $0.archivedAt = nil
            $0.lastActiveAt = now
        }
    }

    /// Archives unpinned tabs idle for longer than `settings.archiveAfterMs`.
    func runAutoArchive() {
        if sync.isPaired {
            // Only with fresh data, so we never archive a tab that was just used elsewhere.
            guard let last = sync.lastSyncAt, Date().timeIntervalSince(last) < 120 else { return }
        }
        let limit = settings.archiveAfterMs
        guard limit > 0 else { return }
        let now = SyncCrypto.nowMs()
        for t in allTabs where !t.pinned && t.archivedAt == nil && t.id != activeTabId && now - t.lastActiveAt > limit {
            update(t.id) { $0.archivedAt = now }
        }
    }

    // MARK: - Navigation

    func resolve(_ input: String) -> URL? {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if let u = URL(string: text), let scheme = u.scheme?.lowercased(),
           scheme == "http" || scheme == "https", u.host != nil {
            return u
        }
        let isLocal = text.hasPrefix("localhost")
        let looksLikeHost = !text.contains(" ") && (text.contains(".") || isLocal)
        if looksLikeHost, let u = URL(string: (isLocal ? "http://" : "https://") + text), u.host != nil {
            return u
        }
        return settings.searchURL(for: text)
    }

    func navigate(tabId: String, input: String) {
        guard let t = tab(tabId), let url = resolve(input) else { return }
        controller(for: t).load(url)
    }

    private func pageChanged(tabId: String, url: String, title: String) {
        let now = SyncCrypto.nowMs()
        update(tabId) { t in
            // Never resurrect or touch an archived tab from a background web view.
            guard t.archivedAt == nil else { return }
            if t.url != url {
                let oldHost = URL(string: t.url)?.host
                t.url = url
                if t.faviconUrl == nil || URL(string: url)?.host != oldHost {
                    t.faviconUrl = BrowserTab.defaultFavicon(for: url)
                }
                t.title = title
            } else if !title.isEmpty {
                t.title = title
            }
            t.lastActiveAt = now
        }
    }

    // MARK: - Live web views (small LRU)

    func existingController(for tabId: String) -> WebTabController? {
        return controllers[tabId]
    }

    func controller(for tab: BrowserTab) -> WebTabController {
        if let existing = controllers[tab.id] {
            touch(tab.id)
            return existing
        }
        let c = WebTabController(tabId: tab.id, profileId: tab.profileId)
        c.onPageChanged = { [weak self] id, url, title in
            self?.pageChanged(tabId: id, url: url, title: title)
        }
        controllers[tab.id] = c
        touch(tab.id)
        if !tab.isBlank {
            c.load(tab.url)
        }
        return c
    }

    private func touch(_ id: String) {
        if lru.last == id { return }
        lru.removeAll { $0 == id }
        lru.append(id)
        while lru.count > maxLiveWebViews {
            guard let victim = lru.first(where: { $0 != id && $0 != activeTabId }) else { break }
            lru.removeAll { $0 == victim }
            if let c = controllers.removeValue(forKey: victim) {
                c.stop()
            }
        }
    }

    // MARK: - AI

    var aiProviders: [AIProviderOption] {
        return DeviceRecords.providers(from: Array(sync.records.values))
    }
}
