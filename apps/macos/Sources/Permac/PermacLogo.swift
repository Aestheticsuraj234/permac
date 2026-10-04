import AppKit
import SwiftUI

enum PermacLogo {
    static let image: NSImage? = {
        let bundled = Bundle.main.url(forResource: "Logo", withExtension: "png")
        let besideBinary = Bundle.main.bundleURL
            .deletingLastPathComponent()
            .appendingPathComponent("Logo.png")
        for url in [bundled, besideBinary].compactMap({ $0 }) {
            if let image = NSImage(contentsOf: url) { return image }
        }
        return nil
    }()
}

struct PermacLogoView: View {
    var size: CGFloat

    var body: some View {
        Group {
            if let image = PermacLogo.image {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
            } else {
                Image(systemName: "sparkles")
                    .font(.system(size: size * 0.45, weight: .medium))
                    .foregroundStyle(Muse.blueDark)
            }
        }
        .frame(width: size, height: size)
    }
}
