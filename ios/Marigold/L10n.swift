import Foundation

/// Tiny two-language helper: Japanese when the preferred language is Japanese, else English.
enum L10n {
    static let isJapanese: Bool = (Locale.preferredLanguages.first ?? "en").hasPrefix("ja")

    static func t(_ en: String, _ ja: String) -> String {
        return isJapanese ? ja : en
    }
}
