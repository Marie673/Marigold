import SwiftUI
import Combine

@MainActor
struct AIPanelView: View {
    @EnvironmentObject private var browser: BrowserModel
    @EnvironmentObject private var sync: SyncEngine
    @ObservedObject var chat: AIChatModel
    let controller: WebTabController?

    @Environment(\.dismiss) private var dismiss
    @State private var draft: String = ""
    @FocusState private var inputFocused: Bool

    private var providers: [AIProviderOption] {
        return sync.isPaired ? browser.aiProviders : []
    }

    private var selectedProvider: AIProviderOption? {
        let all = providers
        return all.first { $0.id == chat.selectedProviderId } ?? all.first
    }

    var body: some View {
        NavigationStack {
            Group {
                if providers.isEmpty {
                    emptyState
                } else {
                    chatBody
                }
            }
            .navigationTitle(L10n.t("Assistant", "アシスタント"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        chat.clear(sync: sync)
                    } label: {
                        Image(systemName: "trash")
                    }
                    .disabled(chat.messages.isEmpty && !chat.isBusy)
                    .accessibilityLabel(L10n.t("Clear conversation", "会話を消去"))
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(L10n.t("Done", "完了")) {
                        dismiss()
                    }
                }
            }
        }
        .onReceive(sync.$records) { records in
            chat.ingest(records)
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label(L10n.t("No AI available yet", "利用できる AI がありません"), systemImage: "sparkles")
        } description: {
            Text(L10n.t(
                "The assistant runs through your computer. Open Marigold on your computer, sign in to Claude Code or Codex CLI there, and pair this device in Settings.",
                "アシスタントはコンピュータ経由で動作します。コンピュータで Marigold を開き、Claude Code または Codex CLI にサインインして、設定からこのデバイスをペアリングしてください。"))
        }
    }

    private var chatBody: some View {
        VStack(spacing: 0) {
            providerPicker
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if chat.messages.isEmpty && !chat.isBusy {
                            Text(L10n.t("Ask anything about this page, or anything else.",
                                        "このページについて、または何でも質問できます。"))
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .center)
                                .padding(.top, 32)
                        }
                        ForEach(chat.messages) { message in
                            MessageBubble(role: message.role, text: message.content)
                        }
                        if chat.isBusy {
                            if chat.streamingText.isEmpty {
                                HStack(spacing: 8) {
                                    ProgressView()
                                    Text(L10n.t("Waiting for your computer…", "コンピュータの応答を待っています…"))
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                }
                            } else {
                                MessageBubble(role: .assistant, text: chat.streamingText)
                            }
                        }
                        Color.clear
                            .frame(height: 1)
                            .id("bottom")
                    }
                    .padding(16)
                }
                .onChange(of: chat.streamingText) { _, _ in
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
                .onChange(of: chat.messages.count) { _, _ in
                    withAnimation {
                        proxy.scrollTo("bottom", anchor: .bottom)
                    }
                }
            }
            Divider()
            inputBar
        }
    }

    private var providerPicker: some View {
        HStack {
            Picker(L10n.t("Model", "モデル"), selection: Binding<String>(
                get: { selectedProvider?.id ?? "" },
                set: { chat.selectedProviderId = $0 }
            )) {
                ForEach(providers) { option in
                    Text(option.title).tag(option.id)
                }
            }
            .pickerStyle(.menu)
            Spacer()
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 2)
    }

    private var inputBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            if controller?.currentURL != nil {
                Toggle(isOn: $chat.includePage) {
                    Label(L10n.t("Include this page", "このページを含める"), systemImage: "doc.text")
                        .font(.subheadline)
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField(L10n.t("Message", "メッセージ"), text: $draft, axis: .vertical)
                    .lineLimit(1...5)
                    .focused($inputFocused)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                if chat.isBusy {
                    Button {
                        chat.stop(sync: sync)
                    } label: {
                        Image(systemName: "stop.circle.fill")
                            .font(.system(size: 30))
                    }
                    .accessibilityLabel(L10n.t("Stop", "停止"))
                } else {
                    Button {
                        send()
                    } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 30))
                    }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityLabel(L10n.t("Send", "送信"))
                }
            }
        }
        .padding(12)
        .background(.bar)
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !chat.isBusy, let provider = selectedProvider else { return }
        draft = ""
        let includePage = chat.includePage
        let pageController = controller
        let chatModel = chat
        let engine = sync
        Task { @MainActor in
            var context: PageContext? = nil
            if includePage, let c = pageController, let url = c.currentURL {
                let pageText = await c.pageText(limit: 20_000)
                if !pageText.isEmpty {
                    context = PageContext(title: c.pageTitle, url: url.absoluteString, text: pageText)
                }
            }
            chatModel.send(text, provider: provider, context: context, sync: engine)
        }
    }
}

@MainActor
struct MessageBubble: View {
    let role: ChatMessage.Role
    let text: String

    var body: some View {
        HStack {
            if role == .user { Spacer(minLength: 40) }
            content
            if role != .user { Spacer(minLength: 24) }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch role {
        case .user:
            Text(text)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .foregroundStyle(.white)
                .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .textSelection(.enabled)
        case .assistant:
            Text(MessageBubble.rendered(text))
                .textSelection(.enabled)
        case .error:
            Label(text, systemImage: "exclamationmark.triangle")
                .font(.subheadline)
                .foregroundStyle(.red)
        }
    }

    /// Inline markdown, falling back to plain text.
    static func rendered(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible)
        if let attributed = try? AttributedString(markdown: text, options: options) {
            return attributed
        }
        return AttributedString(text)
    }
}
