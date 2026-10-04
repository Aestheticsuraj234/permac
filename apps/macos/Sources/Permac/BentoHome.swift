import SwiftUI

struct BentoHome: View {
    var connected: Bool
    var onSelect: (MuseSection) -> Void

    var body: some View {
        GeometryReader { geo in
            let gap: CGFloat = 12
            let inner = max(0, geo.size.height - gap * 2)
            VStack(spacing: gap) {
                HStack(spacing: gap) {
                    macCard.frame(maxWidth: .infinity)
                    agentCard.frame(width: geo.size.width * 0.28)
                    threadCard.frame(width: geo.size.width * 0.26)
                }
                .frame(height: inner * 0.30)
                HStack(spacing: gap) {
                    orbitCard.frame(width: geo.size.width * 0.24)
                    heroCard.frame(maxWidth: .infinity)
                    computerCard.frame(width: geo.size.width * 0.24)
                }
                .frame(height: inner * 0.40)
                HStack(spacing: gap) {
                    plansCard.frame(maxWidth: .infinity)
                    markCard.frame(width: geo.size.width * 0.28)
                    limitsCard.frame(maxWidth: .infinity)
                }
                .frame(height: inner * 0.30)
            }
        }
    }

    private var macCard: some View {
        SoftCard { onSelect(.activity) } content: {
            HStack(alignment: .top) {
                Text("Apps, files,\nand review.")
                    .font(.system(size: 22, weight: .semibold))
                    .tracking(-0.6)
                    .foregroundStyle(Muse.text)
                Spacer(minLength: 8)
                VStack(spacing: 8) {
                    HStack(spacing: 8) {
                        pastelIcon("macwindow", Muse.mint, museRGB(70, 140, 96))
                        pastelIcon("calendar", Muse.peach, museRGB(196, 122, 58))
                    }
                    pastelIcon("doc", Muse.lilac, museRGB(110, 96, 170))
                }
            }
        }
    }

