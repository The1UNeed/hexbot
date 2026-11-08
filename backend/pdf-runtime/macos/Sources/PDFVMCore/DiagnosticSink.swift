import Foundation

// Admission is bounded for the whole job. A blocked inherited stderr can occupy
// this one worker, but never the VM queue, cancellation callbacks or deadline.
public final class DiagnosticSink {
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "app.hexbot.pdf.diagnostics")
    private let writer: (Data) -> Void
    private var remaining: Int

    public init(limit: Int = 16 * 1024, writer: @escaping (Data) -> Void = {
        try? FileHandle.standardError.write(contentsOf: $0)
    }) {
        remaining = max(0, limit)
        self.writer = writer
    }

    public func offer(_ data: Data) {
        lock.lock()
        let count = min(data.count, remaining)
        remaining -= count
        lock.unlock()
        guard count > 0 else { return }
        let admitted = Data(data.prefix(count))
        queue.async { self.writer(admitted) }
    }

    public func flush(_ completion: @escaping () -> Void) { queue.async { completion() } }
}
