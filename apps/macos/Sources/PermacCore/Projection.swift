import Foundation

public enum JSONValue: Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public var string: String? {
        if case .string(let value) = self { return value }
        return nil
    }
}

extension JSONValue: Decodable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON")
        }
    }
}

public struct Envelope: Decodable, Equatable, Sendable {
    public let schemaVersion: Int
    public let eventId: String
    public let taskId: String
    public let sequence: Int
    public let timestamp: String
    public let type: String
    public let payload: [String: JSONValue]

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case eventId = "event_id"
        case taskId = "task_id"
        case sequence
        case timestamp
        case type
        case payload
    }
}

public struct TaskProjection: Equatable, Sendable {
    public var state: String
    public var text: String
    public var actions: [String: String]

    public init(state: String = "queued", text: String = "", actions: [String: String] = [:]) {
        self.state = state
        self.text = text
        self.actions = actions
    }
}

public struct Projection: Equatable, Sendable {
    public var tasks: [String: TaskProjection]
    public var lastSequence: [String: Int]
    public var seen: Set<String>
    public var buffered: [String: [Int: Envelope]]
    public var schemaError: Bool

    public init(
        tasks: [String: TaskProjection] = [:],
        lastSequence: [String: Int] = [:],
        seen: Set<String> = [],
        buffered: [String: [Int: Envelope]] = [:],
        schemaError: Bool = false
    ) {
        self.tasks = tasks
        self.lastSequence = lastSequence
        self.seen = seen
        self.buffered = buffered
        self.schemaError = schemaError
    }
}

public enum Ingest {
    public static let schemaVersion = 1

    public static func envelope(_ data: Data, into projection: Projection) -> Projection {
        var projection = projection
        let probe = try? JSONDecoder().decode(SchemaProbe.self, from: data)
        if let version = probe?.schemaVersion, version != schemaVersion {
            projection.schemaError = true
            return projection
        }
        guard let event = try? JSONDecoder().decode(Envelope.self, from: data), event.schemaVersion == schemaVersion else {
            return projection
        }
        if projection.seen.contains(event.eventId) { return projection }
        projection.seen.insert(event.eventId)
        var buffer = projection.buffered[event.taskId] ?? [:]
        buffer[event.sequence] = event
        projection.buffered[event.taskId] = buffer
        var next = (projection.lastSequence[event.taskId] ?? 0) + 1
        while let queued = projection.buffered[event.taskId]?[next] {
            apply(queued, to: &projection)
            if var inner = projection.buffered[event.taskId] {
                inner.removeValue(forKey: next)
                projection.buffered[event.taskId] = inner
            }
            projection.lastSequence[event.taskId] = next
            next += 1
        }
        return projection
    }

    private static func apply(_ event: Envelope, to projection: inout Projection) {
        var task = projection.tasks[event.taskId] ?? TaskProjection()
        switch event.type {
        case "task.state_changed":
            if let state = event.payload["to"]?.string { task.state = state }
        case "message.delta":
            if let text = event.payload["text"]?.string { task.text += text }
        case "tool.started":
            if let action = event.payload["action_id"]?.string, task.actions[action] == nil {
                task.actions[action] = "executing"
            }
        case "tool.completed":
            if let action = event.payload["action_id"]?.string, let state = event.payload["state"]?.string {
                task.actions[action] = state
            }
        case "run.finished":
            if let state = event.payload["state"]?.string { task.state = state }
        default:
            break
        }
        projection.tasks[event.taskId] = task
    }
}

private struct SchemaProbe: Decodable {
    let schemaVersion: Int
    enum CodingKeys: String, CodingKey { case schemaVersion = "schema_version" }
}

public let knownLimitations = [
    "Desktop control is limited to registered workflows. Shell, browser, and generic typing stay disabled.",
    "A desktop click has no provider idempotency key. An unknown send is not repeated automatically.",
    "Voice accuracy is only as good as the measured corpus. Wake word failure leaves text and push-to-talk usable.",
    "This build does not claim Mac App Store distribution or generalized computer control.",
]