    private var agentCard: some View {
        SoftCard { onSelect(.chat) } content: {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Spacer()
                    HStack(spacing: 0) {
                        Circle()
                            .fill(connected ? museRGB(88, 196, 122) : Muse.line)
                            .frame(width: 22, height: 22)
                            .padding(4)
                        Image(systemName: "arrow.left.arrow.right")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Muse.muted)
                            .frame(width: 28, height: 28)
                            .background(Muse.secondary, in: Circle())
                            .padding(.trailing, 4)
                    }
                    .background(Color.white, in: Capsule())
                    .overlay { Capsule().stroke(Muse.line, lineWidth: 1) }
                }
                Spacer(minLength: 8)
                Text("Your agent.")
                    .font(.system(size: 20, weight: .semibold))
                    .tracking(-0.4)
                    .foregroundStyle(Muse.text)
                Text(connected ? "Coordinator ready" : "Waiting for the coordinator")
                    .font(.subheadline)
                    .foregroundStyle(Muse.muted)
                    .padding(.top, 2)
            }
        }
    }

    private var threadCard: some View {
        SoftCard { onSelect(.chat) } content: {
            VStack(alignment: .leading, spacing: 8) {
                bubble("Open Cursor", fill: Muse.sky)
                bubble("Find the file", fill: Color.white, bordered: true)
                VStack(alignment: .leading, spacing: 3) {
                    Text("One task at a time")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Muse.text)
                    Text("The desktop lease stays with a single job.")
                        .font(.caption2)
                        .foregroundStyle(Muse.muted)
                        .lineLimit(2)
                }
                .padding(8)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .shadow(color: .black.opacity(0.04), radius: 6, y: 2)
            }
        }
    }

    private var orbitCard: some View {
        SoftCard { onSelect(.voice) } content: {
            ZStack {
                Circle()
                    .stroke(Muse.blue.opacity(0.9), lineWidth: 10)
                    .frame(width: 92, height: 92)
                    .opacity(0.55)
                Circle()
                    .stroke(Muse.line, lineWidth: 1)
                    .frame(width: 118, height: 118)
                Circle()
                    .fill(Color.white)
                    .frame(width: 36, height: 36)
                    .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
                    .overlay {
                        Image(systemName: "arrow.triangle.2.circlepath")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Muse.blueDark)
                    }
                orbitIcon("bubble.left", dx: 0, dy: -58)
                orbitIcon("checkmark", dx: 58, dy: 0)
                orbitIcon("waveform", dx: 0, dy: 58)
                orbitIcon("folder", dx: -58, dy: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var heroCard: some View {
        SoftCard { onSelect(.chat) } content: {
            VStack(alignment: .leading, spacing: 8) {
                Text("On this Mac")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Muse.blueDark)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(Muse.sky, in: Capsule())
                Spacer(minLength: 4)
                Text("Permac")
                    .font(.system(size: 42, weight: .semibold))
                    .tracking(-1.4)
                    .foregroundStyle(Muse.text)
                Text("A personal agent for this computer.\nWork that stays on the machine.")
                    .font(.subheadline)
                    .foregroundStyle(Muse.muted)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .overlay(alignment: .bottomTrailing) {
                PermacLogoView(size: 108)
                    .padding(.trailing, 4)
                    .padding(.bottom, -6)
            }
        }
    }

    private var computerCard: some View {
        SoftCard { onSelect(.activity) } content: {
            VStack(alignment: .leading, spacing: 6) {
                Spacer()
                Text("Its own\ncomputer.")
                    .font(.system(size: 22, weight: .semibold))
                    .tracking(-0.5)
                    .foregroundStyle(Muse.text)
                Text("Cursor, TextEdit, and Safari.\nFolders you have granted.")
                    .font(.subheadline)
                    .foregroundStyle(Muse.muted)
            }
        }
    }

    private var plansCard: some View {
        SoftCard { onSelect(.review) } content: {
            VStack(alignment: .leading, spacing: 4) {
                Spacer()
                Text("Plans.\nApprovals.\nReceipts.")
                    .font(.system(size: 22, weight: .semibold))
                    .tracking(-0.5)
                    .foregroundStyle(Muse.text)
            }
        }
    }

    private var markCard: some View {
        SoftCard { onSelect(.chat) } content: {
            PermacLogoView(size: 120)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var limitsCard: some View {
        SoftCard { onSelect(.limits) } content: {
            VStack(alignment: .leading, spacing: 6) {
                Spacer()
                Text("Clear limits.")
                    .font(.system(size: 22, weight: .semibold))
                    .tracking(-0.4)
                    .foregroundStyle(Muse.text)
                Text("Shell, browser, and unapproved typing stay off.")
                    .font(.subheadline)
                    .foregroundStyle(Muse.muted)
            }
        }
    }

    private func pastelIcon(_ symbol: String, _ fill: Color, _ ink: Color) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(ink)
            .frame(width: 36, height: 36)
            .background(fill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func bubble(_ text: String, fill: Color, bordered: Bool = false) -> some View {
        Text(text)
            .font(.caption.weight(.medium))
            .foregroundStyle(Muse.text)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(fill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay {
                if bordered {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(Muse.line, lineWidth: 1)
                }
            }
    }

    private func orbitIcon(_ symbol: String, dx: CGFloat, dy: CGFloat) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Muse.text)
            .frame(width: 26, height: 26)
            .background(Color.white, in: Circle())
            .shadow(color: .black.opacity(0.05), radius: 3, y: 1)
            .offset(x: dx, y: dy)
    }
}

private struct SoftCard<Content: View>: View {
    var action: () -> Void
    @ViewBuilder var content: () -> Content
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            content()
                .padding(16)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                .shadow(color: Color.black.opacity(hover ? 0.08 : 0.045), radius: hover ? 18 : 12, y: hover ? 10 : 6)
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.16), value: hover)
    }
}
