// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "Gozd",
  platforms: [.macOS(.v26)],
  products: [
    .executable(name: "Gozd", targets: ["Gozd"]),
    .executable(name: "gozd-cli", targets: ["GozdCLI"]),
    .library(name: "GozdCore", targets: ["GozdCore"]),
  ],
  dependencies: [
    .package(name: "GozdProto", path: "../../packages/proto-swift"),
  ],
  targets: [
    .executableTarget(
      name: "Gozd",
      dependencies: [
        "GozdCore",
        .product(name: "GozdProto", package: "GozdProto"),
      ]
    ),
    .executableTarget(
      name: "GozdCLI",
      dependencies: [
        .product(name: "GozdProto", package: "GozdProto"),
      ]
    ),
    .target(
      name: "GozdCore",
      dependencies: [
        "CPty",
        "CProc",
        .product(name: "GozdProto", package: "GozdProto"),
      ]
    ),
    .target(
      name: "CPty"
    ),
    .target(
      name: "CProc"
    ),
    .testTarget(
      name: "GozdCoreTests",
      dependencies: ["GozdCore"]
    ),
  ]
)
