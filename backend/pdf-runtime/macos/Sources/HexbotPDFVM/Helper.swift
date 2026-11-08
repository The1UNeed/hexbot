import Darwin
import Foundation
import PDFVMCore
import Virtualization

private let diagnostics = DiagnosticSink()

private func diagnostic(_ message: String) {
    let data = Data(("hexbot-pdf-vm: " + message + "\n").utf8)
    diagnostics.offer(data)
}

private func exitAfterDiagnostics(_ status: @escaping () -> Int32) {
    let exit: () -> Void = { Darwin.exit(status()) }
    diagnostics.flush { DispatchQueue.main.async(execute: exit) }
    // Do not wait for an inherited pipe that its reader has stopped draining.
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(20), execute: exit)
}

private final class RendererVM: NSObject, VZVirtualMachineDelegate, VZVirtioSocketListenerDelegate {
    private let request: Request
    private let input: RegularFile
    private let machine: VZVirtualMachine
    private let guestLog: GuestLog
    private let listener = VZVirtioSocketListener()
    private let deadline = DispatchSource.makeTimerSource(queue: .main)
    private var signalSources: [DispatchSourceSignal] = []
    private var parentSource: DispatchSourceProcess?
    private var connection: VZVirtioSocketConnection?
    private var channel: SocketChannel?
    private var completion = CompletionState()
    private var stopping = false
    private var completing = false

    init(request: Request, assets: Assets, input: RegularFile, started: DispatchTime, parent: pid_t) throws {
        guard VZVirtualMachine.isSupported else { throw PDFVMError("Virtualization is not available on this Mac", status: .unsupported) }
        let config = VZVirtualMachineConfiguration()
        config.cpuCount = 1
        config.memorySize = Limits.memory
        let boot = VZLinuxBootLoader(kernelURL: assets.kernel)
        boot.initialRamdiskURL = assets.initramfs
        boot.commandLine = "console=hvc0 loglevel=3 panic=0 oops=panic root=/dev/vda rootfstype=ext4 ro init=/sbin/hexbot-pdf-worker ipv6.disable=1"
        config.bootLoader = boot
        let root = VZVirtioBlockDeviceConfiguration(attachment:
            try VZDiskImageStorageDeviceAttachment(url: assets.rootfs, readOnly: true))
        config.storageDevices = [root]
        config.socketDevices = [VZVirtioSocketDeviceConfiguration()]
        config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        guestLog = try GuestLog(diagnostics: diagnostics)
        config.serialPorts = [guestLog.configuration()]
        // No IP network, host directory sharing, writable disks, graphics,
        // clipboard, USB, audio or console input are configured.
        try config.validate()
        machine = VZVirtualMachine(configuration: config)
        self.request = request
        self.input = input
        super.init()
        machine.delegate = self
        listener.delegate = self
        guard let device = machine.socketDevices.first as? VZVirtioSocketDevice else {
            throw PDFVMError("PDF VM socket device is unavailable")
        }
        device.setSocketListener(listener, forPort: Limits.port)
        deadline.schedule(deadline: started + Limits.seconds)
        deadline.setEventHandler { [weak self] in
            // At the absolute deadline, terminate the VM owner even if a VZ
            // callback or blocked stdout has stalled. Owner-death teardown is
            // separately verified by the real-VM integration checks.
            self?.channel?.abort()
            diagnostic("PDF renderer exceeded 120 seconds")
            Darwin._exit(124)
        }
        deadline.resume()
        for number in [SIGTERM, SIGINT, SIGHUP] {
            Darwin.signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in self?.finish(.failure(PDFVMError("PDF rendering was cancelled"))) }
            source.resume()
            signalSources.append(source)
        }
        if parent > 1 {
            let source = DispatchSource.makeProcessSource(identifier: parent, eventMask: .exit, queue: .main)
            source.setEventHandler { [weak self] in self?.finish(.failure(PDFVMError("Renderer owner exited"))) }
            source.resume()
            parentSource = source
            if getppid() != parent { finish(.failure(PDFVMError("Renderer owner exited"))) }
        }
    }

    func start() {
        guard completion.result == nil else { stopIfReady(); return }
        machine.start { [self] outcome in
            if case .failure(let error) = outcome { finish(.failure(PDFVMError(String(describing: error), status: .configuration))) }
            else if completion.result != nil { stopIfReady() }
        }
    }

    func listener(_ listener: VZVirtioSocketListener, shouldAcceptNewConnection connection: VZVirtioSocketConnection,
                  from socketDevice: VZVirtioSocketDevice) -> Bool {
        guard self.connection == nil, completion.result == nil else { return false }
        do {
            let channel = try SocketChannel(duplicating: connection.fileDescriptor)
            guard completion.acceptConnection() else { throw PDFVMError("Duplicate guest connection") }
            socketDevice.removeSocketListener(forPort: Limits.port)
            self.connection = connection
            self.channel = channel
            let input = self.input
            let request = self.request
            DispatchQueue.global(qos: .userInitiated).async { [self] in
                let outcome = Result<Void, Error> {
                    defer { channel.close() }
                    try channel.write(request.header(inputBytes: input.bytes))
                    var remaining = input.bytes
                    while remaining > 0 {
                        let data = try input.read(upTo: Int(min(UInt64(Limits.chunk), remaining)))
                        guard !data.isEmpty else { throw PDFVMError("PDF was truncated during transfer") }
                        try channel.write(data)
                        remaining -= UInt64(data.count)
                    }
                    guard try input.read(upTo: 1).isEmpty else { throw PDFVMError("PDF changed during transfer") }
                    _ = try receiveResponse(channel, output: StandardOutput())
                }
                DispatchQueue.main.async { self.finish(outcome) }
            }
            return true
        } catch {
            finish(.failure(error))
            return false
        }
    }

    private func finish(_ outcome: Result<Void, Error>) {
        guard completion.finish(outcome) else { return }
        (machine.socketDevices.first as? VZVirtioSocketDevice)?.removeSocketListener(forPort: Limits.port)
        channel?.abort()
        connection = nil
        stopIfReady()
    }

    private func stopIfReady() {
        guard !stopping else { return }
        switch machine.state {
        case .running, .paused:
            stopping = true
            machine.stop { [self] error in
                if let error, machine.state != .stopped {
                    completion.machineFailed(error)
                }
                complete()
            }
        case .stopped, .error:
            complete()
        default:
            // Starting is not a stoppable VZ state. Its completion calls back
            // here; the same absolute deadline remains armed throughout.
            break
        }
    }

    private func complete() {
        guard !completing else { return }
        completing = true
        if case .failure(let error) = completion.result { diagnostic(String(describing: error)) }
        else if machine.state != .stopped { diagnostic("PDF VM did not confirm a stopped state") }
        exitAfterDiagnostics { [self] in
            deadline.cancel()
            if case .success = completion.result, machine.state == .stopped { return 0 }
            if case .failure(let error) = completion.result { return (error as? PDFVMError)?.status.rawValue ?? HelperExit.failure.rawValue }
            return 1
        }
    }

    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        // The guest can finish after sending its terminal response, before the
        // I/O worker queues completion. Preserve buffered frames and await that
        // worker under the same deadline. Truncation still fails in the reader.
        if !completion.guestStopped() { return }
        if !stopping { complete() }
    }

    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        completion.machineFailed(completion.connected ? error : PDFVMError(String(describing: error), status: .configuration))
        channel?.abort()
        if !stopping { complete() }
    }
}

