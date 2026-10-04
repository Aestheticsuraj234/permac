import AppKit
import SwiftUI

func museRGB(_ red: Double, _ green: Double, _ blue: Double) -> Color {
    Color(red: red / 255, green: green / 255, blue: blue / 255)
}

enum Muse {
    static let canvas = museRGB(241, 244, 248)
    static let mint = museRGB(226, 244, 232)
    static let peach = museRGB(253, 236, 214)
    static let lilac = museRGB(236, 232, 250)
    static let card = Color.white
    static let text = museRGB(17, 25, 28)
    static let muted = museRGB(105, 113, 118)
    static let line = museRGB(238, 238, 240)
    static let blue = museRGB(200, 231, 255)
    static let blueDark = museRGB(20, 115, 200)
    static let sky = museRGB(237, 247, 253)
    static let green = museRGB(227, 243, 232)
    static let lavender = museRGB(240, 238, 250)
    static let orange = museRGB(253, 240, 223)
    static let danger = museRGB(170, 74, 69)
    static let secondary = museRGB(241, 242, 243)
    static let wash = museRGB(240, 241, 242)
    static let hero = museRGB(232, 242, 248)
    static let placeholder = museRGB(148, 155, 159)
    static let focus = museRGB(199, 228, 249)
    static let errorWash = museRGB(251, 239, 237)

    static let canvasNS = NSColor(srgbRed: 241.0 / 255, green: 244.0 / 255, blue: 248.0 / 255, alpha: 1)

    static func status(_ value: String) -> String {
        let words = value.replacingOccurrences(of: "_", with: " ")
        guard let first = words.first else { return words }
        return first.uppercased() + words.dropFirst()
    }

    static func tint(for state: String) -> Color {
        switch state {
        case "waiting_approval", "waiting_input":
            return orange
        case "succeeded":
            return green
        case "failed", "blocked", "cancelled":
            return errorWash
        case "running":
            return sky
        default:
            return lavender
        }
    }
}

struct MuseMark: View {
    var size: CGFloat = 58

    var body: some View {
        ZStack {
            Circle()
                .fill(museRGB(218, 234, 242))
            Circle()
                .stroke(museRGB(200, 219, 230), lineWidth: 1)
                .padding(size * 0.12)
            Image(systemName: "sparkles")
                .font(.system(size: size * 0.28, weight: .medium))
                .foregroundStyle(Muse.blueDark)
        }
        .frame(width: size, height: size)
    }
}

struct MuseButton: View {
    var title: String
    var systemImage: String?
    var primary = false
    var danger = false
    var small = false
    var action: () -> Void

    var body: some View {
        Button {
            action()
        } label: {
            HStack(spacing: 8) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 13, weight: .semibold))
                }
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
            }
            .foregroundStyle(danger ? Muse.danger : Muse.text)
            .padding(.horizontal, small ? 13 : 17)
            .frame(minHeight: small ? 38 : 42)
            .background(primary ? Muse.blue : Muse.secondary, in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

struct MuseCard<Content: View>: View {
    var fill: Color = Muse.card
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(fill, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
}

struct MuseLabel: View {
    var text: String
    var color: Color = Muse.muted

    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 10, weight: .bold))
            .tracking(1.4)
            .foregroundStyle(color)
    }
}

struct GlassBackdrop: NSViewRepresentable {
    var material: NSVisualEffectView.Material = .underWindowBackground

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = material
        view.blendingMode = .behindWindow
        view.state = .followsWindowActiveState
        view.isEmphasized = true
        return view
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) {
        view.material = material
    }
}

struct GlassGroup<Content: View>: View {
    var radius: CGFloat = 16
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.white, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .shadow(color: Color.black.opacity(0.05), radius: 16, y: 8)
    }
}

struct MuseChip: View {
    var text: String
    var tint: Color = Muse.canvas

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(Muse.muted)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(tint, in: Capsule())
    }
}
