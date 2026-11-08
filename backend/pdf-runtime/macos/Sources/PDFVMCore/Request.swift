import Foundation

public enum HelperExit: Int32 {
    case failure = 1
    case input = 65
    case unsupported = 69
    case configuration = 78
    case outputLimit = 80
    case deadline = 124
}

public struct PDFVMError: Error, CustomStringConvertible {
    public let description: String
    public let status: HelperExit
    public init(_ message: String, status: HelperExit = .failure) {
        description = message
        self.status = status
    }
}

public func classifyFailure<T>(as status: HelperExit, _ operation: () throws -> T) throws -> T {
    do { return try operation() }
    catch let error as PDFVMError where error.status != .failure { throw error }
    catch { throw PDFVMError(String(describing: error), status: status) }
}

public enum Limits {
    public static let input = 45 * 1024 * 1024
    public static let output = 99_090_240
    public static let chunk = 65_536
    public static let memory: UInt64 = 768 * 1024 * 1024
    public static let seconds: Double = 120
    public static let port: UInt32 = 5000
}

public struct Request {
    public let first: UInt32
    public let last: UInt32
    public let input: String
    public let assets: String

    public init(arguments: [String], defaultAssets: String) throws {
        var values: [String: String] = [:]
        var positional: [String] = []
        var index = 0
        while index < arguments.count {
            let argument = arguments[index]
            if argument == "-png" {
                guard values[argument] == nil else { throw PDFVMError("Duplicate renderer argument") }
                values[argument] = "true"
            } else if ["-r", "-f", "-l", "-W", "-H", "--assets"].contains(argument) {
                guard values[argument] == nil, index + 1 < arguments.count else {
                    throw PDFVMError("Invalid renderer argument")
                }
                index += 1
                values[argument] = arguments[index]
            } else {
                guard !argument.hasPrefix("-") else { throw PDFVMError("Unknown renderer argument") }
                positional.append(argument)
            }
            index += 1
        }
        guard values["-png"] == "true", values["-r"] == "150",
              values["-W"] == "8193", values["-H"] == "8193", positional.count == 1,
              let first = Self.page(values["-f"]), let last = Self.page(values["-l"]),
              last >= first, last - first < 25 else {
            throw PDFVMError("Expected PNG at 150 dpi, an 8193-pixel crop and 1 to 25 selected pages")
        }
        self.first = first
        self.last = last
        input = positional[0]
        assets = values["--assets"] ?? defaultAssets
    }

    private static func page(_ value: String?) -> UInt32? {
        guard let value, !value.isEmpty,
              value.utf8.allSatisfy({ (48...57).contains($0) }),
              let page = UInt32(value), page > 0, page <= UInt32(Int32.max) else { return nil }
        return page
    }

    public func header(inputBytes: UInt64) throws -> Data {
        guard inputBytes <= UInt64(Limits.input) else { throw PDFVMError("PDF exceeds 45 MiB") }
        var result = Data("HXPDF001".utf8)
        result.appendBigEndian(first)
        result.appendBigEndian(last)
        result.appendBigEndian(inputBytes)
        result.appendBigEndian(UInt64(0))
        return result
    }
}

extension Data {
    mutating func appendBigEndian<T: FixedWidthInteger>(_ value: T) {
        var value = value.bigEndian
        Swift.withUnsafeBytes(of: &value) { append(contentsOf: $0) }
    }
}
