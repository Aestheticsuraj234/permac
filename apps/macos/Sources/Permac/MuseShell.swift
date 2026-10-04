import SwiftUI
import PermacCore

enum MuseSection: String, CaseIterable, Identifiable {
    case chat
    case activity
    case review
    case voice
    case limits

    var id: String { rawValue }

    var title: String {
        switch self {
        case .chat: "Chat"
        case .activity: "Activity"
        case .review: "Review"
        case .voice: "Voice"
        case .limits: "Limits"
        }
    }

    var subtitle: String {
        switch self {
        case .chat: "One instruction at a time."
        case .activity: "Plans, progress, and results."
        case .review: "One exact action, then your decision."
        case .voice: "Speak, then review the transcript."
        case .limits: "What this Mac build will not do."
        }
    }

    var symbol: String {
        switch self {
        case .chat: "bubble.left.and.bubble.right"
        case .activity: "list.bullet.rectangle"
        case .review: "checkmark.seal"
        case .voice: "waveform"
        case .limits: "info.circle"
        }
    }

    var tint: Color {
        switch self {
        case .chat: Muse.sky
        case .activity: Muse.mint
        case .review: Muse.peach
        case .voice: Muse.lilac
        case .limits: Muse.lavender
        }
    }
}

struct ContentView: View {
    @Bindable var model: AppModel
    @State private var section: MuseSection = .chat
    @State private var instruction = ""
    @State private var answer = ""
    @State private var filter = "All"
    @State private var hovered: MuseSection?
    @FocusState private var composerFocused: Bool

