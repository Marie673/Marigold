import SwiftUI

/// Home screen: pinned tabs (grid), open tabs (list), archive, profile switcher.
@MainActor
struct TabSwitcherView: View {
    @EnvironmentObject private var browser: BrowserModel
    @EnvironmentObject private var sync: SyncEngine
    @State private var showSettings = false

    private let pinnedColumns = [GridItem(.adaptive(minimum: 76), spacing: 12)]

    var body: some View {
        let pinned = browser.pinnedTabs
        let open = browser.openTabs
        let archivedCount = browser.archivedTabs.count

        NavigationStack {
            List {
                if !pinned.isEmpty {
                    Section(L10n.t("Pinned", "ピン留め")) {
                        LazyVGrid(columns: pinnedColumns, alignment: .leading, spacing: 12) {
                            ForEach(pinned) { tab in
                                PinnedTile(tab: tab)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }

                Section(L10n.t("Tabs", "タブ")) {
                    if open.isEmpty {
                        Text(L10n.t("No open tabs", "開いているタブはありません"))
                            .foregroundStyle(.secondary)
                    }
                    ForEach(open) { tab in
                        TabRow(tab: tab)
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                Button(role: .destructive) {
                                    browser.close(tab.id)
                                } label: {
                                    Label(L10n.t("Close", "閉じる"), systemImage: "xmark")
                                }
                                Button {
                                    browser.archive(tab.id)
                                } label: {
                                    Label(L10n.t("Archive", "アーカイブ"), systemImage: "archivebox")
                                }
                                .tint(.indigo)
                            }
                            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                                Button {
                                    browser.togglePin(tab.id)
                                } label: {
                                    Label(L10n.t("Pin", "ピン留め"), systemImage: "pin")
                                }
                                .tint(.orange)
                            }
                    }
                }

                Section {
                    NavigationLink {
                        ArchiveView()
                    } label: {
                        Label(L10n.t("Archive", "アーカイブ"), systemImage: "archivebox")
                    }
                    .badge(archivedCount)
                }
            }
            .listStyle(.insetGrouped)
            .refreshable {
                await sync.pullNow()
            }
            .navigationTitle(browser.currentProfile?.name ?? "Marigold")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    profileMenu
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: sync.isPaired && sync.status != .connected
                              ? "exclamationmark.arrow.triangle.2.circlepath" : "gearshape")
                    }
                    .accessibilityLabel(L10n.t("Settings", "設定"))
                }
                ToolbarItem(placement: .bottomBar) {
                    Button {
                        browser.newTab()
                    } label: {
                        Label(L10n.t("New Tab", "新しいタブ"), systemImage: "plus")
                            .labelStyle(.titleAndIcon)
                    }
                }
            }
            .sheet(isPresented: $showSettings) {
                SettingsView()
                    .environmentObject(browser)
                    .environmentObject(sync)
                    .tint(browser.accentColor)
            }
        }
    }

    private var profileMenu: some View {
        let current = browser.currentProfile
        return Menu {
            ForEach(browser.profiles) { profile in
                Button {
                    browser.switchProfile(profile.id)
                } label: {
                    if profile.id == current?.id {
                        Label(profile.icon + " " + profile.name, systemImage: "checkmark")
                    } else {
                        Text(profile.icon + " " + profile.name)
                    }
                }
            }
        } label: {
            Text(current?.icon ?? "🌼")
                .font(.title3)
                .frame(width: 34, height: 34)
                .background(browser.accentColor.opacity(0.2), in: Circle())
        }
        .accessibilityLabel(L10n.t("Profiles", "プロファイル"))
    }
}

@MainActor
struct TabRow: View {
    @EnvironmentObject private var browser: BrowserModel
    let tab: BrowserTab

