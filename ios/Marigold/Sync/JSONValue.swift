import Foundation

/// Untyped JSON so that record `data` of any collection (including ones this
/// client does not know) round-trips untouched.
enum JSONValue: Equatable, Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let d = try? c.decode(Double.self) {
            self = .number(d)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let a = try? c.decode([JSONValue].self) {
            self = .array(a)
        } else if let o = try? c.decode([String: JSONValue].self) {
            self = .object(o)
        } else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unsupported JSON value")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null:
            try c.encodeNil()
        case .bool(let b):
            try c.encode(b)
        case .number(let d):
            if !d.isFinite {
                try c.encodeNil()
            } else if d.rounded() == d && abs(d) < 9.0e15 {
                // Whole numbers (ms timestamps etc.) must be written as integers.
                try c.encode(Int64(d))
            } else {
                try c.encode(d)
            }
        case .string(let s):
            try c.encode(s)
        case .array(let a):
            try c.encode(a)
        case .object(let o):
            try c.encode(o)
        }
    }

    // MARK: Builders

    static func int(_ value: Int64) -> JSONValue { .number(Double(value)) }

    static func optionalInt(_ value: Int64?) -> JSONValue {
        if let value = value { return .number(Double(value)) }
        return .null
    }

    static func optionalString(_ value: String?) -> JSONValue {
        if let value = value { return .string(value) }
        return .null
    }

    // MARK: Accessors

    var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    var doubleValue: Double? {
        if case .number(let d) = self { return d }
        return nil
    }

    var int64Value: Int64? {
        if case .number(let d) = self, d.isFinite, abs(d) < 9.0e18 { return Int64(d) }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    var objectValue: [String: JSONValue]? {
        if case .object(let o) = self { return o }
        return nil
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }
}
