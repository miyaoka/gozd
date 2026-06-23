// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "GozdProto",
  platforms: [.macOS(.v26)],
  products: [
    .library(name: "GozdProto", targets: ["GozdProto"]),
  ],
  dependencies: [
    .package(url: "https://github.com/apple/swift-protobuf.git", from: "1.38.1"),
  ],
  targets: [
    .target(
      name: "GozdProto",
      dependencies: [
        .product(name: "SwiftProtobuf", package: "swift-protobuf"),
      ]
    ),
  ]
)
