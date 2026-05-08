// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "Gozd",
  platforms: [.macOS(.v26)],
  products: [
    .executable(name: "Gozd", targets: ["Gozd"]),
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
    .target(
      name: "GozdCore",
      dependencies: [
        "CPty",
        .product(name: "GozdProto", package: "GozdProto"),
      ]
    ),
    .target(
      name: "CPty"
    ),
    .testTarget(
      name: "GozdCoreTests",
      dependencies: ["GozdCore"]
    ),
  ]
)
