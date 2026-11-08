import CryptoKit
import Darwin
import Foundation

public struct Assets {
    public let kernel: URL
    public let initramfs: URL
    public let rootfs: URL

    private struct Manifest: Decodable {
        let version: Int
        let architecture: String
        let files: [String: String]
    }

    public init(directory: String, checkDeadline: () throws -> Void = {}) throws {
        let directory = URL(fileURLWithPath: directory, isDirectory: true)
        let manifestFile = try classifyFailure(as: .configuration) {
            try RegularFile(path: directory.appendingPathComponent("manifest.json").path, limit: 131_072)
        }
        var manifestData = Data()
        while true {
            let chunk = try classifyFailure(as: .configuration) { try manifestFile.read(upTo: Limits.chunk) }
            guard chunk.count <= 131_072 - manifestData.count else { throw PDFVMError("Asset manifest exceeds its limit", status: .configuration) }
            if chunk.isEmpty { break }
            manifestData.append(chunk)
        }
        let manifest = try classifyFailure(as: .configuration) { try JSONDecoder().decode(Manifest.self, from: manifestData) }
        guard manifest.version == 1, manifest.architecture == (try Self.architecture()),
              Set(manifest.files.keys) == Set(["kernel", "initramfs", "rootfs"]) else {
            throw PDFVMError("Unsupported PDF VM assets or architecture", status: .configuration)
        }
        for name in ["kernel", "initramfs", "rootfs"] {
            try checkDeadline()
            guard let expected = manifest.files[name], expected.utf8.count == 64,
                  expected.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
                throw PDFVMError("Invalid PDF VM asset checksum", status: .configuration)
            }
            let limit = UInt64(["kernel": 64, "initramfs": 32, "rootfs": 192][name]!) * 1024 * 1024
            let file = try classifyFailure(as: .configuration) {
                try RegularFile(path: directory.appendingPathComponent(name).path, limit: limit)
            }
            var hash = SHA256()
            var bytes: UInt64 = 0
            while true {
                try checkDeadline()
                let chunk = try classifyFailure(as: .configuration) { try file.read(upTo: Limits.chunk) }
                if chunk.isEmpty { break }
                guard UInt64(chunk.count) <= limit - bytes else { throw PDFVMError("PDF VM asset exceeds its limit", status: .configuration) }
                bytes += UInt64(chunk.count)
                hash.update(data: chunk)
            }
            let actual = hash.finalize().map { String(format: "%02x", $0) }.joined()
            guard bytes == file.bytes, actual == expected else { throw PDFVMError("PDF VM asset checksum mismatch", status: .configuration) }
        }
        kernel = directory.appendingPathComponent("kernel")
        initramfs = directory.appendingPathComponent("initramfs")
        rootfs = directory.appendingPathComponent("rootfs")
    }

    public static func architecture() throws -> String {
        let hardwareARM = try sysctlFlag("hw.optional.arm64")
        let translated = try sysctlFlag("sysctl.proc_translated")
        #if arch(arm64)
        return try selectArchitecture(helper: "arm64", hardwareARM: hardwareARM, translated: translated)
        #elseif arch(x86_64)
        return try selectArchitecture(helper: "x86_64", hardwareARM: hardwareARM, translated: translated)
        #else
        throw PDFVMError("Unsupported PDF VM architecture", status: .unsupported)
        #endif
    }

    static func selectArchitecture(helper: String, hardwareARM: Bool, translated: Bool) throws -> String {
        if hardwareARM {
            guard helper == "arm64", !translated else {
                throw PDFVMError("Use the Apple silicon PDF VM helper and assets. An Intel helper cannot boot an Intel guest on this Mac.", status: .unsupported)
            }
            return "aarch64"
        }
        guard helper == "x86_64", !translated else { throw PDFVMError("PDF VM helper does not match this Mac", status: .unsupported) }
        return "x86_64"
    }

    private static func sysctlFlag(_ name: String) throws -> Bool {
        var value: Int32 = 0
        var size = MemoryLayout.size(ofValue: value)
        if sysctlbyname(name, &value, &size, nil, 0) == 0 { return value != 0 }
        if errno == ENOENT { return false }
        throw PDFVMError("Could not identify this Mac's native PDF VM architecture", status: .unsupported)
    }
}
