import Foundation
import SwiftUI

struct ChatMessage: Identifiable, Equatable {
    enum Role: String {
        case user
        case assistant
        case error // local only, never sent
    }

    let id = UUID()
    var role: Role
    var content: String
}

struct PageContext {
    var title: String
    var url: String
    var text: String
}

/// Chat that is relayed through a desktop: writes `aireq:<uuid>` and renders
/// `aires:<uuid>` as the desktop rewrites it.
@MainActor
final class AIChatModel: ObservableObject {
    @Published private(set) var messages: [ChatMessage] = []
    @Published private(set) var streamingText: String = ""
    @Published private(set) var pendingId: String?
    @Published var selectedProviderId: String?
    @Published var includePage: Bool = true

    private var pendingData: JSONValue = .null
    private var pendingExpiresAt: Int64 = 0
    private var timeoutTask: Task<Void, Never>?

    var isBusy: Bool { pendingId != nil }

    func send(_ text: String, provider: AIProviderOption, context: PageContext?, sync: SyncEngine) {
        guard pendingId == nil else { return }
        messages.append(ChatMessage(role: .user, content: text))

        var wireMessages: [JSONValue] = []
        for m in messages where m.role != .error {
            wireMessages.append(.object(["role": .string(m.role.rawValue), "content": .string(m.content)]))
        }
        var wireContext: [JSONValue] = []
        if let c = context {
            wireContext.append(.object(["title": .string(c.title), "url": .string(c.url), "text": .string(c.text)]))
        }
        let data: JSONValue = .object([
            "targetDeviceId": .string(provider.deviceId),
            "provider": .string(provider.providerId),
            "messages": .array(wireMessages),
            "context": .array(wireContext)
        ])
        let uuid = UUID().uuidString.lowercased()
        let expiresAt = SyncCrypto.nowMs() + 600_000
        sync.put(collection: "aireq", key: uuid, data: data, expiresAt: expiresAt)

        pendingData = data
        pendingExpiresAt = expiresAt
        streamingText = ""
        pendingId = uuid

        timeoutTask?.cancel()
        timeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 600_000_000_000)
            if Task.isCancelled { return }
            self?.timedOut(uuid)
        }
    }

    /// Feed the store's records; picks up the response for the pending request.
    func ingest(_ records: [String: SyncRecord]) {
        guard let pid = pendingId, let rec = records["aires:" + pid], !rec.deleted else { return }
        let text = rec.data["text"]?.stringValue ?? ""
        let error = rec.data["error"]?.stringValue ?? ""
        let done = rec.data["done"]?.boolValue ?? false
        if !error.isEmpty {
            finish(text: text, error: error)
        } else if done {
            finish(text: text, error: nil)
        } else if text != streamingText {
            streamingText = text
        }
    }

    /// Cancels the running request (rewrites the aireq as a tombstone).
    func stop(sync: SyncEngine) {
        guard let pid = pendingId else { return }
        sync.put(collection: "aireq", key: pid, data: pendingData, deleted: true, expiresAt: pendingExpiresAt)
        finish(text: streamingText, error: nil)
    }

    func clear(sync: SyncEngine) {
        if isBusy { stop(sync: sync) }
        messages = []
    }

    private func timedOut(_ id: String) {
        guard pendingId == id else { return }
        finish(text: streamingText,
               error: L10n.t("No response from the computer. Is Marigold running there?",
                             "コンピュータから応答がありません。Marigold は起動していますか？"))
    }

    private func finish(text: String, error: String?) {
        timeoutTask?.cancel()
        timeoutTask = nil
        if !text.isEmpty {
            messages.append(ChatMessage(role: .assistant, content: text))
        }
        if let error = error, !error.isEmpty {
            messages.append(ChatMessage(role: .error, content: error))
        }
        streamingText = ""
        pendingData = .null
        pendingId = nil
    }
}
