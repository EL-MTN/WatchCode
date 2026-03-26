import Foundation

struct SessionInfo: Codable, Identifiable {
    let id: String
    let title: String
    let status: String
    let model: String
    let environmentId: String
    let createdAt: String
    let updatedAt: String
    let provider: String?
}
