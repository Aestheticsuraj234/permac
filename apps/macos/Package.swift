// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Permac",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "PermacCore"),
        .executableTarget(name: "Permac", dependencies: ["PermacCore"]),
        .testTarget(name: "PermacCoreTests", dependencies: ["PermacCore"]),
    ]
)
