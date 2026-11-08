import Foundation

// Owned by the VM queue. A stopped guest and its final socket bytes can arrive
// in either order; cancellation or a VM error must never turn into success.
public struct CompletionState {
    public private(set) var result: Result<Void, Error>?
    public private(set) var connected = false
    public init() {}

    public mutating func acceptConnection() -> Bool {
        guard !connected, result == nil else { return false }
        connected = true
        return true
    }

    @discardableResult public mutating func finish(_ outcome: Result<Void, Error>) -> Bool {
        guard result == nil else { return false }
        result = outcome
        return true
    }

    public mutating func guestStopped() -> Bool {
        if result != nil { return true }
        if connected { return false }
        result = .failure(PDFVMError("PDF guest stopped before connecting", status: .configuration))
        return true
    }

    public mutating func machineFailed(_ error: Error) { result = .failure(error) }
}
