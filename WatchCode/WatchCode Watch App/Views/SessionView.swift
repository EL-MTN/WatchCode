import SwiftUI
import WatchKit

struct SessionView: View {
    @Environment(RelayClient.self) private var client
    @Environment(\.dismiss) private var dismiss
    let sessionId: String
    @State private var messageText = ""
    @State private var showingInput = false

    var body: some View {
        VStack(spacing: 0) {
            switch client.connectionState {
            case .connecting where client.events.isEmpty:
                connectingState
            case .error where client.events.isEmpty:
                errorState
            default:
                eventFeed
            }
        }
        .navigationTitle(navigationTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if client.isConnected {
                ToolbarItemGroup(placement: .bottomBar) {
                    Button {
                        showingInput = true
                    } label: {
                        Image(systemName: "mic.fill")
                    }
                    .tint(.blue)

                    Button {
                        WKInterfaceDevice.current().play(.stop)
                        Task { await client.sendInterrupt() }
                    } label: {
                        Image(systemName: "stop.fill")
                    }
                    .tint(.red)

                    Button {
                        Task {
                            await client.disconnect()
                            dismiss()
                        }
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                    }
                    .tint(.secondary)
                }
            }
        }
        .sheet(isPresented: $showingInput) {
            messageInputSheet
        }
        .task {
            await client.connect(sessionId: sessionId)
        }
        .onDisappear {
            Task { await client.disconnect() }
        }
    }

    private var navigationTitle: String {
        switch client.connectionState {
        case .connected: "Connected"
        case .connecting: "Connecting..."
        case .error: "Error"
        case .disconnected: "Disconnected"
        }
    }

    // MARK: - Message Input Sheet

    private var messageInputSheet: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Dictate or type...", text: $messageText)
                }
            }
            .navigationTitle("Message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        let text = messageText.trimmingCharacters(in: .whitespaces)
                        guard !text.isEmpty else { return }
                        messageText = ""
                        showingInput = false
                        WKInterfaceDevice.current().play(.click)
                        Task { await client.sendMessage(text) }
                    } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .foregroundStyle(.blue)
                    }
                    .disabled(messageText.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        messageText = ""
                        showingInput = false
                    } label: {
                        Image(systemName: "xmark")
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    // MARK: - States

    private var connectingState: some View {
        VStack(spacing: 8) {
            Spacer()
            ProgressView()
                .scaleEffect(1.2)
            Text("Connecting...")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Spacer()
        }
    }

    private var errorState: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "wifi.exclamationmark")
                .font(.title2)
                .foregroundStyle(.red)
            Text("Connection Failed")
                .font(.caption)
                .fontWeight(.medium)
            Button {
                Task { await client.connect(sessionId: sessionId) }
            } label: {
                Label("Retry", systemImage: "arrow.clockwise")
                    .font(.caption2)
            }
            .buttonStyle(.borderedProminent)
            .tint(.blue)
            Spacer()
        }
    }

    // MARK: - Event Feed

    /// Merge consecutive tool_use + tool_result pairs into combined display events
    private var displayEvents: [DisplayEvent] {
        var result: [DisplayEvent] = []
        let events = client.events

        var i = 0
        while i < events.count {
            let event = events[i]

            if event.type == .tool_use {
                // Look ahead for a matching tool_result
                if i + 1 < events.count && events[i + 1].type == .tool_result {
                    let toolResult = events[i + 1]
                    result.append(DisplayEvent(
                        id: event.id,
                        toolUse: event,
                        toolResult: toolResult
                    ))
                    i += 2
                    continue
                }
            }

            // Skip standalone tool_result that was already merged
            // (shouldn't happen with the lookahead, but defensive)
            if event.type == .tool_result {
                // Standalone result — show it
                result.append(DisplayEvent(id: event.id, event: event))
            } else {
                result.append(DisplayEvent(id: event.id, event: event))
            }
            i += 1
        }
        return result
    }

    private var eventFeed: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    if client.connectionState == .error {
                        ConnectionBanner(state: .error) {
                            Task { await client.connect(sessionId: sessionId) }
                        }
                    }

                    ForEach(displayEvents) { item in
                        if let toolUse = item.toolUse, let toolResult = item.toolResult {
                            ToolEventRow(toolUse: toolUse, toolResult: toolResult)
                        } else if let event = item.event {
                            EventRow(event: event)
                        }
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 4)
            }
            .onChange(of: client.events.count) {
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo("bottom")
                }
            }
        }
    }
}

