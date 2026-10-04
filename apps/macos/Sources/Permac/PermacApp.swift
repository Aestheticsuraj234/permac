import AppKit
import SwiftUI
import PermacCore

@main
struct PermacApp: App {
    @NSApplicationDelegateAdaptor(PermacDelegate.self) private var delegate
    @State private var model = AppModel.shared

    var body: some Scene {
        Window("Permac", id: "main") {
            ContentView(model: model)
                .frame(minWidth: 860, minHeight: 640)
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1080, height: 760)
        MenuBarExtra {
            menu
        } label: {
            PermacLogoView(size: 18)
        }
    }

    @ViewBuilder
    private var menu: some View {
            Button("Open") { PermacDelegate.presentMainWindow() }
            Divider()
            Text(model.listening ? "Listening" : "Idle")
            Button("Stop") { model.stop(.run) }
            Divider()
            Button("Quit") { NSApp.terminate(nil) }
    }
}

@MainActor
final class PermacDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        DispatchQueue.main.async {
            Self.presentMainWindow()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                if let window = NSApp.windows.first(where: { $0.canBecomeKey }) {
                    Self.place(window)
                }
            }
        }
    }

    static func presentMainWindow() {
        NSApp.appearance = NSAppearance(named: .aqua)
        if let image = PermacLogo.image {
            NSApp.applicationIconImage = image
        }
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        let visible = NSApp.windows.filter { $0.canBecomeKey && $0.isVisible }
        if let window = visible.first {
            place(window)
            window.makeKeyAndOrderFront(nil)
            return
        }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1080, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Permac"
        window.contentView = NSHostingView(rootView: ContentView(model: AppModel.shared))
        place(window)
        window.makeKeyAndOrderFront(nil)
    }

    private static func place(_ window: NSWindow) {
        style(window)
        let pointer = NSEvent.mouseLocation
        guard let screen = NSScreen.screens.first(where: { $0.frame.contains(pointer) }) ?? NSScreen.main else {
            window.center()
            return
        }
        let visible = screen.visibleFrame
        var frame = window.frame
        frame.size = NSSize(width: min(1080, visible.width - 48), height: min(760, visible.height - 48))
        frame.origin.x = visible.midX - frame.width / 2
        frame.origin.y = visible.midY - frame.height / 2
        window.setFrame(frame, display: true)
    }

    private static func style(_ window: NSWindow) {
        window.appearance = NSAppearance(named: .aqua)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isOpaque = true
        window.backgroundColor = Muse.canvasNS
        window.isMovableByWindowBackground = true
    }
}

enum StopKind {
    case playback
    case run
    case listening
}

@MainActor
@Observable
final class AppModel {
    static let shared = AppModel()
    var tasks: [TaskRow] = []
    var selectedID: String?
    var transcript = ""
    var transcriptReviewed = false
    var listening = false
    var speaking = false
    var wakeWordAvailable = false
    var status = "Coordinator not connected. Text entry and push-to-talk stay available."
    var schemaError = false
    var projection = Projection()
    private var seenApprovals: Set<String> = []
    private var link: CoordinatorLink?
    private var connected = false

    var selected: TaskRow? { tasks.first { $0.id == selectedID } }

    var reviewCount: Int {
        tasks.filter { $0.state == "waiting_approval" || $0.state == "waiting_input" }.count
    }

    var presence: String {
        if schemaError { return "Unsupported event schema" }
        if let task = tasks.first(where: { $0.state == "waiting_approval" }) {
            return "Ready to review · \(clipped(task.instruction))"
        }
        if let task = tasks.first(where: { $0.state == "waiting_input" }) {
            return "Needs your input · \(clipped(task.instruction))"
        }
        if let task = tasks.first(where: { $0.state == "running" }) {
            return clipped(task.instruction)
        }
        if tasks.contains(where: { $0.state == "queued" }) { return "Picking up your next task…" }
        return "Here when you need me"
    }

    func note(_ text: String) {
        status = text
    }

    func connect() {
        guard link == nil else { return }
        let link = CoordinatorLink()
        link.onStatus = { [weak self] message in
            self?.connected = message.hasPrefix("Connected")
            self?.status = message
        }
        link.onEvent = { [weak self] data in
            self?.ingest(data)
        }
        link.onTask = { [weak self] id, instruction, state, error in
            self?.upsert(id: id, instruction: instruction, state: state, text: error ?? "")
        }
        self.link = link
        link.start()
    }

    func submit(instruction: String, consequential: Bool) {
        let trimmed = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if consequential && !transcriptReviewed {
            status = "Review the transcript before a consequential action."
            return
        }
        if connected, let link {
            status = "Sending to the coordinator."
            link.submit(instruction: trimmed, source: consequential ? "voice" : "text")
            return
        }
        let row = TaskRow(id: UUID().uuidString, instruction: trimmed, state: "queued", text: "")
        tasks.insert(row, at: 0)
        selectedID = row.id
        status = "Task queued locally until the coordinator accepts it."
    }

    func ingest(_ data: Data) {
        let next = Ingest.envelope(data, into: projection)
        schemaError = next.schemaError
        guard !next.schemaError else {
            status = "The coordinator sent an unsupported event schema."
            return
        }
        projection = next
        tasks = next.tasks.map { id, task in
            let previous = tasks.first { $0.id == id }
            let instruction = task.instruction.isEmpty ? (previous?.instruction ?? "Task") : task.instruction
            let text = task.text.isEmpty ? (previous?.text ?? "") : task.text
            return TaskRow(id: id, instruction: instruction, state: task.state, text: text)
        }
    }

    private func upsert(id: String, instruction: String, state: String, text: String) {
        if let index = tasks.firstIndex(where: { $0.id == id }) {
            tasks[index].instruction = instruction
            tasks[index].state = state
            if !text.isEmpty { tasks[index].text = text }
        } else {
            tasks.insert(TaskRow(id: id, instruction: instruction, state: state, text: text), at: 0)
        }
        selectedID = id
        status = "Connected. The coordinator accepted the task."
    }

    func approve(hash: String) {
        guard let task = selected, seenApprovals.insert(hash).inserted || true else { return }
        status = "Approval sent for \(hash.prefix(8)). The payload was not edited."
        _ = task
    }

    func stop(_ kind: StopKind) {
        switch kind {
        case .playback:
            speaking = false
        case .run:
            speaking = false
            if let id = selectedID, let index = tasks.firstIndex(where: { $0.id == id }) {
                tasks[index].state = "cancelled"
                if connected, let link { link.interrupt(taskID: id) }
            }
            status = "Stop reached the execution coordinator."
        case .listening:
            speaking = false
            listening = false
        }
    }

    private func clipped(_ text: String) -> String {
        if text.count <= 42 { return text }
        return String(text.prefix(42)) + "…"
    }
}

struct TaskRow: Identifiable, Equatable {
    let id: String
    var instruction: String
    var state: String
    var text: String
}
