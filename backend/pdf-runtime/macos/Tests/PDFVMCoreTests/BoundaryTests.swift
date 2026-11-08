import CryptoKit
import Darwin
import Foundation
import XCTest
@testable import PDFVMCore

private final class MemoryStream: ByteReader, ByteWriter {
    var input: Data
    var output = Data()
    var largestRead = 0
    var fragment = Limits.chunk
    var failOnExhaustedRead = false
    init(_ data: Data = Data()) { input = data }
    func read(upTo count: Int) throws -> Data {
        if input.isEmpty && failOnExhaustedRead { throw PDFVMError("Peer remains open after terminal") }
        largestRead = max(largestRead, count)
        let result = input.prefix(min(count, fragment))
        input.removeFirst(result.count)
        return Data(result)
    }
    func write(_ data: Data) throws { output.append(data) }
}

final class BoundaryTests: XCTestCase {
    private let arguments = ["-png", "-r", "150", "-f", "2", "-l", "3", "-W", "8193", "-H", "8193", "/tmp/input.pdf"]

    func testRequestUsesExactVersionedBigEndianHeader() throws {
        let request = try Request(arguments: arguments, defaultAssets: "/bundle/pdf")
        let header = try request.header(inputBytes: 0x010203)
        XCTAssertEqual(header.count, 32)
        XCTAssertEqual(Array(header), Array("HXPDF001".utf8) + [0,0,0,2, 0,0,0,3, 0,0,0,0,0,1,2,3, 0,0,0,0,0,0,0,0])
        XCTAssertEqual(request.assets, "/bundle/pdf")
        XCTAssertThrowsError(try request.header(inputBytes: UInt64(Limits.input) + 1))
    }

    func testRequestRejectsMalformedAndUnboundedRenderArguments() {
        for (option, value) in [("-r", "72"), ("-W", "8192"), ("-H", "0"), ("-f", "0"), ("-f", "-1"), ("-f", "+2"), ("-f", "2147483648"), ("-f", "4"), ("-l", "27")] {
            var altered = arguments
            altered[altered.firstIndex(of: option)! + 1] = value
            XCTAssertThrowsError(try Request(arguments: altered, defaultAssets: "/bundle/pdf"), "\(option)\(value)")
        }
        XCTAssertThrowsError(try Request(arguments: arguments + ["-f", "2"], defaultAssets: "/bundle/pdf"))
        XCTAssertThrowsError(try Request(arguments: arguments + ["output-root"], defaultAssets: "/bundle/pdf"))
        XCTAssertThrowsError(try Request(arguments: arguments + ["--unknown"], defaultAssets: "/bundle/pdf"))
    }

    func testFragmentedReplyPreservesBytesAndStopsAtSuccessfulTerminal() throws {
        let reply = MemoryStream(response([Data([1,2]), Data([3])]))
        reply.fragment = 1
        let output = MemoryStream()
        XCTAssertEqual(try receiveResponse(reply, output: output, limit: 3), 3)
        XCTAssertEqual(output.output, Data([1,2,3]))
        XCTAssertLessThanOrEqual(reply.largestRead, Limits.chunk)
        let trailing = MemoryStream(response([Data([1])]) + Data([1]))
        XCTAssertEqual(try receiveResponse(trailing, output: MemoryStream()), 1)
        XCTAssertEqual(trailing.input, Data([1]))
    }

    func testSuccessfulTerminalDoesNotReadAgainWhenPeerRemainsOpen() throws {
        let reply = MemoryStream(response([Data([1,2,3])]))
        reply.failOnExhaustedRead = true
        let output = MemoryStream()
        XCTAssertEqual(try receiveResponse(reply, output: output), 3)
        XCTAssertEqual(output.output, Data([1,2,3]))
        XCTAssertTrue(reply.input.isEmpty)
    }

    func testExcessIsRejectedBeforeReadingOrWritingItsPayload() throws {
        var frame = Data("HXPNG001".utf8)
        frame.appendBigEndian(UInt32(65_537))
        let oversized = MemoryStream(frame)
        let output = MemoryStream()
        XCTAssertThrowsError(try receiveResponse(oversized, output: output))
        XCTAssertEqual(oversized.largestRead, 8)
        XCTAssertTrue(output.output.isEmpty)
        let budget = MemoryStream(response([Data([1,2]), Data([3,4])]))
        XCTAssertThrowsError(try receiveResponse(budget, output: output, limit: 3))
        XCTAssertEqual(output.output, Data([1,2]))
        XCTAssertGreaterThan(budget.input.count, 0)
    }

