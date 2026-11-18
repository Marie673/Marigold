import SwiftUI
import UIKit

/// Pairing, sync status, device name, auto-archive interval.
@MainActor
struct SettingsView: View {
    @EnvironmentObject private var browser: BrowserModel
    @EnvironmentObject private var sync: SyncEngine
    @Environment(\.dismiss) private var dismiss

    @State private var linkText: String = ""
    @State private var pairingError: String?
    @State private var deviceName: String = ""
    @State private var confirmDisconnect = false

    private static let archiveOptions: [Int64] = [43_200_000, 86_400_000, 604_800_000, 2_592_000_000, 0]

    var body: some View {
        NavigationStack {
            Form {
                syncSection
                deviceSection
                archiveSection
            }
            .navigationTitle(L10n.t("Settings", "設定"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(L10n.t("Done", "完了")) {
                        commitDeviceName()
                        dismiss()
                    }
                }
            }
            .onAppear {
                deviceName = sync.deviceName
            }
            .onDisappear {
                commitDeviceName()
            }
            .confirmationDialog(
                L10n.t("Disconnect from sync?", "同期を解除しますか？"),
                isPresented: $confirmDisconnect,
                titleVisibility: .visible
            ) {
                Button(L10n.t("Disconnect", "同期を解除"), role: .destructive) {
                    browser.disconnect()
                }
                Button(L10n.t("Cancel", "キャンセル"), role: .cancel) {}
            } message: {
                Text(L10n.t("Your tabs stay on this device but stop syncing.",
                            "タブはこのデバイスに残りますが、同期されなくなります。"))
            }
        }
    }

    // MARK: Sync

    @ViewBuilder
    private var syncSection: some View {
        if let creds = sync.credentials {
            Section {
                HStack {
                    Text(L10n.t("Status", "状態"))
                    Spacer()
                    Circle()
                        .fill(statusColor)
                        .frame(width: 9, height: 9)
                    Text(statusText)
                        .foregroundStyle(.secondary)
                }
                HStack {
                    Text(L10n.t("Server", "サーバー"))
                    Spacer()
                    Text(creds.server)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                HStack {
                    Text(L10n.t("Last sync", "最終同期"))
                    Spacer()
                    Text(lastSyncText)
                        .foregroundStyle(.secondary)
                }
                if let error = sync.lastError {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
                Button(L10n.t("Sync Now", "今すぐ同期")) {
                    sync.pullNow()
                }
                Button(L10n.t("Disconnect", "同期を解除"), role: .destructive) {
                    confirmDisconnect = true
                }
            } header: {
                Text(L10n.t("Sync", "同期"))
            }
        } else {
            Section {
                TextField("marigold://sync?…", text: $linkText, axis: .vertical)
                    .lineLimit(1...4)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled(true)
                    .font(.footnote.monospaced())
                Button(L10n.t("Paste from Clipboard", "クリップボードからペースト")) {
                    if let text = UIPasteboard.general.string {
                        linkText = text
                    }
                }
                Button(L10n.t("Pair", "ペアリング")) {
                    pair()
                }
                .disabled(linkText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if let error = pairingError {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            } header: {
                Text(L10n.t("Sync", "同期"))
            } footer: {
                Text(L10n.t(
                    "On your computer, open Marigold’s sync settings and scan the QR code with the Camera app, or paste the pairing link here. Without pairing, tabs stay on this device only.",
                    "コンピュータで Marigold の同期設定を開き、QR コードをカメラで読み取るか、ペアリングリンクをここに貼り付けてください。ペアリングしない場合、タブはこのデバイスにのみ保存されます。"))
            }
        }
    }

    private var statusText: String {
        switch sync.status {
        case .connected: return L10n.t("Connected", "接続済み")
        case .connecting: return L10n.t("Connecting…", "接続中…")
        case .offline: return L10n.t("Offline", "オフライン")
        case .unpaired: return L10n.t("Not paired", "未ペアリング")
        }
    }

    private var statusColor: Color {
        switch sync.status {
        case .connected: return .green
        case .connecting: return .yellow
        case .offline: return .red
        case .unpaired: return .gray
        }
    }

    private var lastSyncText: String {
        guard let date = sync.lastSyncAt else { return L10n.t("Never", "なし") }
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .medium
        return formatter.string(from: date)
    }

    private func pair() {
        do {
            try browser.pair(link: linkText)
            linkText = ""
            pairingError = nil
        } catch {
            pairingError = error.localizedDescription
        }
    }

    // MARK: Device

    private var deviceSection: some View {
        Section {
            TextField(L10n.t("Device name", "デバイス名"), text: $deviceName)
                .submitLabel(.done)
                .onSubmit {
                    commitDeviceName()
                }
        } header: {
            Text(L10n.t("This Device", "このデバイス"))
        } footer: {
            Text(L10n.t("Shown to your other devices.", "ほかのデバイスに表示されます。"))
        }
    }

    private func commitDeviceName() {
        let name = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty && name != sync.deviceName {
            sync.deviceName = name
        }
    }

    // MARK: Auto-archive

    private var archiveSection: some View {
        let current = browser.settings.archiveAfterMs
        var options = SettingsView.archiveOptions
        if !options.contains(current) {
            options.insert(current, at: 0)
        }
        let finalOptions = options
        return Section {
            Picker(L10n.t("Archive tabs after", "タブをアーカイブ"), selection: Binding<Int64>(
                get: { browser.settings.archiveAfterMs },
                set: { browser.setArchiveAfter(ms: $0) }
            )) {
                ForEach(finalOptions, id: \.self) { ms in
                    Text(SettingsView.archiveLabel(ms)).tag(ms)
                }
            }
        } header: {
            Text(L10n.t("Tabs", "タブ"))
        } footer: {
            Text(L10n.t("Unpinned tabs you have not used for this long move to the Archive on all your devices.",
                        "この期間使っていないピン留めされていないタブは、すべてのデバイスでアーカイブに移動します。"))
        }
    }

    static func archiveLabel(_ ms: Int64) -> String {
        switch ms {
        case 0: return L10n.t("Never", "しない")
        case 43_200_000: return L10n.t("12 hours", "12 時間")
        case 86_400_000: return L10n.t("24 hours", "24 時間")
        case 604_800_000: return L10n.t("7 days", "7 日")
        case 2_592_000_000: return L10n.t("30 days", "30 日")
        default:
            let hours = Double(ms) / 3_600_000.0
            if hours >= 48 {
                let days = Int((hours / 24).rounded())
                return L10n.t("\(days) days", "\(days) 日")
            }
            let rounded = (hours * 10).rounded() / 10
            return L10n.t("\(rounded) hours", "\(rounded) 時間")
        }
    }
}