    var body: some View {
        Button {
            browser.open(tab.id)
        } label: {
            HStack(spacing: 12) {
                FaviconView(tab: tab, size: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(tab.displayTitle)
                        .lineLimit(1)
                        .foregroundStyle(.primary)
                    if !tab.host.isEmpty {
                        Text(tab.host)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button {
                browser.togglePin(tab.id)
            } label: {
                Label(L10n.t("Pin", "ピン留め"), systemImage: "pin")
            }
            Button {
                browser.archive(tab.id)
            } label: {
                Label(L10n.t("Archive", "アーカイブ"), systemImage: "archivebox")
            }
            Button(role: .destructive) {
                browser.close(tab.id)
            } label: {
                Label(L10n.t("Close", "閉じる"), systemImage: "xmark")
            }
        }
    }
}

@MainActor
struct PinnedTile: View {
    @EnvironmentObject private var browser: BrowserModel
    let tab: BrowserTab

    var body: some View {
        Button {
            browser.open(tab.id)
        } label: {
            VStack(spacing: 6) {
                FaviconView(tab: tab, size: 36)
                Text(tab.displayTitle)
                    .font(.caption2)
                    .lineLimit(1)
                    .foregroundStyle(.primary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .padding(.horizontal, 6)
            .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button {
                browser.togglePin(tab.id)
            } label: {
                Label(L10n.t("Unpin", "ピン留めを解除"), systemImage: "pin.slash")
            }
            Button(role: .destructive) {
                browser.close(tab.id)
            } label: {
                Label(L10n.t("Close", "閉じる"), systemImage: "xmark")
            }
        }
    }
}

@MainActor
struct FaviconView: View {
    let tab: BrowserTab
    var size: CGFloat = 28

    var body: some View {
        Group {
            if let url = tab.faviconURL {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image
                            .resizable()
                            .scaledToFit()
                    } else {
                        fallback
                    }
                }
            } else {
                fallback
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
    }

    private var fallback: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
                .fill(Color.secondary.opacity(0.18))
            Text(letter)
                .font(.system(size: size * 0.5, weight: .semibold, design: .rounded))
                .foregroundStyle(.secondary)
        }
    }

    private var letter: String {
        let source = tab.host.isEmpty ? tab.displayTitle : tab.host
        guard let first = source.first else { return "•" }
        return String(first).uppercased()
    }
}

/// Archived tabs of the current profile.
@MainActor
struct ArchiveView: View {
    @EnvironmentObject private var browser: BrowserModel

    var body: some View {
        let archived = browser.archivedTabs
        Group {
            if archived.isEmpty {
                ContentUnavailableView {
                    Label(L10n.t("Archive is empty", "アーカイブは空です"), systemImage: "archivebox")
                } description: {
                    Text(L10n.t("Tabs you have not used for a while are moved here automatically.",
                                "しばらく使っていないタブは自動的にここへ移動します。"))
                }
            } else {
                List {
                    ForEach(archived) { tab in
                        Button {
                            browser.open(tab.id) // restores and opens
                        } label: {
                            HStack(spacing: 12) {
                                FaviconView(tab: tab, size: 28)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(tab.displayTitle)
                                        .lineLimit(1)
                                        .foregroundStyle(.primary)
                                    Text(ArchiveView.subtitle(for: tab))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                                Spacer(minLength: 0)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            Button(role: .destructive) {
                                browser.close(tab.id)
                            } label: {
                                Label(L10n.t("Delete", "削除"), systemImage: "trash")
                            }
                        }
                        .swipeActions(edge: .leading, allowsFullSwipe: true) {
                            Button {
                                browser.restore(tab.id)
                            } label: {
                                Label(L10n.t("Restore", "復元"), systemImage: "arrow.uturn.backward")
                            }
                            .tint(.green)
                        }
                    }
                }
                .listStyle(.insetGrouped)
            }
        }
        .navigationTitle(L10n.t("Archive", "アーカイブ"))
        .navigationBarTitleDisplayMode(.inline)
    }

    static func subtitle(for tab: BrowserTab) -> String {
        var parts: [String] = []
        if !tab.host.isEmpty { parts.append(tab.host) }
        if let at = tab.archivedAt {
            let date = Date(timeIntervalSince1970: Double(at) / 1000.0)
            let formatter = RelativeDateTimeFormatter()
            formatter.unitsStyle = .short
            parts.append(formatter.localizedString(for: date, relativeTo: Date()))
        }
        return parts.joined(separator: " · ")
    }
}
