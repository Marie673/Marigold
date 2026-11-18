import SwiftUI

@MainActor
final class AppContainer: ObservableObject {
    let sync: SyncEngine
    let browser: BrowserModel

    init() {
        let engine = SyncEngine()
        sync = engine
        browser = BrowserModel(sync: engine)
    }
}

@main
@MainActor
struct MarigoldApp: App {
    @StateObject private var container = AppContainer()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(container.browser)
                .environmentObject(container.sync)
        }
    }
}

/// Shows the browser for the active tab, otherwise the tab switcher.
@MainActor
struct RootView: View {
    @EnvironmentObject private var browser: BrowserModel
    @EnvironmentObject private var sync: SyncEngine
    @Environment(\.scenePhase) private var scenePhase
    @State private var pairingMessage: String?

    var body: some View {
        Group {
            if let tab = browser.activeTab {
                BrowserView(tab: tab, controller: browser.controller(for: tab))
                    .id(tab.id)
            } else {
                TabSwitcherView()
            }
        }
        .tint(browser.accentColor)
        .task {
            await browser.start()
        }
        .onChange(of: scenePhase) { _, phase in
            browser.scenePhaseChanged(active: phase == .active, background: phase == .background)
        }
        .onOpenURL { url in
            // marigold://sync?server=…&account=…&key=… (e.g. from scanning the desktop's QR code)
            do {
                try browser.pair(link: url.absoluteString)
                pairingMessage = L10n.t("This device is now paired.", "このデバイスをペアリングしました。")
            } catch {
                pairingMessage = error.localizedDescription
            }
        }
        .alert(
            L10n.t("Sync", "同期"),
            isPresented: Binding<Bool>(
                get: { pairingMessage != nil },
                set: { if !$0 { pairingMessage = nil } }
            )
        ) {
            Button("OK") {}
        } message: {
            Text(pairingMessage ?? "")
        }
    }
}
