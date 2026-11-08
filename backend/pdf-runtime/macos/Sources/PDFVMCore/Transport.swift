import Darwin
import Foundation

public protocol ByteReader {
    func read(upTo count: Int) throws -> Data
}

public protocol ByteWriter {
    func write(_ data: Data) throws
}

// Only the transfer worker closes this descriptor. The VM queue may shut down
// the socket to interrupt I/O, with the lock preventing stale-descriptor reuse.
public final class SocketChannel: ByteReader, ByteWriter {
    private let lock = NSLock()
    private var descriptor: Int32

    public init(duplicating descriptor: Int32) throws {
        self.descriptor = Darwin.dup(descriptor)
        guard self.descriptor >= 0 else { throw PDFVMError("Could not own guest connection") }
        _ = fcntl(self.descriptor, F_SETFD, FD_CLOEXEC)
    }

    public func abort() {
        lock.lock()
        defer { lock.unlock() }
        if descriptor >= 0 { _ = Darwin.shutdown(descriptor, SHUT_RDWR) }
    }

    public func close() {
        lock.lock()
        defer { lock.unlock() }
        if descriptor >= 0 {
            let owned = descriptor
            descriptor = -1
            _ = Darwin.close(owned)
        }
    }

    public func read(upTo count: Int) throws -> Data { try readDescriptor(descriptor, upTo: count) }
    public func write(_ data: Data) throws { try writeDescriptor(descriptor, data: data) }
    deinit { close() }
}

public final class RegularFile: ByteReader {
    public let descriptor: Int32
    public let bytes: UInt64

    public init(path: String, limit: UInt64) throws {
        descriptor = Darwin.open(path, O_RDONLY | O_CLOEXEC | O_NONBLOCK | O_NOFOLLOW)
        guard descriptor >= 0 else { throw PDFVMError("Could not open regular file") }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_size >= 0, UInt64(info.st_size) <= limit else {
            _ = Darwin.close(descriptor)
            throw PDFVMError("File is not regular or exceeds its byte limit")
        }
        bytes = UInt64(info.st_size)
    }

    public func read(upTo count: Int) throws -> Data { try readDescriptor(descriptor, upTo: count) }
    public func rewind() throws {
        guard lseek(descriptor, 0, SEEK_SET) == 0 else { throw PDFVMError("Could not rewind PDF") }
    }
    deinit { _ = Darwin.close(descriptor) }
}

public struct StandardOutput: ByteWriter {
    public init() {}
    public func write(_ data: Data) throws { try writeDescriptor(STDOUT_FILENO, data: data) }
}

public func readDescriptor(_ descriptor: Int32, upTo count: Int) throws -> Data {
    guard count > 0, count <= Limits.chunk else { throw PDFVMError("Invalid read size") }
    var bytes = [UInt8](repeating: 0, count: count)
    while true {
        let amount = Darwin.read(descriptor, &bytes, count)
        if amount >= 0 { return Data(bytes.prefix(amount)) }
        if errno != EINTR { throw PDFVMError("Could not read renderer data") }
    }
}

private func writeDescriptor(_ descriptor: Int32, data: Data) throws {
    try data.withUnsafeBytes { bytes in
        var offset = 0
        while offset < bytes.count {
            let amount = Darwin.write(descriptor, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
            if amount > 0 { offset += amount }
            else if amount == 0 || errno != EINTR { throw PDFVMError("Could not write renderer data") }
        }
    }
}

public func readExactly(_ reader: ByteReader, count: Int) throws -> Data {
    guard count >= 0, count <= Limits.chunk else { throw PDFVMError("Invalid frame size") }
    var result = Data()
    result.reserveCapacity(count)
    while result.count < count {
        let chunk = try reader.read(upTo: count - result.count)
        guard !chunk.isEmpty, chunk.count <= count - result.count else { throw PDFVMError("Truncated guest response") }
        result.append(chunk)
    }
    return result
}

public func receiveResponse(_ reader: ByteReader, output: ByteWriter, limit: Int = Limits.output) throws -> Int {
    guard try readExactly(reader, count: 8) == Data("HXPNG001".utf8) else {
        throw PDFVMError("Invalid guest response version")
    }
    var total = 0
    while true {
        let frame = try readExactly(reader, count: 4)
        let count = frame.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        if count == 0 {
            let statusData = try readExactly(reader, count: 4)
            let status = statusData.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            if status == 3 { throw PDFVMError("Rendered PDF exceeds its output limit", status: .outputLimit) }
            if status == 4 { throw PDFVMError("Guest PDF renderer exceeded its deadline", status: .deadline) }
            guard status == 0 else { throw PDFVMError("Guest PDF renderer failed with status \(status)") }
            // The terminal frame ends this one-job response. The caller closes
            // the channel and stops the owned VM; no peer EOF is needed.
            return total
        }
        guard count <= UInt32(Limits.chunk) else { throw PDFVMError("Invalid guest frame size") }
        guard Int(count) <= limit - total else {
            throw PDFVMError("Rendered PDF exceeds its output limit", status: .outputLimit)
        }
        let data = try readExactly(reader, count: Int(count))
        total += data.count
        try output.write(data)
    }
}
