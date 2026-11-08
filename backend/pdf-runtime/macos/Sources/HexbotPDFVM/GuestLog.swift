import Darwin
import Foundation
import PDFVMCore
import Virtualization

// Boot errors remain useful when the guest cannot reach vsock. Keep stderr
// bounded too; after 16 KiB, continue draining without retaining or printing it.
final class GuestLog {
    private let pipe = Pipe()
    private let source: DispatchSourceRead
    private let diagnostics: DiagnosticSink

    init(diagnostics: DiagnosticSink) throws {
        self.diagnostics = diagnostics
        let descriptor = dup(pipe.fileHandleForReading.fileDescriptor)
        guard descriptor >= 0 else { throw PDFVMError("Could not own guest log pipe") }
        guard fcntl(descriptor, F_SETFL, O_NONBLOCK) == 0 else {
            _ = close(descriptor)
            throw PDFVMError("Could not configure guest log pipe")
        }
        source = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: .main)
        source.setEventHandler { [weak self] in
            guard let self else { return }
            var bytes = [UInt8](repeating: 0, count: 4096)
            let count = read(descriptor, &bytes, bytes.count)
            if count > 0 {
                self.diagnostics.offer(Data(bytes.prefix(count)))
            } else if count == 0 || (count < 0 && errno != EINTR && errno != EAGAIN) {
                self.source.cancel()
            }
        }
        source.setCancelHandler { _ = close(descriptor) }
        source.resume()
    }

    func configuration() -> VZVirtioConsoleDeviceSerialPortConfiguration {
        let console = VZVirtioConsoleDeviceSerialPortConfiguration()
        console.attachment = VZFileHandleSerialPortAttachment(
            fileHandleForReading: nil, fileHandleForWriting: pipe.fileHandleForWriting)
        return console
    }

    deinit { source.cancel() }
}