// MARK: - Display Event (merges tool_use + tool_result)

struct DisplayEvent: Identifiable {
    let id: UUID
    var event: WatchEvent?
    var toolUse: WatchEvent?
    var toolResult: WatchEvent?

    init(id: UUID, event: WatchEvent) {
        self.id = id
        self.event = event
    }

    init(id: UUID, toolUse: WatchEvent, toolResult: WatchEvent) {
        self.id = id
        self.toolUse = toolUse
        self.toolResult = toolResult
    }
}

// MARK: - Tool Event Row (combined tool_use + tool_result)

struct ToolEventRow: View {
    let toolUse: WatchEvent
    let toolResult: WatchEvent
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Collapsed: tool name + detail + result summary
            Button {
                withAnimation(.easeInOut(duration: 0.15)) {
                    expanded.toggle()
                }
            } label: {
                HStack(alignment: .top, spacing: 6) {
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(Color.orange.gradient)
                        .frame(width: 3)

                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 4) {
                            Image(systemName: "wrench.fill")
                                .font(.system(size: 7))
                                .foregroundStyle(.orange)

                            Text(toolUse.content)
                                .font(.system(size: 9, weight: .bold, design: .monospaced))
                                .foregroundStyle(.orange)

                            Spacer()

                            Image(systemName: expanded ? "chevron.up" : "chevron.down")
                                .font(.system(size: 7))
                                .foregroundStyle(.tertiary)
                        }

                        if let detail = toolUse.detail, !detail.isEmpty {
                            Text(detail)
                                .font(.system(size: 10))
                                .foregroundStyle(.secondary)
                                .lineLimit(expanded ? nil : 1)
                        }

                        if !expanded {
                            Text(toolResult.summary ?? toolResult.displayText)
                                .font(.system(size: 9))
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                        }
                    }
                }
            }
            .buttonStyle(.plain)

            // Expanded: full result content
            if expanded {
                Text(toolResult.content)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .padding(.leading, 9)
                    .padding(.top, 4)
            }
        }
        .padding(.vertical, 3)
        .padding(.horizontal, 4)
        .background(Color.orange.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
    }
}

// MARK: - Connection Banner

struct ConnectionBanner: View {
    let state: ConnectionState
    var onRetry: (() -> Void)?

    var body: some View {
        if state == .error {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.caption2)
                    .foregroundStyle(.yellow)
                Text("Connection lost")
                    .font(.system(size: 10, weight: .medium))
                Spacer()
                if let onRetry {
                    Button("Retry", action: onRetry)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.blue)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(.yellow.opacity(0.15), in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

// MARK: - Event Row (non-tool events)

struct EventRow: View {
    let event: WatchEvent
    @State private var expanded = false

    private var isExpandable: Bool {
        event.type == .assistant && event.content.count > 150
    }

    var body: some View {
        Button {
            guard isExpandable else { return }
            withAnimation(.easeInOut(duration: 0.15)) {
                expanded.toggle()
            }
        } label: {
            HStack(alignment: .top, spacing: 6) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(event.color.gradient)
                    .frame(width: 3)

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Image(systemName: event.icon)
                            .font(.system(size: 7))
                            .foregroundStyle(event.color)

                        Text(event.label)
                            .font(.system(size: 9, weight: .bold, design: .monospaced))
                            .foregroundStyle(event.color)

                        if isExpandable {
                            Spacer()
                            Image(systemName: expanded ? "chevron.up" : "chevron.down")
                                .font(.system(size: 7))
                                .foregroundStyle(.tertiary)
                        }
                    }

                    if expanded {
                        Text(event.content)
                            .font(.system(size: 11))
                            .foregroundStyle(.primary)
                    } else {
                        Text(event.displayText)
                            .font(.system(size: 11))
                            .lineLimit(event.type == .assistant ? 4 : 3)
                            .foregroundStyle(.primary)
                    }

                    if let detail = event.detail {
                        Text(detail)
                            .font(.system(size: 9))
                            .foregroundStyle(.tertiary)
                            .lineLimit(expanded ? nil : 2)
                    }
                }
            }
        }
        .buttonStyle(.plain)
        .padding(.vertical, 3)
        .padding(.horizontal, 4)
        .background(event.color.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
    }
}