@main private struct Helper {
    static func main() {
        Darwin.signal(SIGPIPE, SIG_IGN)
        let started = DispatchTime.now()
        let parent = getppid()
        do {
            guard parent > 1 else { throw PDFVMError("Renderer owner exited") }
            let executable = Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
            let request = try classifyFailure(as: .configuration) {
                try Request(arguments: Array(CommandLine.arguments.dropFirst()), defaultAssets: executable.deletingLastPathComponent().path)
            }
            let input = try classifyFailure(as: .input) {
                let input = try RegularFile(path: request.input, limit: UInt64(Limits.input))
                guard try readExactly(input, count: 5) == Data("%PDF-".utf8) else { throw PDFVMError("Input is not a PDF") }
                try input.rewind()
                return input
            }
            let assets = try Assets(directory: request.assets) {
                guard DispatchTime.now() < started + Limits.seconds else { throw PDFVMError("PDF renderer exceeded 120 seconds", status: .deadline) }
                guard getppid() == parent else { throw PDFVMError("Renderer owner exited") }
            }
            let renderer = try classifyFailure(as: .configuration) {
                try RendererVM(request: request, assets: assets, input: input, started: started, parent: parent)
            }
            renderer.start()
            withExtendedLifetime(renderer) { RunLoop.main.run() }
            throw PDFVMError("PDF VM event loop stopped")
        } catch {
            diagnostic(String(describing: error))
            exitAfterDiagnostics { (error as? PDFVMError)?.status.rawValue ?? HelperExit.failure.rawValue }
            RunLoop.main.run()
            Darwin._exit(1)
        }
    }
}
