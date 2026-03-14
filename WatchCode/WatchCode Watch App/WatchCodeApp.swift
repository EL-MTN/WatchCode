import SwiftUI

@main
struct WatchCodeApp: App {
    @State private var client = RelayClient()

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                SessionListView()
            }
            .environment(client)
        }
    }
}
