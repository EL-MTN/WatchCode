import SwiftUI

struct SessionListView: View {
    @Environment(RelayClient.self) private var client
    @State private var loading = false

    private var liveSessions: [SessionInfo] {
        client.sessions.filter { ["running", "active", "idle"].contains($0.status) }
    }

    private var archivedSessions: [SessionInfo] {
        client.sessions.filter { $0.status == "archived" }
    }

    var body: some View {
        List {
            if loading && client.sessions.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
            } else if !loading && client.sessions.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "terminal")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                    Text("No Sessions")
                        .font(.caption)
                        .fontWeight(.medium)
                    Text("Run Claude Code with the relay server to see sessions here.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 20)
                .listRowBackground(Color.clear)
            } else {
                if !liveSessions.isEmpty {
                    Section {
                        ForEach(liveSessions) { session in
                            NavigationLink(destination: SessionView(sessionId: session.id)) {
                                SessionRow(session: session)
                            }
                        }
                    } header: {
                        Label("Live", systemImage: "bolt.fill")
                            .foregroundStyle(.green)
                            .font(.caption2.weight(.semibold))
                            .padding(.bottom, 4)
                    }
                }

                if !archivedSessions.isEmpty {
                    Section {
                        ForEach(archivedSessions.prefix(10)) { session in
                            NavigationLink(destination: SessionView(sessionId: session.id)) {
                                SessionRow(session: session)
                            }
                        }
                    } header: {
                        Label("Recent", systemImage: "clock")
                            .foregroundStyle(.secondary)
                            .font(.caption2.weight(.semibold))
                            .padding(.bottom, 4)
                    }
                }
            }
        }
        .navigationTitle("")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    Task {
                        loading = true
                        await client.fetchSessions()
                        loading = false
                    }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .disabled(loading)
            }
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(destination: SettingsView()) {
                    Image(systemName: "gear")
                }
            }
        }
        .task {
            loading = true
            await client.fetchSessions()
            loading = false
        }
    }
}

// MARK: - Session Row

struct SessionRow: View {
    let session: SessionInfo

    private var isLive: Bool {
        ["running", "active", "idle"].contains(session.status)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(session.title)
                .font(.caption)
                .fontWeight(.medium)
                .lineLimit(2)

            HStack(spacing: 6) {
                StatusBadge(status: session.status)

                Text(session.model)
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)

                Spacer()

                Text(relativeTime(from: session.updatedAt))
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Status Badge

struct StatusBadge: View {
    let status: String
    @State private var isPulsing = false

    private var isLive: Bool {
        ["running", "active"].contains(status)
    }

    private var statusColor: Color {
        switch status {
        case "running", "active": return .green
        case "idle": return .yellow
        default: return .gray
        }
    }

    var body: some View {
        HStack(spacing: 3) {
            Circle()
                .fill(statusColor)
                .frame(width: 5, height: 5)
                .opacity(isPulsing ? 0.4 : 1.0)
                .animation(
                    isLive
                        ? .easeInOut(duration: 0.8).repeatForever(autoreverses: true)
                        : .default,
                    value: isPulsing
                )
                .onAppear { isPulsing = isLive }

            Text(status.uppercased())
                .font(.system(size: 8, weight: .bold, design: .monospaced))
                .foregroundStyle(statusColor)
        }
    }
}

// MARK: - Relative Time

private func relativeTime(from isoString: String) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = formatter.date(from: isoString) else {
        // Try without fractional seconds
        formatter.formatOptions = [.withInternetDateTime]
        guard let date = formatter.date(from: isoString) else { return "" }
        return formatRelative(date)
    }
    return formatRelative(date)
}

private func formatRelative(_ date: Date) -> String {
    let seconds = Int(-date.timeIntervalSinceNow)
    if seconds < 60 { return "now" }
    if seconds < 3600 { return "\(seconds / 60)m" }
    if seconds < 86400 { return "\(seconds / 3600)h" }
    return "\(seconds / 86400)d"
}
