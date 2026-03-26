import Foundation
import SwiftUI
import WatchKit

enum ConnectionState: Sendable {
    case disconnected, connecting, connected, error
}

@MainActor
@Observable
class RelayClient {
    var relayURL: String {
        didSet { UserDefaults.standard.set(relayURL, forKey: "relayURL") }
    }
    var secret: String {
        didSet { UserDefaults.standard.set(secret, forKey: "watchcodeSecret") }
    }
    var sessions: [SessionInfo] = []
    var events: [WatchEvent] = []
    var connectionState: ConnectionState = .disconnected

    var isConnected: Bool { connectionState == .connected }

    private var connectionId: String?
    private var currentSessionId: String?
    var currentProvider: String?
    private var streamTask: Task<Void, Never>?
    private var reconnectAttempts = 0
    private let maxReconnectAttempts = 3

    init() {
        self.relayURL = UserDefaults.standard.string(forKey: "relayURL") ?? ""
        self.secret = UserDefaults.standard.string(forKey: "watchcodeSecret") ?? ""
    }

    private var baseURL: String {
        relayURL.hasSuffix("/") ? String(relayURL.dropLast()) : relayURL
    }

    /// Apply auth header to a request
    private func applyAuth(_ request: inout URLRequest) {
        if !secret.isEmpty {
            request.setValue(secret, forHTTPHeaderField: "x-watchcode-secret")
        }
    }

    // MARK: - Sessions

    func fetchSessions() async {
        do {
            var request = URLRequest(url: URL(string: "\(baseURL)/api/sessions")!)
            applyAuth(&request)
            let (data, _) = try await URLSession.shared.data(for: request)
            let response = try JSONDecoder().decode(SessionsResponse.self, from: data)
            sessions = response.sessions
        } catch {
            print("[relay] Failed to fetch sessions: \(error)")
        }
    }

    // MARK: - Connection

    func connect(sessionId: String, provider: String? = nil) async {
        connectionState = .connecting
        currentSessionId = sessionId
        currentProvider = provider
        events = []
        reconnectAttempts = 0

        await performConnect(sessionId: sessionId)
    }

    private func performConnect(sessionId: String) async {
        do {
            var request = URLRequest(url: URL(string: "\(baseURL)/api/connect")!)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            applyAuth(&request)
            request.httpBody = try JSONEncoder().encode(ConnectRequest(sessionId: sessionId, provider: currentProvider))

            let (data, _) = try await URLSession.shared.data(for: request)
            let response = try JSONDecoder().decode(ConnectResponse.self, from: data)
            connectionId = response.connectionId
            connectionState = .connected
            reconnectAttempts = 0

            WKInterfaceDevice.current().play(.success)
            startEventStream(sessionId: sessionId, connectionId: response.connectionId)
        } catch {
            connectionState = .error
            WKInterfaceDevice.current().play(.failure)
            events.append(WatchEvent(type: .error, content: error.localizedDescription))
        }
    }

    func disconnect() async {
        // Set state first to prevent reconnect attempts
        currentSessionId = nil
        connectionState = .disconnected

        streamTask?.cancel()
        streamTask = nil

        if let connectionId {
            self.connectionId = nil
            var request = URLRequest(url: URL(string: "\(baseURL)/api/connections/\(connectionId)")!)
            request.httpMethod = "DELETE"
            applyAuth(&request)
            _ = try? await URLSession.shared.data(for: request)
        }
    }

    // MARK: - Messaging

    func sendMessage(_ content: String) async {
        guard let sessionId = currentSessionId, let connectionId else { return }

        var request = URLRequest(url: URL(string: "\(baseURL)/api/sessions/\(sessionId)/message")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)
        request.httpBody = try? JSONEncoder().encode(
            MessageRequest(content: content, connectionId: connectionId)
        )

        _ = try? await URLSession.shared.data(for: request)
    }

    func sendInterrupt() async {
        guard let sessionId = currentSessionId, let connectionId else { return }

        var request = URLRequest(url: URL(string: "\(baseURL)/api/sessions/\(sessionId)/control")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)
        request.httpBody = try? JSONEncoder().encode(
            ControlRequest(type: "interrupt", connectionId: connectionId)
        )

        _ = try? await URLSession.shared.data(for: request)
    }

    // MARK: - SSE Stream

    private func startEventStream(sessionId: String, connectionId: String) {
        streamTask = Task {
            do {
                let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)/events?connectionId=\(connectionId)")!
                var request = URLRequest(url: url)
                applyAuth(&request)
                let (bytes, _) = try await URLSession.shared.bytes(for: request)

                for try await line in bytes.lines {
                    guard !Task.isCancelled else { break }

                    if line.hasPrefix("data: ") {
                        let jsonString = String(line.dropFirst(6))
                        if let data = jsonString.data(using: .utf8),
                           let event = try? JSONDecoder().decode(WatchEvent.self, from: data),
                           event.type != .raw {
                            events.append(event)
                        }
                    }
                }
            } catch {
                if !Task.isCancelled && connectionState != .disconnected {
                    connectionState = .error
                    WKInterfaceDevice.current().play(.retry)
                    await attemptReconnect()
                }
            }
        }
    }

    private func attemptReconnect() async {
        guard connectionState != .disconnected,
              reconnectAttempts < maxReconnectAttempts,
              let sessionId = currentSessionId else { return }

        reconnectAttempts += 1
        connectionState = .connecting
        events.append(WatchEvent(type: .status, content: "Reconnecting... (attempt \(reconnectAttempts)/\(maxReconnectAttempts))"))

        try? await Task.sleep(for: .seconds(Double(reconnectAttempts) * 2))

        guard !Task.isCancelled else { return }
        await performConnect(sessionId: sessionId)
    }
}

// MARK: - Request/Response Types

private struct SessionsResponse: Codable {
    let sessions: [SessionInfo]
}

private struct ConnectRequest: Codable {
    let sessionId: String
    let provider: String?
}

private struct ConnectResponse: Codable {
    let connectionId: String
    let status: String
}

private struct MessageRequest: Codable {
    let content: String
    let connectionId: String
}

private struct ControlRequest: Codable {
    let type: String
    let connectionId: String
}