    func testTruncatedWrongVersionAndFailureRepliesFailClosed() {
        let complete = response([Data([1,2,3])])
        for length in 0..<complete.count {
            XCTAssertThrowsError(try receiveResponse(MemoryStream(complete.prefix(length)), output: MemoryStream()), "prefix\(length)")
        }
        XCTAssertThrowsError(try receiveResponse(MemoryStream(Data("HXPNG002".utf8)), output: MemoryStream()))
        for status: UInt32 in [1,2,3,4,UInt32.max] {
            XCTAssertThrowsError(try receiveResponse(MemoryStream(response([], status: status)), output: MemoryStream()))
        }
    }

    func testOutputLimitHasDistinctExitStatusWhileMalformedFramesRemainProtocolFailures() {
        for reply in [MemoryStream(response([], status: 3)), MemoryStream(response([Data([1,2]), Data([3,4])]))] {
            XCTAssertThrowsError(try receiveResponse(reply, output: MemoryStream(), limit: 3)) { error in
                XCTAssertEqual((error as? PDFVMError)?.status.rawValue, 80)
            }
        }
        var oversizedFrame = Data("HXPNG001".utf8)
        oversizedFrame.appendBigEndian(UInt32(Limits.chunk + 1))
        XCTAssertThrowsError(try receiveResponse(MemoryStream(oversizedFrame), output: MemoryStream(), limit: 3)) { error in
            XCTAssertEqual((error as? PDFVMError)?.status, .failure)
        }
    }

