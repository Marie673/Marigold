import SwiftUI
import WebKit

/// One tab: address field, web view, bottom toolbar.
@MainActor
struct BrowserView: View {
    @EnvironmentObject private var browser: BrowserModel
    @EnvironmentObject private var sync: SyncEngine
    let tab: BrowserTab
    @ObservedObject var controller: WebTabController

    @State private var addressText: String = ""
    @State private var showAI = false
    @FocusState private var addressFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            addressBar
            ZStack {
                WebViewContainer(webView: controller.webView)
                if controller.currentURL == nil && tab.isBlank {
                    startPage
                } else if let message = controller.loadError, !controller.isLoading {
                    errorPage(message)
                }
            }
            bottomBar
        }
        .background(Color(.systemBackground))
        .onAppear {
            addressText = displayAddress
        }
        .task {
            if tab.isBlank {
                try? await Task.sleep(nanoseconds: 400_000_000)
                addressFocused = true
            }
        }
        .onChange(of: controller.currentURL) { _, _ in
            if !addressFocused { addressText = displayAddress }
        }
        .onChange(of: addressFocused) { _, focused in
            addressText = focused ? fullAddress : displayAddress
        }
        .sheet(isPresented: $showAI) {
            AIPanelView(chat: browser.chat, controller: controller)
                .environmentObject(browser)
                .environmentObject(sync)
                .tint(browser.accentColor)
                .presentationDetents([.medium, .large])
        }
    }

    // MARK: Address

    private var fullAddress: String {
        if let url = controller.currentURL, url.absoluteString != "about:blank" { return url.absoluteString }
        return tab.isBlank ? "" : tab.url
    }

    private var displayAddress: String {
        let full = fullAddress
        guard let host = URL(string: full)?.host else { return full }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    private func submitAddress() {
        let input = addressText
        addressFocused = false
        browser.navigate(tabId: tab.id, input: input)
    }

    private var addressBar: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: controller.currentURL?.scheme == "https" ? "lock.fill" : "magnifyingglass")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                TextField(L10n.t("Search or enter address", "検索またはアドレスを入力"), text: $addressText)
                    .focused($addressFocused)
                    .keyboardType(.webSearch)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled(true)
                    .submitLabel(.go)
                    .onSubmit {
                        submitAddress()
                    }
                if addressFocused {
                    if !addressText.isEmpty {
                        Button {
                            addressText = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.secondary)
                        }
                    }
                } else if controller.isLoading {
                    Button {
                        controller.stop()
                    } label: {
                        Image(systemName: "xmark")
                    }
                } else if controller.currentURL != nil || !tab.isBlank {
                    Button {
                        controller.reload()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .padding(.horizontal, 12)
            .padding(.vertical, 6)

            ZStack {
                Divider()
                if controller.isLoading {
                    ProgressView(value: min(max(controller.progress, 0), 1))
                        .progressViewStyle(.linear)
                }
            }
            .frame(height: 2)
        }
        .background(.bar)
    }

    // MARK: Overlays

    private var startPage: some View {
        VStack(spacing: 12) {
            Text(browser.currentProfile?.icon ?? "🌼")
                .font(.system(size: 56))
            Text(L10n.t("Search or enter an address above", "上の欄で検索、またはアドレスを入力"))
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
    }

    private func errorPage(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
            Text(L10n.t("This page could not be loaded", "ページを読み込めませんでした"))
                .font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button(L10n.t("Try Again", "再試行")) {
                controller.reload()
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
    }

    // MARK: Toolbar

    private var bottomBar: some View {
        HStack(spacing: 0) {
            barButton("chevron.backward", L10n.t("Back", "戻る"), enabled: controller.canGoBack) {
                controller.goBack()
            }
            barButton("chevron.forward", L10n.t("Forward", "進む"), enabled: controller.canGoForward) {
                controller.goForward()
            }
            Group {
                if let url = controller.currentURL, url.absoluteString != "about:blank" {
                    ShareLink(item: url) {
                        Image(systemName: "square.and.arrow.up")
                            .font(.system(size: 19))
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                } else {
                    Image(systemName: "square.and.arrow.up")
                        .font(.system(size: 19))
                        .foregroundStyle(.tertiary)
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
            }
            Menu {
                Button {
                    browser.newTab()
                } label: {
                    Label(L10n.t("New Tab", "新しいタブ"), systemImage: "plus")
                }
                Button {
                    browser.togglePin(tab.id)
                } label: {
                    if tab.pinned {
                        Label(L10n.t("Unpin", "ピン留めを解除"), systemImage: "pin.slash")
                    } else {
                        Label(L10n.t("Pin", "ピン留め"), systemImage: "pin")
                    }
                }
                Button(role: .destructive) {
                    browser.close(tab.id)
                } label: {
                    Label(L10n.t("Close Tab", "タブを閉じる"), systemImage: "xmark")
                }
            } label: {
                Image(systemName: "square.on.square")
                    .font(.system(size: 19))
                    .frame(maxWidth: .infinity, minHeight: 44)
            } primaryAction: {
                browser.showSwitcher()
            }
            .accessibilityLabel(L10n.t("Tabs", "タブ"))
            barButton("sparkles", L10n.t("Assistant", "アシスタント"), enabled: true) {
                addressFocused = false
                showAI = true
            }
        }
        .padding(.horizontal, 4)
        .padding(.top, 2)
        .background(.bar)
    }

    private func barButton(_ systemName: String, _ label: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 19))
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .disabled(!enabled)
        .accessibilityLabel(label)
    }
}