    private var draftIsEmpty: Bool {
        instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            detail
        }
        .background(Muse.canvas.ignoresSafeArea())
        .preferredColorScheme(.light)
        .task { model.connect() }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                PermacLogoView(size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Permac")
                        .font(.system(size: 15, weight: .semibold))
                    Text(model.presence)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .padding(.bottom, 14)

            ForEach(MuseSection.allCases) { item in
                sidebarRow(item)
            }

            Spacer(minLength: 12)

            connection
                .padding(.horizontal, 10)
                .padding(.bottom, 12)
        }
        .padding(.horizontal, 8)
        .frame(width: 216)
        .frame(maxHeight: .infinity)
        .background(Muse.canvas.ignoresSafeArea())
    }

    private func sidebarRow(_ item: MuseSection) -> some View {
        let selected = section == item
        return Button {
            section = item
        } label: {
            HStack(spacing: 8) {
                Image(systemName: item.symbol)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Muse.text)
                    .frame(width: 26, height: 26)
                    .background(item.tint, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                Text(item.title)
                    .font(.system(size: 13, weight: selected ? .semibold : .regular))
                Spacer(minLength: 4)
                if item == .review && model.reviewCount > 0 {
                    Text("\(model.reviewCount)")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Muse.blueDark, in: Capsule())
                }
            }
            .foregroundStyle(selected ? Color.primary : Color.primary.opacity(0.82))
            .padding(.horizontal, 8)
            .frame(height: 36)
            .background {
                if selected || hovered == item {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color.white)
                        .shadow(color: .black.opacity(selected ? 0.06 : 0.03), radius: 8, y: 3)
                }
            }
        }
        .buttonStyle(.plain)
        .onHover { inside in
            hovered = inside ? item : (hovered == item ? nil : hovered)
        }
    }

    private var connection: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(model.status.hasPrefix("Connected") ? Color(red: 0.22, green: 0.62, blue: 0.36) : Color.secondary.opacity(0.45))
                .frame(width: 7, height: 7)
            Text(model.status.hasPrefix("Connected") ? "Coordinator ready" : "Coordinator offline")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .help(model.status)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .shadow(color: .black.opacity(0.04), radius: 8, y: 3)
    }

    private var detail: some View {
        VStack(spacing: 0) {
            if !(section == .chat && model.tasks.isEmpty) {
                header
            }
            if model.schemaError {
                errorNotice("This event schema is not supported.")
                    .padding(.horizontal, 24)
                    .padding(.bottom, 8)
            }
            Group {
                switch section {
                case .chat:
                    chat
                case .activity, .review, .voice, .limits:
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            sectionBody
                        }
                        .padding(.horizontal, 24)
                        .padding(.bottom, 24)
                        .frame(maxWidth: 760, alignment: .leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            if section == .chat {
                composer
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 3) {
                Text(section.title)
                    .font(.system(size: 22, weight: .semibold))
                Text(section.subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 16)
            if section == .activity {
                Picker("Filter", selection: $filter) {
                    Text("All").tag("All")
                    Text("In progress").tag("In progress")
                    Text("Finished").tag("Finished")
                }
                .pickerStyle(.segmented)
                .frame(width: 280)
                .labelsHidden()
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 6)
        .padding(.bottom, 14)
    }

    @ViewBuilder
    private var sectionBody: some View {
        switch section {
        case .chat:
            EmptyView()
        case .activity:
            activity
        case .review:
            review
        case .voice:
            voice
        case .limits:
            limits
        }
    }

    private var chat: some View {
        Group {
            if model.tasks.isEmpty {
                BentoHome(connected: model.status.hasPrefix("Connected")) { section = $0 }
                    .padding(16)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(model.tasks.reversed()) { task in
                            threadItem(task)
                        }
                    }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 8)
                    .frame(maxWidth: 760, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .defaultScrollAnchor(.bottom)
            }
        }
    }

    private func threadItem(_ task: TaskRow) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Spacer(minLength: 80)
                Text(task.instruction)
                    .font(.body)
                    .multilineTextAlignment(.leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.45), lineWidth: 0.6)
                    }
            }
            HStack(spacing: 8) {
                MuseChip(text: Muse.status(task.state), tint: Muse.tint(for: task.state))
                if task.state == "waiting_approval" {
                    Text("Review requested")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Muse.blueDark)
                }
            }
            if !task.text.isEmpty {
                Text(task.text)
                    .font(.body)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if task.state == "succeeded" {
                Text("Verified outcome recorded.")
                    .font(.body)
            }
            if task.state == "waiting_approval" {
                reviewCard(task)
            } else if task.state == "waiting_input" {
                clarifyCard(task)
            } else if task.state == "blocked" || task.state == "failed" {
                Text(task.text.isEmpty ? "The coordinator stopped this task." : task.text)
                    .font(.callout)
                    .foregroundStyle(Muse.danger)
            }
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message", text: $instruction, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.body)
                .lineLimit(1...5)
                .focused($composerFocused)
                .onSubmit(send)
            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(draftIsEmpty ? Color.secondary : Color.white)
                    .frame(width: 28, height: 28)
                    .background(draftIsEmpty ? Color.primary.opacity(0.08) : Muse.blueDark, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(draftIsEmpty)
            .keyboardShortcut(.return, modifiers: .command)
            .help("Send")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(composerFocused ? Muse.blueDark.opacity(0.35) : Color.white, lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.06), radius: 16, y: 6)
        .padding(.horizontal, 24)
        .padding(.bottom, 16)
        .padding(.top, 8)
    }

    private var activity: some View {
        let rows = filteredTasks
        return VStack(alignment: .leading, spacing: 12) {
            if rows.isEmpty {
                emptyLine("No tasks in this view.", "Send an instruction from Chat.")
            } else {
                ForEach(rows) { task in
                    taskCard(task)
                }
            }
        }
    }

    private var filteredTasks: [TaskRow] {
        model.tasks.filter { task in
            switch filter {
            case "In progress":
                return !["succeeded", "failed", "cancelled"].contains(task.state)
            case "Finished":
                return ["succeeded", "failed", "cancelled"].contains(task.state)
            default:
                return true
            }
        }
    }

    private func taskCard(_ task: TaskRow) -> some View {
        let waiting = task.state == "waiting_approval" || task.state == "waiting_input"
        return Button {
            model.selectedID = task.id
            section = waiting ? .review : .chat
        } label: {
            GlassGroup {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 10) {
                        Image(systemName: "checklist")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Muse.blueDark)
                            .frame(width: 28, height: 28)
                            .background((waiting ? Muse.orange : Muse.sky).opacity(0.9), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(task.instruction)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(.primary)
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                            Text(Muse.status(task.state))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    progress(task.state)
                    if waiting {
                        Text(task.state == "waiting_approval" ? "Review requested" : "Your input is needed")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Muse.blueDark)
                    } else if !task.text.isEmpty {
                        Text(task.text)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                            .multilineTextAlignment(.leading)
                    }
                }
            }
        }
        .buttonStyle(.plain)
    }

    private func progress(_ state: String) -> some View {
        let amount: CGFloat = switch state {
        case "succeeded": 1
        case "running": 0.58
        case "waiting_approval", "waiting_input": 0.4
        case "queued": 0.16
        default: 0.08
        }
        return GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.08))
                Capsule()
                    .fill(state == "failed" || state == "blocked" || state == "cancelled" ? Muse.danger.opacity(0.75) : Muse.blueDark.opacity(0.75))
                    .frame(width: max(6, proxy.size.width * amount))
            }
        }
        .frame(height: 3)
    }

    private var review: some View {
        let waiting = model.tasks.filter { $0.state == "waiting_approval" || $0.state == "waiting_input" }
        return VStack(alignment: .leading, spacing: 12) {
            if waiting.isEmpty {
                emptyLine("Nothing is waiting.", "Risky actions stop here before they run.")
            } else {
                ForEach(waiting) { task in
                    if task.state == "waiting_approval" {
                        reviewCard(task)
                    } else {
                        clarifyCard(task)
                    }
                }
            }
        }
    }

    private func reviewCard(_ task: TaskRow) -> some View {
        GlassGroup {
            VStack(alignment: .leading, spacing: 10) {
                Text("Review")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(task.instruction)
                    .font(.body.weight(.semibold))
                Text("The exact payload is shown here and cannot be edited into a different action.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    MuseButton(title: "Approve", primary: true, small: true) {
                        model.selectedID = task.id
                        model.approve(hash: task.id)
                    }
                    MuseButton(title: "Reject", danger: true, small: true) {
                        model.selectedID = task.id
                        model.note("Rejection recorded. The action was not sent.")
                    }
                }
            }
        }
    }

    private func clarifyCard(_ task: TaskRow) -> some View {
        GlassGroup {
            VStack(alignment: .leading, spacing: 10) {
                Text("Clarification")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(task.instruction)
                    .font(.body.weight(.semibold))
                Text("Answer the outstanding question. One answer is sent for the request.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                TextField("Your answer", text: $answer)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 10)
                    .frame(minHeight: 32)
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.6)
                    }
                MuseButton(title: "Send answer", primary: true, small: true) {
                    let trimmed = answer.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !trimmed.isEmpty else { return }
                    model.selectedID = task.id
                    model.note("Answer queued locally until the coordinator accepts it.")
                    answer = ""
                }
            }
        }
    }

    private var voice: some View {
        VStack(alignment: .leading, spacing: 12) {
            GlassGroup {
                VStack(alignment: .leading, spacing: 10) {
                    Text(model.listening ? "Listening" : "Push to talk")
                        .font(.headline)
                    Text(model.wakeWordAvailable ? "Wake word is available." : "Wake word is off. Use text or push to talk.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    MuseButton(title: model.listening ? "Listening" : "Push to talk", systemImage: "mic", primary: model.listening) {
                        model.listening.toggle()
                    }
                }
            }
            GlassGroup {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Transcript")
                        .font(.headline)
                    TextField("What you said", text: $model.transcript, axis: .vertical)
                        .textFieldStyle(.plain)
                        .lineLimit(2...6)
                    Toggle("Transcript reviewed", isOn: $model.transcriptReviewed)
                        .font(.callout)
                        .tint(Muse.blueDark)
                    Text("Review the transcript before a consequential action.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    MuseButton(title: "Send reviewed transcript", primary: true, small: true) {
                        model.submit(instruction: model.transcript, consequential: true)
                    }
                }
            }
            HStack(spacing: 8) {
                MuseButton(title: "Stop playback", small: true) { model.stop(.playback) }
                MuseButton(title: "Stop run", small: true) { model.stop(.run) }
                MuseButton(title: "Stop listening", small: true) { model.stop(.listening) }
            }
        }
    }

    private var limits: some View {
        GlassGroup {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(knownLimitations.enumerated()), id: \.offset) { index, item in
                    if index > 0 {
                        Divider().padding(.vertical, 12)
                    }
                    Text(item)
                        .font(.callout)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func emptyLine(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.body.weight(.semibold))
            Text(detail)
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(.top, 8)
    }

    private func errorNotice(_ message: String) -> some View {
        Text(message)
            .font(.callout)
            .foregroundStyle(Muse.danger)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Muse.errorWash.opacity(0.85), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func send() {
        model.submit(instruction: instruction, consequential: false)
        if !draftIsEmpty {
            instruction = ""
        }
    }
}