    func testRegularFileRejectsSymlinkDirectoryFIFOAndOversize() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("input")
        try Data([1,2,3]).write(to: file)
        XCTAssertEqual(try RegularFile(path: file.path, limit: 3).bytes, 3)
        XCTAssertThrowsError(try RegularFile(path: file.path, limit: 2))
        XCTAssertThrowsError(try RegularFile(path: root.path, limit: 3))
        let link = root.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: file)
        XCTAssertThrowsError(try RegularFile(path: link.path, limit: 3))
        let fifo = root.appendingPathComponent("fifo").path
        XCTAssertEqual(mkfifo(fifo, 0o600), 0)
        XCTAssertThrowsError(try RegularFile(path: fifo, limit: 3))
    }

    func testAssetHashesAndArchitectureFailClosedBeforeVMStart() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let bytes = Data([1,2,3])
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        var manifest: [String: Any] = ["version": 1, "architecture": try Assets.architecture(), "files": ["kernel": digest, "initramfs": digest, "rootfs": digest]]
        for name in ["kernel", "initramfs", "rootfs"] { try bytes.write(to: root.appendingPathComponent(name)) }
        func save() throws { try JSONSerialization.data(withJSONObject: manifest).write(to: root.appendingPathComponent("manifest.json")) }
        try save()
        _ = try Assets(directory: root.path)
        XCTAssertThrowsError(try Assets(directory: root.path) { throw PDFVMError("deadline") })
        try Data([4]).write(to: root.appendingPathComponent("rootfs"))
        XCTAssertThrowsError(try Assets(directory: root.path))
        try bytes.write(to: root.appendingPathComponent("rootfs"))
        manifest["architecture"] = "other"
        try save()
        XCTAssertThrowsError(try Assets(directory: root.path))
    }

    func testPhysicalArchitectureRejectsTranslatedOrMismatchedHelpers() throws {
        XCTAssertEqual(try Assets.selectArchitecture(helper: "arm64", hardwareARM: true, translated: false), "aarch64")
        XCTAssertEqual(try Assets.selectArchitecture(helper: "x86_64", hardwareARM: false, translated: false), "x86_64")
        for translated in [true, false] {
            XCTAssertThrowsError(try Assets.selectArchitecture(helper: "x86_64", hardwareARM: true, translated: translated))
        }
        XCTAssertThrowsError(try Assets.selectArchitecture(helper: "arm64", hardwareARM: false, translated: false))
        XCTAssertThrowsError(try Assets.selectArchitecture(helper: "x86_64", hardwareARM: false, translated: true))
    }

    func testFixedExitStatusesSeparateInputSetupSupportRenderAndDeadline() {
        for status: HelperExit in [.input, .configuration] {
            XCTAssertThrowsError(try classifyFailure(as: status) { throw PDFVMError("unclassified I/O") }) { error in
                XCTAssertEqual((error as? PDFVMError)?.status, status)
            }
        }
        XCTAssertThrowsError(try classifyFailure(as: .configuration) { throw PDFVMError("native architecture", status: .unsupported) }) { error in
            XCTAssertEqual((error as? PDFVMError)?.status, .unsupported)
        }
        XCTAssertThrowsError(try Assets(directory: "/no-such-hexbot-pdf-assets")) { error in
            XCTAssertEqual((error as? PDFVMError)?.status, .configuration)
        }
        for (status, expected): (UInt32, HelperExit) in [(2, .failure), (4, .deadline)] {
            XCTAssertThrowsError(try receiveResponse(MemoryStream(response([], status: status)), output: MemoryStream())) { error in
                XCTAssertEqual((error as? PDFVMError)?.status, expected)
            }
        }
    }

    func testSocketAbortUnblocksOwnedReaderWithoutClosingAReusedDescriptor() throws {
        var descriptors: [Int32] = [-1, -1]
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors), 0)
        defer { _ = Darwin.close(descriptors[0]); _ = Darwin.close(descriptors[1]) }
        let channel = try SocketChannel(duplicating: descriptors[0])
        let completed = expectation(description: "read interrupted")
        DispatchQueue.global().async {
            defer { channel.close(); completed.fulfill() }
            XCTAssertTrue((try? channel.read(upTo: 1).isEmpty) ?? true)
        }
        channel.abort()
        wait(for: [completed], timeout: 2)
        var replacement: [Int32] = [-1, -1]
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &replacement), 0)
        defer { _ = Darwin.close(replacement[0]); _ = Darwin.close(replacement[1]) }
        channel.abort()
        var byte: UInt8 = 7
        XCTAssertEqual(Darwin.write(replacement[1], &byte, 1), 1)
        byte = 0
        XCTAssertEqual(Darwin.read(replacement[0], &byte, 1), 1)
        XCTAssertEqual(byte, 7)
    }

    func testBlockedDiagnosticWriterDoesNotBlockAdmissionOrRetainExcess() {
        let entered = expectation(description: "diagnostic writer blocked")
        let completed = expectation(description: "bounded diagnostics written")
        completed.expectedFulfillmentCount = 2
        let gate = DispatchSemaphore(value: 0)
        defer { gate.signal() }
        var first = true
        var written = Data()
        let sink = DiagnosticSink(limit: 4) { data in
            if first {
                first = false
                entered.fulfill()
                gate.wait()
            }
            written.append(data)
            completed.fulfill()
        }
        sink.offer(Data([1,2]))
        wait(for: [entered], timeout: 2)
        sink.offer(Data([3,4,5,6]))
        sink.offer(Data([7,8]))
        gate.signal()
        wait(for: [completed], timeout: 2)
        XCTAssertEqual(written, Data([1,2,3,4]))
    }

    func testGuestStopAndTransportCompletionCanArriveInEitherOrder() {
        for guestStopsFirst in [true, false] {
            var state = CompletionState()
            XCTAssertTrue(state.acceptConnection())
            XCTAssertFalse(state.acceptConnection())
            if guestStopsFirst { XCTAssertFalse(state.guestStopped()) }
            XCTAssertTrue(state.finish(.success(())))
            XCTAssertTrue(state.guestStopped())
            guard case .success = state.result else { return XCTFail("Valid terminal response lost") }
        }
        var early = CompletionState()
        XCTAssertTrue(early.guestStopped())
        guard case .failure = early.result else { return XCTFail("Missing connection accepted") }
    }

    func testCancellationTruncationAndVMErrorCannotBecomeSuccess() {
        for message in ["cancelled", "truncated"] {
            var state = CompletionState()
            XCTAssertTrue(state.acceptConnection())
            XCTAssertTrue(state.finish(.failure(PDFVMError(message))))
            XCTAssertFalse(state.finish(.success(())))
            XCTAssertTrue(state.guestStopped())
            guard case .failure = state.result else { return XCTFail("Failure became success") }
        }
        var errorAfterResponse = CompletionState()
        XCTAssertTrue(errorAfterResponse.acceptConnection())
        errorAfterResponse.finish(.success(()))
        errorAfterResponse.machineFailed(PDFVMError("VM error"))
        guard case .failure = errorAfterResponse.result else { return XCTFail("VM error accepted") }
    }

    private func response(_ chunks: [Data], status: UInt32 = 0) -> Data {
        var data = Data("HXPNG001".utf8)
        for chunk in chunks { data.appendBigEndian(UInt32(chunk.count)); data.append(chunk) }
        data.appendBigEndian(UInt32(0))
        data.appendBigEndian(status)
        return data
    }

    private func temporaryDirectory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }
}
