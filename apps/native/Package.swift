// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "Gozd",
  platforms: [.macOS(.v26)],
  products: [
    .executable(name: "Gozd", targets: ["Gozd"]),
  ],
  dependencies: [
    .package(name: "GozdProto", path: "../../packages/proto-swift"),
  ],
  targets: [
    .executableTarget(
      name: "Gozd",
      dependencies: [
        .product(name: "GozdProto", package: "GozdProto"),
      ]
    ),
  ]
)
