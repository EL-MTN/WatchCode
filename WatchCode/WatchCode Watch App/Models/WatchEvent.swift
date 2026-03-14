import SwiftUI

struct WatchEvent: Codable, Identifiable {
    let id: UUID
    let type: EventType
    let content: String
    let summary: String?
    let detail: String?
    let timestamp: String

    enum EventType: String, Codable {
        case user, assistant, tool_use, tool_result, status, error, raw
    }

    enum CodingKeys: String, CodingKey {
        case type, content, summary, detail, timestamp
    }

    init(type: EventType, content: String, summary: String? = nil, detail: String? = nil) {
        self.id = UUID()
        self.type = type
        self.content = content
        self.summary = summary
        self.detail = detail
        self.timestamp = ISO8601DateFormatter().string(from: Date())
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = UUID()
        self.type = try container.decode(EventType.self, forKey: .type)
        self.content = try container.decode(String.self, forKey: .content)
        self.summary = try container.decodeIfPresent(String.self, forKey: .summary)
        self.detail = try container.decodeIfPresent(String.self, forKey: .detail)
        self.timestamp = try container.decode(String.self, forKey: .timestamp)
    }

    /// Short display text for watch — uses summary if available, otherwise truncates content
    var displayText: String {
        summary ?? String(content.prefix(300))
    }

    var color: Color {
        switch type {
        case .user: return .blue
        case .assistant: return .green
        case .tool_use: return .orange
        case .tool_result: return .gray
        case .status: return .secondary
        case .error: return .red
        case .raw: return .secondary
        }
    }

    var label: String {
        switch type {
        case .user: return "YOU"
        case .assistant: return "CLAUDE"
        case .tool_use: return "TOOL"
        case .tool_result: return "RESULT"
        case .status: return "STATUS"
        case .error: return "ERROR"
        case .raw: return "RAW"
        }
    }

    var icon: String {
        switch type {
        case .user: return "person.fill"
        case .assistant: return "sparkles"
        case .tool_use: return "wrench.fill"
        case .tool_result: return "arrow.turn.down.left"
        case .status: return "info.circle.fill"
        case .error: return "exclamationmark.triangle.fill"
        case .raw: return "text.alignleft"
        }
    }
}
