import Foundation
import SwiftUI
import UIKit
import WebKit
import CryptoKit

enum ProfileStore {
    /// Stable UUID for a profile id, used as its `WKWebsiteDataStore` identifier
    /// so each profile has its own cookies and logins.
    static func uuid(for profileId: String) -> UUID {
        let digest = SHA256.hash(data: Data(("marigold-profile:" + profileId).utf8))
        var b = Array(Array(digest).prefix(16))
        b[6] = (b[6] & 0x0f) | 0x40
        b[8] = (b[8] & 0x3f) | 0x80
        return UUID(uuid: (b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
                           b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]))
    }
}

/// Owns the live WKWebView of one tab and mirrors its state for SwiftUI.
@MainActor
final class WebTabController: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
    let tabId: String
    let webView: WKWebView

    @Published private(set) var currentURL: URL?
    @Published private(set) var pageTitle: String = ""
    @Published private(set) var canGoBack = false
    @Published private(set) var canGoForward = false
    @Published private(set) var isLoading = false
    @Published private(set) var progress: Double = 0
    @Published private(set) var loadError: String?

    /// (tabId, url, title) — debounced, only for http(s) pages.
    var onPageChanged: ((String, String, String) -> Void)?
    /// The URL this controller last loaded or reported for the tab record.
    private(set) var lastKnownURL: String?
    private var lastReportedTitle: String?

    private var observations: [NSKeyValueObservation] = []
    private var reportTask: Task<Void, Never>?

    init(tabId: String, profileId: String) {
        self.tabId = tabId
        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore(forIdentifier: ProfileStore.uuid(for: profileId))
        config.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        observations = [
            webView.observe(\.url, options: [.new]) { [weak self] _, _ in self?.kick() },
            webView.observe(\.title, options: [.new]) { [weak self] _, _ in self?.kick() },
            webView.observe(\.canGoBack, options: [.new]) { [weak self] _, _ in self?.kick() },
            webView.observe(\.canGoForward, options: [.new]) { [weak self] _, _ in self?.kick() },
            webView.observe(\.isLoading, options: [.new]) { [weak self] _, _ in self?.kick() },
            webView.observe(\.estimatedProgress, options: [.new]) { [weak self] _, _ in self?.kick() }
        ]
    }

    nonisolated private func kick() {
        Task { @MainActor [weak self] in
            self?.stateChanged()
        }
    }

    private func stateChanged() {
        let url = webView.url
        let title = webView.title ?? ""
        if currentURL != url { currentURL = url }
        if pageTitle != title { pageTitle = title }
        if canGoBack != webView.canGoBack { canGoBack = webView.canGoBack }
        if canGoForward != webView.canGoForward { canGoForward = webView.canGoForward }
        if isLoading != webView.isLoading { isLoading = webView.isLoading }
        if progress != webView.estimatedProgress { progress = webView.estimatedProgress }

        guard let url = url, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return }
        let urlString = url.absoluteString
        if urlString != lastKnownURL || title != lastReportedTitle {
            scheduleReport()
        }
    }

    private func scheduleReport() {
        reportTask?.cancel()
        reportTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 800_000_000)
            if Task.isCancelled { return }
            self?.report()
        }
    }

    private func report() {
        guard let url = webView.url, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return }
        let urlString = url.absoluteString
        let title = webView.title ?? ""
        lastKnownURL = urlString
        lastReportedTitle = title
        onPageChanged?(tabId, urlString, title)
    }

    // MARK: Commands

    func load(_ urlString: String) {
        guard let url = URL(string: urlString), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else { return }
        load(url)
    }

    func load(_ url: URL) {
        if loadError != nil { loadError = nil }
        lastKnownURL = url.absoluteString
        lastReportedTitle = nil
        webView.load(URLRequest(url: url))
    }

    func goBack() { webView.goBack() }
    func goForward() { webView.goForward() }
    func reload() {
        if loadError != nil { loadError = nil }
        if webView.url == nil, let last = lastKnownURL {
            load(last)
        } else {
            webView.reload()
        }
    }
    func stop() { webView.stopLoading() }

    /// Visible text of the page, truncated to `limit` characters.
    func pageText(limit: Int) async -> String {
        let view = webView
        return await withCheckedContinuation { (cont: CheckedContinuation<String, Never>) in
            view.evaluateJavaScript("document.body ? document.body.innerText : ''") { result, _ in
                let text = (result as? String) ?? ""
                cont.resume(returning: String(text.prefix(limit)))
            }
        }
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let internalSchemes: Set<String> = ["http", "https", "about", "blob", "data", "javascript"]
        if let url = navigationAction.request.url, let scheme = url.scheme?.lowercased(),
           !internalSchemes.contains(scheme) {
            // mailto:, tel:, App Store links… are handed to the system.
            if navigationAction.targetFrame == nil || navigationAction.targetFrame?.isMainFrame == true {
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
            }
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if loadError != nil { loadError = nil }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        stateChanged()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handle(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handle(error)
    }

    private func handle(_ error: Error) {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        if ns.domain == "WebKitErrorDomain" && ns.code == 102 { return } // frame load interrupted
        loadError = error.localizedDescription
    }

    // MARK: WKUIDelegate

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // target=_blank / window.open: stay in this tab.
        if navigationAction.targetFrame == nil {
            webView.load(navigationAction.request)
        }
        return nil
    }
}

/// Hosts whichever WKWebView belongs to the current controller.
struct WebViewContainer: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .systemBackground
        return container
    }

    func updateUIView(_ container: UIView, context: Context) {
        if webView.superview === container { return }
        for sub in container.subviews {
            sub.removeFromSuperview()
        }
        webView.removeFromSuperview()
        webView.frame = container.bounds
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.addSubview(webView)
    }
}

extension Color {
    /// `#rrggbb`
    init?(hex: String?) {
        guard var s = hex?.trimmingCharacters(in: .whitespaces) else { return nil }
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let value = UInt32(s, radix: 16) else { return nil }
        self.init(red: Double((value >> 16) & 0xff) / 255.0,
                  green: Double((value >> 8) & 0xff) / 255.0,
                  blue: Double(value & 0xff) / 255.0)
    }
}
