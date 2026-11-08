// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "HexbotPDFVM",
    platforms: [.macOS(.v12)],
    products: [.executable(name: "hexbot-pdf-vm", targets: ["HexbotPDFVM"])],
    targets: [
        .target(name: "PDFVMCore"),
        .executableTarget(
            name: "HexbotPDFVM", dependencies: ["PDFVMCore"],
            linkerSettings: [.linkedFramework("Virtualization")]
        ),
        .testTarget(name: "PDFVMCoreTests", dependencies: ["PDFVMCore"])
    ]
)
