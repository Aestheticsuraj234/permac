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
                .frame(minWidth: 760, minHeight: 520)
        }
        MenuBarExtra("Permac", systemImage: "sparkles") {
            Button("Open") { PermacDelegate.presentMainWindow() }
            Divider()
            Text(model.listening ? "Listening" : "Idle")
            Button("Stop") { model.stop(.run) }
            Divider()
            Button("Quit") { NSApp.terminate(nil) }
        }
    }
}

@MainActor
final class PermacDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        DispatchQueue.main.async {
            Self.presentMainWindow()
        }
    }

    static func presentMainWindow() {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        let visible = NSApp.windows.filter { $0.canBecomeKey && $0.isVisible }
        if let window = visible.first {
            window.makeKeyAndOrderFront(nil)
            return
        }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 520),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Permac"
        window.contentView = NSHostingView(rootView: ContentView(model: AppModel.shared))
        window.center()
        window.makeKeyAndOrderFront(nil)
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

    var selected: TaskRow? { tasks.first { $0.id == selectedID } }

    func submit(instruction: String, consequential: Bool) {
        let trimmed = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if consequential && !transcriptReviewed {
            status = "Review the transcript before a consequential action."
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
            TaskRow(id: id, instruction: tasks.first { $0.id == id }?.instruction ?? "Task", state: task.state, text: task.text)
        }
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
            }
            status = "Stop reached the execution coordinator."
        case .listening:
            speaking = false
            listening = false
        }
    }
}

struct TaskRow: Identifiable, Equatable {
    let id: String
    var instruction: String
    var state: String
    var text: String
}

struct ContentView: View {
    @Bindable var model: AppModel
    @State private var instruction = ""

    var body: some View {
        NavigationSplitView {
            List(model.tasks, selection: $model.selectedID) { task in
                VStack(alignment: .leading) {
                    Text(task.instruction).lineLimit(2)
                    Text(task.state).font(.caption).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Tasks")
        } detail: {
            VStack(alignment: .leading, spacing: 16) {
                composer
                if model.schemaError {
                    Text("This event schema is not supported.")
                        .foregroundStyle(.red)
                }
                if let task = model.selected {
                    TaskDetail(task: task)
                } else {
                    Text("Submit an instruction to start a task.")
                        .foregroundStyle(.secondary)
                }
                limitations
            }
            .padding(20)
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Instruction", text: $instruction)
                .textFieldStyle(.roundedBorder)
            HStack {
                Button("Submit") {
                    model.submit(instruction: instruction, consequential: false)
                    instruction = ""
                }
                Button(model.listening ? "Listening" : "Push to talk") { model.listening.toggle() }
                Button("Stop playback") { model.stop(.playback) }
                Button("Stop run") { model.stop(.run) }
                Button("Stop listening") { model.stop(.listening) }
            }
            TextField("Transcript", text: $model.transcript)
                .textFieldStyle(.roundedBorder)
            Toggle("Transcript reviewed", isOn: $model.transcriptReviewed)
            Text(model.wakeWordAvailable ? "Wake word on" : "Wake word unavailable. Use text or push-to-talk.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(model.status).font(.caption)
        }
    }

    private var limitations: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Known limitations").font(.headline)
            ForEach(knownLimitations, id: \.self) { item in
                Text("• \(item)").font(.caption)
            }
        }
    }
}

struct TaskDetail: View {
    let task: TaskRow

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(task.instruction).font(.title3)
            Text(task.state).font(.headline)
            if task.state == "succeeded" {
                Text("Result").font(.headline)
                Text(task.text.isEmpty ? "Verified outcome recorded." : task.text)
            } else if task.state == "waiting_approval" {
                ReviewCard(message: "The exact payload is shown here and cannot be edited into a different action.")
            } else if task.state == "waiting_input" {
                Text("Clarification").font(.headline)
                Text("Answer the outstanding question. One answer is sent for the request id.")
            } else if task.state == "blocked" || task.state == "failed" {
                Text("Blocked").font(.headline)
                Text(task.text.isEmpty ? "The coordinator stopped this task." : task.text)
            } else {
                Text(task.text).textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct ReviewCard: View {
    let message: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Review").font(.headline)
            Text(message)
            HStack {
                Button("Approve") {}
                Button("Reject") {}
            }
        }
        .padding(12)
        .background(.quaternary.opacity(0.4))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}
