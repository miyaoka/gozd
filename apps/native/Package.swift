// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "Gozd",
    platforms: [.macOS(.v26)],
    targets: [
        .executableTarget(
            name: "Gozd",
            path: "Sources/Gozd"
        ),
    ]
)
