import SwiftUI

struct SettingsView: View {
    @Environment(RelayClient.self) private var client
    @State private var testResult: TestResult?

    enum TestResult {
        case testing, success, failure(String)
    }

    var body: some View {
        @Bindable var client = client
        Form {
            Section {
                TextField("URL", text: $client.relayURL)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .font(.caption2)
            } header: {
                Text("Relay Server")
            } footer: {
                Text("The relay server URL that bridges coding agent sessions to this app.")
                    .font(.system(size: 9))
            }

            Section {
                TextField("Secret", text: $client.secret)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .font(.caption2)
            } header: {
                Text("Authentication")
            } footer: {
                Text("Must match WATCHCODE_SECRET on the server. Leave blank for local dev.")
                    .font(.system(size: 9))
            }

            Section {
                Button {
                    testConnection()
                } label: {
                    HStack {
                        Label("Test Connection", systemImage: "antenna.radiowaves.left.and.right")
                            .font(.caption2)
                        Spacer()
                        switch testResult {
                        case .testing:
                            ProgressView()
                                .scaleEffect(0.7)
                        case .success:
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                                .font(.caption)
                        case .failure:
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.red)
                                .font(.caption)
                        case nil:
                            EmptyView()
                        }
                    }
                }

                if case .failure(let msg) = testResult {
                    Text(msg)
                        .font(.system(size: 9))
                        .foregroundStyle(.red)
                }
            }

            Section {
                Button("Reset to Default") {
                    client.relayURL = "http://localhost:3847"
                    client.secret = ""
                    testResult = nil
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Settings")
    }

    private func testConnection() {
        testResult = .testing
        Task {
            do {
                let base = client.relayURL.hasSuffix("/")
                    ? String(client.relayURL.dropLast())
                    : client.relayURL
                var request = URLRequest(url: URL(string: "\(base)/api/sessions")!)
                if !client.secret.isEmpty {
                    request.setValue(client.secret, forHTTPHeaderField: "x-watchcode-secret")
                }
                let (_, response) = try await URLSession.shared.data(for: request)
                if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                    testResult = .success
                } else if let http = response as? HTTPURLResponse, http.statusCode == 401 {
                    testResult = .failure("Unauthorized — check secret")
                } else {
                    testResult = .failure("Unexpected response")
                }
            } catch {
                testResult = .failure(error.localizedDescription)
            }
        }
    }
}
